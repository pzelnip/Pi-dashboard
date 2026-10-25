"""Tests for fetch_cached: TTL hit, miss, stale-fallback, validation, logging."""

import io
import json
import threading
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
            cache._failures.clear()
        # Capture the failure log instead of printing it into the test output.
        self.log = patch("sys.stderr", new_callable=io.StringIO).start()
        self.addCleanup(patch.stopall)

    def tearDown(self):
        with cache._cache_lock:
            cache._cache.clear()
            cache._failures.clear()

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

    def test_failure_backs_off_without_refetching(self):
        url = "https://example.com/down"
        with patch("urllib.request.urlopen", side_effect=ConnectionError("boom")) as mock_open:
            with self.assertRaises(ConnectionError):
                cache.fetch_cached(url, ttl_seconds=60)
            # Within the backoff the same error comes straight back.
            with self.assertRaisesRegex(RuntimeError, "boom"):
                cache.fetch_cached(url, ttl_seconds=60)

        self.assertEqual(mock_open.call_count, 1)

    def test_backoff_serves_stale_without_refetching(self):
        url = "https://example.com/a"
        with cache._cache_lock:
            cache._cache[url] = (time.time() - 10, b"stale")

        with patch("urllib.request.urlopen", side_effect=ConnectionError("boom")) as mock_open:
            first = cache.fetch_cached(url, ttl_seconds=60)
            second = cache.fetch_cached(url, ttl_seconds=60)

        self.assertEqual((first, second), (b"stale", b"stale"))
        self.assertEqual(mock_open.call_count, 1)

    def test_retries_once_backoff_expires(self):
        url = "https://example.com/a"
        with cache._cache_lock:
            cache._failures[url] = (time.time() - 1, "boom")

        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"back")) as mock_open:
            result = cache.fetch_cached(url, ttl_seconds=60)

        self.assertEqual(result, b"back")
        self.assertEqual(mock_open.call_count, 1)
        self.assertNotIn(url, cache._failures)

    def test_concurrent_misses_share_one_fetch(self):
        release = threading.Event()

        def slow_open(*args, **kwargs):
            release.wait(5)
            return _FakeResponse(b"once")

        with patch("urllib.request.urlopen", side_effect=slow_open) as mock_open:
            results = []
            threads = [
                threading.Thread(target=lambda: results.append(
                    cache.fetch_cached("https://example.com/a", ttl_seconds=60)))
                for _ in range(4)
            ]
            for t in threads:
                t.start()
            time.sleep(0.05)  # let every thread reach the fetch
            release.set()
            for t in threads:
                t.join(5)

        self.assertEqual(results, [b"once"] * 4)
        self.assertEqual(mock_open.call_count, 1)


class StaleWhileRevalidateTests(unittest.TestCase):
    URL = "https://example.com/feed"

    def setUp(self):
        with cache._cache_lock:
            cache._cache.clear()
            cache._failures.clear()
        patch("sys.stderr", new_callable=io.StringIO).start()
        self.addCleanup(patch.stopall)

    def _expire(self, body):
        with cache._cache_lock:
            cache._cache[self.URL] = (time.time() - 10, body)

    def _wait_until(self, condition):
        deadline = time.time() + 5
        while not condition():
            self.assertLess(time.time(), deadline, "background refresh never finished")
            time.sleep(0.005)

    def _refreshed(self):
        with cache._cache_lock:
            return cache._cache[self.URL][0] > time.time()

    def test_expired_body_returns_at_once_and_refreshes_in_background(self):
        self._expire(b"old")
        release = threading.Event()

        def slow_open(*args, **kwargs):
            release.wait(5)
            return _FakeResponse(b"new")

        with patch("urllib.request.urlopen", side_effect=slow_open) as mock_open:
            result = cache.fetch_cached(self.URL, 60, stale_while_revalidate=True)
            self.assertEqual(result, b"old")  # didn't wait on the slow upstream
            release.set()
            self._wait_until(self._refreshed)

        self.assertEqual(mock_open.call_count, 1)
        self.assertEqual(cache.fetch_cached(self.URL, 60), b"new")

    def test_concurrent_stale_hits_trigger_one_refresh(self):
        self._expire(b"old")
        release = threading.Event()

        def slow_open(*args, **kwargs):
            release.wait(5)
            return _FakeResponse(b"new")

        with patch("urllib.request.urlopen", side_effect=slow_open) as mock_open:
            for _ in range(3):
                self.assertEqual(cache.fetch_cached(self.URL, 60, stale_while_revalidate=True), b"old")
            release.set()
            self._wait_until(self._refreshed)

        self.assertEqual(mock_open.call_count, 1)

    def test_failed_background_refresh_keeps_stale_body(self):
        self._expire(b"old")
        with patch("urllib.request.urlopen", side_effect=ConnectionError("boom")):
            cache.fetch_cached(self.URL, 60, stale_while_revalidate=True)
            self._wait_until(lambda: self.URL in cache._failures)

        self.assertEqual(cache._cache[self.URL][1], b"old")
        self.assertIn(self.URL, cache._failures)

    def test_first_fetch_still_blocks(self):
        with patch("urllib.request.urlopen", return_value=_FakeResponse(b"first")):
            result = cache.fetch_cached(self.URL, 60, stale_while_revalidate=True)

        self.assertEqual(result, b"first")


class FetchManyTests(unittest.TestCase):
    def test_runs_concurrently_and_keeps_order(self):
        barrier = threading.Barrier(3, timeout=5)

        def work(n):
            barrier.wait()  # deadlocks (and times out) unless all three run at once
            return n * 10

        self.assertEqual(cache.fetch_many(work, [1, 2, 3]), [10, 20, 30])


if __name__ == "__main__":
    unittest.main()
