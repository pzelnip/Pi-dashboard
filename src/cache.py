"""In-memory TTL cache for upstream HTTP fetches.

Every upstream call goes through `fetch_cached`. On network failure we return
the *expired* cached body if any exists — this is what keeps the dashboard
useful when an external API blips.
"""

import threading
import time
import urllib.request

USER_AGENT = "Mozilla/5.0 (compatible; pi-dashboard/1.0)"

_cache: dict[str, tuple[float, bytes]] = {}
_cache_lock = threading.Lock()


def fetch_cached(url: str, ttl_seconds: int) -> bytes:
    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and hit[0] > now:
            return hit[1]

    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read()
    except Exception:
        # On network failure, return any cached body we still have (even if expired).
        # The frontend stays useful when upstream APIs blip.
        if hit:
            return hit[1]
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
