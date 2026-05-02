"""Tests for fetch_cached: TTL hit, miss, stale-fallback on upstream failure."""

import time
import unittest
from unittest.mock import patch

import server


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self._body


class FetchCachedTests(unittest.TestCase):
    def setUp(self):
        # Isolate cache state per test.
        with server._cache_lock:
            server._cache.clear()

    def tearDown(self):
        with server._cache_lock:
            server._cache.clear()

    def test_first_call_fetches_and_caches(self):
        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"hello")) as mock_open:
            result = server.fetch_cached("https://example.com/a", ttl_seconds=60)

        self.assertEqual(result, b"hello")
        self.assertEqual(mock_open.call_count, 1)
        self.assertIn("https://example.com/a", server._cache)

    def test_within_ttl_returns_cached_without_refetch(self):
        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"hello")) as mock_open:
            server.fetch_cached("https://example.com/a", ttl_seconds=60)
            second = server.fetch_cached("https://example.com/a", ttl_seconds=60)

        self.assertEqual(second, b"hello")
        # Only one upstream fetch should have occurred.
        self.assertEqual(mock_open.call_count, 1)

    def test_expired_ttl_refetches(self):
        # Seed cache directly with an already-expired entry.
        url = "https://example.com/a"
        with server._cache_lock:
            server._cache[url] = (time.time() - 10, b"old")

        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"new")) as mock_open:
            result = server.fetch_cached(url, ttl_seconds=60)

        self.assertEqual(result, b"new")
        self.assertEqual(mock_open.call_count, 1)

    def test_returns_stale_on_upstream_failure(self):
        # Seed an expired entry; upstream fails; should return the stale body.
        url = "https://example.com/a"
        with server._cache_lock:
            server._cache[url] = (time.time() - 10, b"stale")

        with patch("urllib.request.urlopen", side_effect=ConnectionError("boom")) as mock_open:
            result = server.fetch_cached(url, ttl_seconds=60)

        self.assertEqual(result, b"stale")
        self.assertEqual(mock_open.call_count, 1)

    def test_no_cache_no_fallback_raises(self):
        with patch("urllib.request.urlopen", side_effect=ConnectionError("boom")):
            with self.assertRaises(ConnectionError):
                server.fetch_cached("https://example.com/never-fetched", ttl_seconds=60)

    def test_old_entries_evicted_after_day(self):
        # Pre-seed with an entry whose TTL expired more than a day ago — it should be
        # evicted on the next successful fetch.
        url_old = "https://example.com/old"
        url_new = "https://example.com/new"
        with server._cache_lock:
            server._cache[url_old] = (time.time() - 86400 - 100, b"ancient")

        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"fresh")):
            server.fetch_cached(url_new, ttl_seconds=60)

        with server._cache_lock:
            self.assertNotIn(url_old, server._cache)
            self.assertIn(url_new, server._cache)


if __name__ == "__main__":
    unittest.main()
