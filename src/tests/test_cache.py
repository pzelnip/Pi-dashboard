"""Tests for fetch_cached: TTL hit, miss, stale-fallback, validation, logging."""

import io
import json
import time
import unittest
import urllib.error
from email.message import Message
from unittest.mock import patch

from tests import helpers  # ensures repo root is on sys.path

import cache


class _FakeResponse:
    def __init__(self, body: bytes, status: int = 200, content_type: str = "application/json"):
        self._body = body
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = content_type

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self._body


class FetchCachedTests(unittest.TestCase):
    def setUp(self):
        # Isolate cache state per test.
        with cache._cache_lock:
            cache._cache.clear()
        # Capture the failure log instead of printing it into the test output.
        self.log = patch("sys.stderr", new_callable=io.StringIO).start()
        self.addCleanup(patch.stopall)

    def tearDown(self):
        with cache._cache_lock:
            cache._cache.clear()

    def test_first_call_fetches_and_caches(self):
        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"hello")) as mock_open:
            result = cache.fetch_cached("https://example.com/a", ttl_seconds=60)

        self.assertEqual(result, b"hello")
        self.assertEqual(mock_open.call_count, 1)
        self.assertIn("https://example.com/a", cache._cache)

    def test_within_ttl_returns_cached_without_refetch(self):
        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"hello")) as mock_open:
            cache.fetch_cached("https://example.com/a", ttl_seconds=60)
            second = cache.fetch_cached("https://example.com/a", ttl_seconds=60)

        self.assertEqual(second, b"hello")
        # Only one upstream fetch should have occurred.
        self.assertEqual(mock_open.call_count, 1)

    def test_expired_ttl_refetches(self):
        # Seed cache directly with an already-expired entry.
        url = "https://example.com/a"
        with cache._cache_lock:
            cache._cache[url] = (time.time() - 10, b"old")

        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"new")) as mock_open:
            result = cache.fetch_cached(url, ttl_seconds=60)

        self.assertEqual(result, b"new")
        self.assertEqual(mock_open.call_count, 1)

    def test_returns_stale_on_upstream_failure(self):
        # Seed an expired entry; upstream fails; should return the stale body.
        url = "https://example.com/a"
        with cache._cache_lock:
            cache._cache[url] = (time.time() - 10, b"stale")

        with patch("urllib.request.urlopen", side_effect=ConnectionError("boom")) as mock_open:
            result = cache.fetch_cached(url, ttl_seconds=60)

        self.assertEqual(result, b"stale")
        self.assertEqual(mock_open.call_count, 1)

    def test_no_cache_no_fallback_raises(self):
        with patch("urllib.request.urlopen", side_effect=ConnectionError("boom")):
            with self.assertRaises(ConnectionError):
                cache.fetch_cached("https://example.com/never-fetched", ttl_seconds=60)

    def test_old_entries_evicted_after_day(self):
        # Pre-seed with an entry whose TTL expired more than a day ago — it should be
        # evicted on the next successful fetch.
        url_old = "https://example.com/old"
        url_new = "https://example.com/new"
        with cache._cache_lock:
            cache._cache[url_old] = (time.time() - 86400 - 100, b"ancient")

        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"fresh")):
            cache.fetch_cached(url_new, ttl_seconds=60)

        with cache._cache_lock:
            self.assertNotIn(url_old, cache._cache)
            self.assertIn(url_new, cache._cache)

    def test_failure_is_logged_without_full_url(self):
        url = "https://calendar.example.com/private/secret-token/basic.ics"
        with patch("urllib.request.urlopen", side_effect=ConnectionError("boom")):
            with self.assertRaises(ConnectionError):
                cache.fetch_cached(url, ttl_seconds=60)

        log = self.log.getvalue()
        self.assertIn("calendar.example.com#", log)
        self.assertIn("boom", log)
        self.assertNotIn("secret-token", log)

    def test_invalid_body_is_not_cached_and_stale_is_served(self):
        url = "https://example.com/a"
        with cache._cache_lock:
            cache._cache[url] = (time.time() - 10, b'{"ok": true}')

        html = _FakeResponse(b"<html>maintenance</html>", content_type="text/html")
        with patch("urllib.request.urlopen", return_value=html):
            result = cache.fetch_cached(url, ttl_seconds=60, validate=json.loads)

        self.assertEqual(result, b'{"ok": true}')
        with cache._cache_lock:
            self.assertEqual(cache._cache[url][1], b'{"ok": true}')
        self.assertIn("serving stale body", self.log.getvalue())

    def test_invalid_body_without_cache_raises_with_response_details(self):
        html = _FakeResponse(b"<html>\n  maintenance </html>", content_type="text/html")
        with patch("urllib.request.urlopen", return_value=html):
            with self.assertRaises(ValueError) as ctx:
                cache.fetch_cached("https://example.com/a", ttl_seconds=60, validate=json.loads)

        msg = str(ctx.exception)
        self.assertIn("HTTP 200", msg)
        self.assertIn("text/html", msg)
        self.assertIn("28 bytes", msg)
        self.assertIn("'<html> maintenance </html>'", msg)
        self.assertNotIn("https://example.com/a", cache._cache)

    def test_empty_body_is_reported_as_empty(self):
        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"")):
            with self.assertRaises(ValueError) as ctx:
                cache.fetch_cached("https://example.com/a", ttl_seconds=60, validate=json.loads)

        self.assertIn("0 bytes", str(ctx.exception))

    def test_long_body_snippet_is_truncated(self):
        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"x" * 5000)):
            with self.assertRaises(ValueError) as ctx:
                cache.fetch_cached("https://example.com/a", ttl_seconds=60, validate=json.loads)

        self.assertIn("'" + "x" * cache._SNIPPET_CHARS + "'", str(ctx.exception))
        self.assertNotIn("x" * (cache._SNIPPET_CHARS + 1), str(ctx.exception))

    def test_http_error_includes_status_and_body(self):
        headers = Message()
        headers["Content-Type"] = "application/json"
        err = urllib.error.HTTPError(
            "https://example.com/a", 429, "Too Many Requests", headers,
            io.BytesIO(b'{"reason": "Daily API request limit exceeded"}'),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(RuntimeError) as ctx:
                cache.fetch_cached("https://example.com/a", ttl_seconds=60)

        self.assertIn("HTTP 429", str(ctx.exception))
        self.assertIn("Daily API request limit exceeded", str(ctx.exception))
        self.assertIn("HTTP 429", self.log.getvalue())


if __name__ == "__main__":
    unittest.main()
