"""RSS / Atom feed parser. Both branches share `_build_item`."""

import re
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
import datetime as dt

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

    return feed_image, items[:limit] if limit else items


def fetch_rss(url: str, limit: int = 4) -> tuple[str, list[dict]]:
    raw = fetch_cached(url, ttl_seconds=900)
    return parse_rss(raw, limit=limit)


def _parse_published_date(published: str) -> dt.datetime:
    """Best-effort parse of RSS/Atom date strings for sorting.

    Always returns a naive UTC datetime so all values are comparable.
    Returns datetime.min for unparseable values so items without dates sort last.
    """
    if not published:
        return dt.datetime.min
    # RFC 2822 (RSS 2.0 pubDate)
    try:
        d = parsedate_to_datetime(published)
        # Normalize to naive UTC
        if d.tzinfo is not None:
            d = d.astimezone(dt.timezone.utc).replace(tzinfo=None)
        return d
    except Exception:
        pass
    # ISO 8601 / Atom (e.g. 2026-05-01T13:00:00Z)
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S"):
        try:
            d = dt.datetime.strptime(published, fmt)
            if d.tzinfo is not None:
                d = d.astimezone(dt.timezone.utc).replace(tzinfo=None)
            return d
        except ValueError:
            continue
    return dt.datetime.min


def fetch_rss_aggregated(
    feeds: list[dict],
    items_per_feed: int = 4,
    max_items: int | None = None,
    now: dt.datetime | None = None,
) -> list[dict]:
    """Fetch all *feeds*, select items by global recency, grouped by feed.

    Algorithm:
    1. Fetch all available articles from every feed.
    2. Sort all articles globally by published date (newest first).
    3. Walk the sorted list, selecting each article only if fewer than
       *items_per_feed* articles from that feed have already been selected.
       Stop once *max_items* articles have been selected.
    4. Group selected articles by feed for presentation: feed groups are
       ordered by their most recent selected article, articles within each
       group are sorted newest-first.

    *max_items* defaults to ``len(feeds) * items_per_feed`` so every configured
    feed can contribute its full share. A fixed cap below that total lets
    high-frequency feeds crowd low-frequency ones (e.g. a weekly blog) off the
    board entirely, since selection is purely by global recency.

    Each feed entry is ``{"name": ..., "url": ...}``.
    Returns a flat list of item dicts, each augmented with ``feedName``,
    ``feedImage``, and ``ageHours`` (hours since publication, ``None`` when
    the published date is missing/unparseable) so the frontend can display
    per-item source info and an age-tinted background. *now* is injectable
    for tests and defaults to the current time (naive UTC, matching
    ``_parse_published_date``).
    """
    if max_items is None:
        max_items = len(feeds) * items_per_feed
    if now is None:
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    # 1. Fetch all available articles from every feed.
    all_articles: list[dict] = []
    for feed_cfg in feeds:
        try:
            feed_image, items = fetch_rss(feed_cfg["url"], limit=0)
        except Exception:
            continue
        name = feed_cfg.get("name", feed_cfg["url"])
        for item in items:
            d = _parse_published_date(item.get("published", ""))
            age_hours = (
                None
                if d == dt.datetime.min
                else max(0.0, round((now - d).total_seconds() / 3600, 1))
            )
            augmented = {
                **item,
                "feedName": name,
                "feedImage": feed_image,
                "ageHours": age_hours,
            }
            all_articles.append(augmented)

    # 2. Sort globally by published date, newest first.
    all_articles.sort(
        key=lambda i: _parse_published_date(i.get("published", "")), reverse=True
    )

    # 3. Walk sorted list, picking at most items_per_feed per feed, max_items total.
    selected: list[dict] = []
    feed_counts: dict[str, int] = {}
    for article in all_articles:
        feed_name = article["feedName"]
        if feed_counts.get(feed_name, 0) >= items_per_feed:
            continue
        selected.append(article)
        feed_counts[feed_name] = feed_counts.get(feed_name, 0) + 1
        if len(selected) >= max_items:
            break

    # 4. Group by feed for presentation.
    groups: dict[str, list[dict]] = {}
    for article in selected:
        feed_name = article["feedName"]
        if feed_name not in groups:
            groups[feed_name] = []
        groups[feed_name].append(article)

    # Flatten: feed groups ordered by their most recent article (already in
    # insertion order since we walked the globally-sorted list).
    result: list[dict] = []
    for group in groups.values():
        result.extend(group)
    return result


# Some upstreams (e.g. CBC's legacy rss.cbc.ca lineup feeds) keep returning
# HTTP 200 with a frozen snapshot long after they stop being updated, which no
# fetch-failure fallback can detect. Rather than a single dead/alive cutoff,
# staleness escalates in three tiers as a feed's newest article keeps aging:
STALE_AGED_DAYS = 14  # items get a subtle "this might be old" treatment
STALE_WARN_DAYS = 20  # a glaring warning entry is prepended to the feed's items
STALE_HIDE_DAYS = 30  # the feed is skipped from rendering entirely


def mark_stale_feeds(
    items: list[dict],
    now: dt.datetime | None = None,
    aged_days: int = STALE_AGED_DAYS,
    warn_days: int = STALE_WARN_DAYS,
    hide_days: int = STALE_HIDE_DAYS,
) -> list[dict]:
    """Flag or hide feeds whose newest article has gone stale, by tier.

    *items* is the flat, feed-grouped list produced by
    ``fetch_rss_aggregated``. For each feed, staleness is judged by its newest
    parseable article's age:

    - < *aged_days*: untouched.
    - >= *aged_days*: every item from that feed is marked ``{"aged": True}``
      so the frontend can apply a subtle "this might be old" style, without
      hiding anything.
    - >= *warn_days*: a synthetic warning item (``{"stale": True, ...}``) is
      inserted first in that feed's group, taking the place of that group's
      oldest story (dropped) so the feed's total item count — and therefore
      pagination — is unaffected. Remaining items are marked aged.
    - >= *hide_days*: the feed's items are dropped from the result entirely.
      This only affects rendering; ``fetch_rss_aggregated`` still fetches and
      parses the feed every call, so a new post immediately un-hides it.

    A feed's newest *selected* article is its newest article overall (selection
    is purely by recency), so operating on the aggregated result is sufficient
    and keeps this concern out of ``fetch_rss_aggregated``.

    A feed with no parseable dates at all is left untouched — we can't tell
    whether it's stale or merely dateless. *now* is injectable for tests and
    defaults to the current time (naive UTC, matching ``_parse_published_date``).
    """
    if now is None:
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)

    # Newest parseable date per feed.
    newest: dict[str, dt.datetime | None] = {}
    for it in items:
        name = it["feedName"]
        prev = newest.setdefault(name, None)
        d = _parse_published_date(it.get("published", ""))
        if d != dt.datetime.min and (prev is None or d > prev):
            newest[name] = d

    # Items are contiguous per feed (fetch_rss_aggregated groups them), so
    # collapsing into runs lets each feed's tier decision see its full item
    # count — needed to drop one story when a warning is inserted.
    groups: list[tuple[str, list[dict]]] = []
    for it in items:
        name = it["feedName"]
        if groups and groups[-1][0] == name:
            groups[-1][1].append(it)
        else:
            groups.append((name, [it]))

    result: list[dict] = []
    for name, group_items in groups:
        feed_newest = newest[name]
        if feed_newest is None:
            result.extend(group_items)
            continue

        age = (now - feed_newest).days
        if age >= hide_days:
            continue
        if age >= warn_days:
            result.append(
                {
                    "title": f"WARNING: no new stories in {age} days — feed still active?",
                    "link": "",
                    "published": "",
                    "image": "",
                    "feedName": name,
                    "feedImage": group_items[0].get("feedImage", ""),
                    "stale": True,
                    "staleDays": age,
                }
            )
            # Oldest story (last, since groups sort newest-first) yields its
            # slot to the warning above.
            result.extend({**it, "aged": True} for it in group_items[:-1])
        elif age >= aged_days:
            result.extend({**it, "aged": True} for it in group_items)
        else:
            result.extend(group_items)
    return result
