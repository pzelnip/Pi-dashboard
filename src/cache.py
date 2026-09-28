"""In-memory TTL cache for upstream HTTP fetches.

Every upstream call goes through `fetch_cached`. On network failure we return
the *expired* cached body if any exists — this is what keeps the dashboard
useful when an external API blips.

Callers pass a `validate` callable (e.g. `json.loads`) so a 200 response with
an unusable body — a CDN error page, a captive portal, an empty body — is
treated like a failure instead of being cached and served as the fallback.
Every failure is logged to stderr (journalctl on the Pi) with what came back.
"""

import hashlib
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

USER_AGENT = "Mozilla/5.0 (compatible; pi-dashboard/1.0)"

_cache: dict[str, tuple[float, bytes]] = {}
_cache_lock = threading.Lock()

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


def fetch_cached(
    url: str, ttl_seconds: int, validate: Callable[[bytes], object] | None = None
) -> bytes:
    """Fetch `url`, caching the body for `ttl_seconds`.

    `validate` is called with the body and should raise if it is unusable;
    such bodies are never cached.
    """
    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and hit[0] > now:
            return hit[1]

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
        _cache[url] = (now + ttl_seconds, body)
    return body
