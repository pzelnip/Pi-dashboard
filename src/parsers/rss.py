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
    hide_days: int | None = None,
) -> list[dict]:
    """Fetch all *feeds* and select the *max_items* most recent articles.

    Algorithm:
    1. Fetch all available articles from every feed.
    2. Sort all articles globally by published date (newest first), and drop
       every article from feeds whose newest article is at least *hide_days*
       old (defaults to ``STALE_HIDE_DAYS``) — those feeds would be hidden by
       ``mark_stale_feeds`` anyway, so they give up their slots to live feeds.
       Feeds with no parseable dates are kept.
    3. Every remaining feed's newest article is guaranteed a slot, so low-frequency
       feeds (e.g. a weekly blog) are never crowded off the board, and
       ``mark_stale_feeds`` always sees each feed's newest article.
    4. The remaining slots go to the newest of the other articles,
       regardless of feed — a busy feed can take more than its share.
    5. Group the selected articles by feed for display: groups are ordered
       by their newest selected article, and each group is newest-first.

    *max_items* defaults to ``len(feeds) * items_per_feed``. If
    an explicit *max_items* is below the feed count, the guarantee wins.

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
    if hide_days is None:
        hide_days = STALE_HIDE_DAYS
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

    # Each feed's first article in the sorted list is its newest; judge
    # hidden-tier staleness from it and drop the whole feed if so.
    hidden_feeds: set[str] = set()
    seen_feeds: set[str] = set()
    for article in all_articles:
        name = article["feedName"]
        if name in seen_feeds:
            continue
        seen_feeds.add(name)
        d = _parse_published_date(article.get("published", ""))
        if d != dt.datetime.min and (now - d).days >= hide_days:
            hidden_feeds.add(name)
    all_articles = [a for a in all_articles if a["feedName"] not in hidden_feeds]

    # 3. Each feed's newest article (its first in the sorted list) is guaranteed.
    seen_feeds = set()
    guaranteed: set[int] = set()
    for idx, article in enumerate(all_articles):
        if article["feedName"] not in seen_feeds:
            seen_feeds.add(article["feedName"])
            guaranteed.add(idx)

    # 4. Fill the remaining slots by global recency, preserving sorted order.
    budget = max_items - len(guaranteed)
    selected: list[dict] = []
    for idx, article in enumerate(all_articles):
        if idx in guaranteed:
            selected.append(article)
        elif budget > 0:
            selected.append(article)
            budget -= 1

    # 5. Group by feed for display. dicts keep insertion order, and we walk
    # the newest-first list, so groups are ordered by their newest article
    # and each group is newest-first.
    groups: dict[str, list[dict]] = {}
    for article in selected:
        groups.setdefault(article["feedName"], []).append(article)
    return [article for group in groups.values() for article in group]


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

    *items* is the feed-grouped list produced by ``fetch_rss_aggregated``
    (interleaved input works too). For each feed, staleness
    is judged by its newest parseable article's age:

    - < *aged_days*: untouched.
    - >= *aged_days*: every item from that feed is marked ``{"aged": True}``
      so the frontend can apply a subtle "this might be old" style, without
      hiding anything.
    - >= *warn_days*: a synthetic warning item (``{"stale": True, ...}``) is
      inserted at the position of that feed's first item, taking the place
      of the feed's oldest selected story (dropped) so the total item count —
      and therefore pagination — is unaffected. Remaining items are marked
      aged.
    - >= *hide_days*: the feed's items are dropped from the result entirely.
      ``fetch_rss_aggregated`` already excludes these feeds before selection
      (so their slots are refilled); this tier is a backstop. It only affects
      rendering; ``fetch_rss_aggregated`` still fetches and
      parses the feed every call, so a new post immediately un-hides it.

    ``fetch_rss_aggregated`` guarantees every feed's newest article a slot, so
    operating on the aggregated result is sufficient and keeps this concern
    out of ``fetch_rss_aggregated``.

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

    # Find each feed's first and last position up front (without assuming its
    # items are contiguous): a warning goes at the first, and the last
    # (oldest) story yields its slot to it.
    first_idx: dict[str, int] = {}
    last_idx: dict[str, int] = {}
    for idx, it in enumerate(items):
        first_idx.setdefault(it["feedName"], idx)
        last_idx[it["feedName"]] = idx

    result: list[dict] = []
    for idx, it in enumerate(items):
        name = it["feedName"]
        feed_newest = newest[name]
        if feed_newest is None:
            result.append(it)
            continue

        age = (now - feed_newest).days
        if age >= hide_days:
            continue
        if age >= warn_days:
            if idx == first_idx[name]:
                result.append(
                    {
                        "title": f"WARNING: no new stories in {age} days — feed still active?",
                        "link": "",
                        "published": "",
                        "image": "",
                        "feedName": name,
                        "feedImage": it.get("feedImage", ""),
                        "stale": True,
                        "staleDays": age,
                    }
                )
            if idx != last_idx[name]:
                result.append({**it, "aged": True})
        elif age >= aged_days:
            result.append({**it, "aged": True})
        else:
            result.append(it)
    return result
