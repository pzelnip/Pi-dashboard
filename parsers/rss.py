"""RSS / Atom feed parser. Both branches share `_build_item`."""

import re
import xml.etree.ElementTree as ET

from cache import fetch_cached

ATOM_NS = "{http://www.w3.org/2005/Atom}"
MEDIA_NS = "{http://search.yahoo.com/mrss/}"

_IMG_SRC_RE = re.compile(r"""<img\b[^>]*\bsrc=["']([^"']+)["']""", re.IGNORECASE)


def _extract_image(el, html_fields: list[str]) -> str:
    # 1. Yahoo media namespace: <media:thumbnail url="..."> or <media:content url="...">
    for tag in ("thumbnail", "content"):
        m = el.find(f"{MEDIA_NS}{tag}")
        if m is not None:
            url = m.get("url") or m.get("href")
            if url:
                return url

    # 2. <enclosure url="..." type="image/..."> (RSS 2.0)
    enc = el.find("enclosure")
    if enc is not None and (enc.get("type") or "").startswith("image/"):
        url = enc.get("url")
        if url:
            return url

    # 3. First <img> inside an HTML-bearing field like description/summary/content.
    for field in html_fields:
        html = el.findtext(field)
        if html:
            match = _IMG_SRC_RE.search(html)
            if match:
                return match.group(1)

    return ""


def _extract_feed_image(root) -> str:
    # RSS 2.0: <rss><channel><image><url>...</url></image>
    ch = root.find("channel")
    if ch is not None:
        img = ch.find("image")
        if img is not None:
            url = (img.findtext("url") or "").strip()
            if url:
                return url
        # Also try <itunes:image href="..."> and channel-level <media:thumbnail>
        for tag in (f"{MEDIA_NS}thumbnail", f"{MEDIA_NS}image"):
            m = ch.find(tag)
            if m is not None:
                url = m.get("url") or m.get("href") or ""
                if url:
                    return url

    # Atom: <feed><logo> (preferred) or <icon>
    for tag in ("logo", "icon"):
        el = root.find(f"{ATOM_NS}{tag}")
        if el is not None and el.text:
            return el.text.strip()

    return ""


def _build_item(el, title_field, link_fn, published_fields, html_fields) -> dict | None:
    title = (el.findtext(title_field) or "").strip()
    if not title:
        return None
    link = link_fn(el)
    published = ""
    for f in published_fields:
        if val := el.findtext(f):
            published = val.strip()
            break
    return {
        "title": title,
        "link": link,
        "published": published,
        "image": _extract_image(el, html_fields),
    }


def parse_rss(xml_bytes: bytes, limit: int = 4) -> tuple[str, list[dict]]:
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        raise ValueError("upstream returned non-XML response (got HTML?)")
    feed_image = _extract_feed_image(root)

    # RSS 2.0: <rss><channel><item>
    items = [
        item
        for el in root.findall(".//item")
        if (
            item := _build_item(
                el,
                title_field="title",
                link_fn=lambda e: (e.findtext("link") or "").strip(),
                published_fields=["pubDate"],
                html_fields=["description", "content:encoded"],
            )
        )
    ]

    # Atom: <feed><entry>
    if not items:

        def atom_link(e):
            link_el = e.find(f"{ATOM_NS}link")
            return link_el.get("href", "") if link_el is not None else ""

        items = [
            item
            for el in root.findall(f"{ATOM_NS}entry")
            if (
                item := _build_item(
                    el,
                    title_field=f"{ATOM_NS}title",
                    link_fn=atom_link,
                    published_fields=[f"{ATOM_NS}published", f"{ATOM_NS}updated"],
                    html_fields=[f"{ATOM_NS}summary", f"{ATOM_NS}content"],
                )
            )
        ]

    return feed_image, items[:limit]


def fetch_rss(url: str) -> tuple[str, list[dict]]:
    raw = fetch_cached(url, ttl_seconds=900)
    return parse_rss(raw)
