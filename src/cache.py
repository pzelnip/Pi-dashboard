"""In-memory TTL cache for upstream HTTP fetches.

Every upstream call goes through `fetch_cached`. On network failure we return
the *expired* cached body if any exists — this is what keeps the dashboard
useful when an external API blips.

Callers pass a `validate` callable (e.g. `json.loads`) so a 200 response with
an unusable body — a CDN error page, a captive portal, an empty body — is
treated like a failure instead of being cached and served as the fallback.
Every failure is logged to stderr (journalctl on the Pi) with what came back.

A failed URL isn't retried for `FAILURE_BACKOFF_SECONDS`: callers get the stale
body (or the same error) straight away instead of each waiting out the timeout
on an upstream that is down. Concurrent misses on one URL share a single fetch.

Callers whose data can lag a refresh (RSS, calendars) pass
`stale_while_revalidate=True`: an expired body comes back at once and the
refetch runs in the background, so their requests only ever wait on an
upstream for a URL that has never been fetched.
"""

import hashlib
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor

USER_AGENT = "Mozilla/5.0 (compatible; pi-dashboard/1.0)"

FAILURE_BACKOFF_SECONDS = 60

_cache: dict[str, tuple[float, bytes]] = {}
_cache_lock = threading.Lock()
# url -> (retry no earlier than, error message of the last failure)
_failures: dict[str, tuple[float, str]] = {}
# One lock per URL, held across the upstream fetch, so concurrent misses wait
# for the first fetch rather than all going upstream.
_url_locks: dict[str, threading.Lock] = {}

# Shared by callers that fetch several URLs per request (RSS feeds, calendars),
# so one slow upstream doesn't hold up the rest.
_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="fetch")
# Stale-while-revalidate refreshes get their own workers. Feeds fetched
# together expire together, and their refreshes can each hang for the full
# timeout; on the shared pool they'd hold up the requests waiting on it.
_refresh_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="refresh")

_SNIPPET_CHARS = 120


def _url_label(url: str) -> str:
    # Host plus a short hash: enough to tell entries apart in the logs without
    # writing private calendar URLs (secret tokens in path/query) to the journal.
    h = hashlib.sha256(url.encode()).hexdigest()[:8]
    return f"{urllib.parse.urlsplit(url).hostname}#{h}"


def _describe(status: int | None, content_type: str | None, body: bytes) -> str:
    """One-line summary of an upstream response, for logs and error messages."""
    parts = [f"HTTP {status}" if status is not None else "no status"]
    parts.append(content_type or "no content-type")
    parts.append(f"{len(body)} bytes")
    snippet = " ".join(body[:_SNIPPET_CHARS * 2].decode("utf-8", errors="replace").split())
    if snippet:
        parts.append(repr(snippet[:_SNIPPET_CHARS]))
    return ", ".join(parts)


def _log(msg: str) -> None:
    sys.stderr.write(f"[cache] {msg}\n")


def fetch_many(fn: Callable, items: Iterable) -> list:
    """`[fn(item) for item in items]`, run concurrently. Results keep input order."""
    return list(_pool.map(fn, items))


def fetch_cached(
    url: str,
    ttl_seconds: int,
    validate: Callable[[bytes], object] | None = None,
    stale_while_revalidate: bool = False,
) -> bytes:
    """Fetch `url`, caching the body for `ttl_seconds`.

    `validate` is called with the body and should raise if it is unusable;
    such bodies are never cached. With `stale_while_revalidate`, an expired
    body is returned immediately and refreshed in the background.
    """
    with _cache_lock:
        hit = _cache.get(url)
        if hit and hit[0] > time.time():
            return hit[1]
        url_lock = _url_locks.setdefault(url, threading.Lock())

    if stale_while_revalidate and hit:
        _refresh_pool.submit(_refresh_in_background, url, ttl_seconds, validate, url_lock)
        return hit[1]

    with url_lock:
        return _fetch_locked(url, ttl_seconds, validate)


def _refresh_in_background(url, ttl_seconds, validate, url_lock) -> None:
    # Skip if a refresh (or a blocking fetch) of this URL is already running.
    if not url_lock.acquire(blocking=False):
        return
    try:
        _fetch_locked(url, ttl_seconds, validate)
    except Exception:
        pass  # already logged by _fetch; the stale body stays in place
    finally:
        url_lock.release()


def _fetch_locked(url, ttl_seconds, validate) -> bytes:
    """The fetch proper; the caller holds the URL's lock."""
    # Another request may have refreshed (or failed) this URL while we waited.
    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and hit[0] > now:
            return hit[1]
        failure = _failures.get(url)
    if failure and failure[0] > now:
        if hit:
            return hit[1]
        raise RuntimeError(failure[1])
    return _fetch(url, ttl_seconds, validate, hit, now)


def _fetch(url, ttl_seconds, validate, hit, now) -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    req = urllib.request.Request(url, headers=headers)
    try:
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
                status, content_type = resp.status, resp.headers.get("Content-Type")
        except urllib.error.HTTPError as e:
            # Re-raise with the response details; HTTPError's own str() is just
            # "HTTP Error 429: Too Many Requests" and drops the body.
            detail = _describe(e.code, e.headers.get("Content-Type"), e.read())
            raise RuntimeError(f"upstream error ({detail})") from e
        if validate is not None:
            try:
                validate(body)
            except Exception as e:
                raise ValueError(
                    f"upstream returned unusable response ({_describe(status, content_type, body)}): {e}"
                ) from e
    except Exception as e:
        with _cache_lock:
            _failures[url] = (now + FAILURE_BACKOFF_SECONDS, str(e))
        # On failure, return any cached body we still have (even if expired).
        # The frontend stays useful when upstream APIs blip.
        if hit:
            _log(f"{_url_label(url)} fetch failed, serving stale body "
                 f"(expired {int(now - hit[0])}s ago): {e}")
            return hit[1]
        _log(f"{_url_label(url)} fetch failed, nothing cached: {e}")
        raise

    with _cache_lock:
        # Amortized eviction: drop entries whose TTL expired more than a day ago.
        # Keeps the stale-fallback window generous while preventing unbounded growth
        # over long uptimes (NHL adds two new keys per calendar day).
        cutoff = now - 86400
        for u in [u for u, (exp, _) in _cache.items() if exp < cutoff]:
            del _cache[u]
        for u in [u for u, (retry_at, _) in _failures.items() if retry_at < now]:
            del _failures[u]
        # A held lock is a fetch in progress (possibly a URL's first, so not in
        # _cache yet): dropping it would let the next request fetch in parallel.
        for u in [u for u, lock in _url_locks.items()
                  if u not in _cache and u not in _failures and u != url and not lock.locked()]:
            del _url_locks[u]
        _failures.pop(url, None)
        _cache[url] = (now + ttl_seconds, body)
    return body
