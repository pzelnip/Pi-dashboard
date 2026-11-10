"""HTTP-level tests: GET routing, and static-file caching (ETag + no-cache, 304)."""

import datetime as dt
import io
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from tests import helpers  # ensures repo root is on sys.path

import server


class _ServerTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.DashboardHandler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        # A short poll interval: shutdown() otherwise waits up to 0.5s per class.
        threading.Thread(target=cls.httpd.serve_forever, kwargs={"poll_interval": 0.05},
                         daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        # Keep the handler's request log out of the test output.
        patch("sys.stderr", new_callable=io.StringIO).start()
        self.addCleanup(patch.stopall)

    def _get(self, path, headers=None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()


class RoutingTests(_ServerTestCase):
    def test_version_route(self):
        status, _, body = self._get("/api/version")

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"version": server.VERSION})

    def test_time_route_answers_without_config(self):
        with patch.object(server, "load_config", side_effect=ValueError("broken")):
            status, _, body = self._get("/api/time")

        self.assertEqual(status, 200)
        self.assertEqual(set(json.loads(body)), {"now", "offsetMinutes", "nextChange"})

    def test_api_route_dispatches_to_handler(self):
        cfg = {"countdowns": [{"date": "2027-01-01", "title": "B"},
                              {"date": "2026-12-25", "title": "A"}]}
        with patch.object(server, "load_config", return_value=cfg):
            status, _, body = self._get("/api/countdowns")

        self.assertEqual(status, 200)
        self.assertEqual([c["title"] for c in json.loads(body)["countdowns"]], ["A", "B"])

    def test_rss_returns_every_item_in_one_payload(self):
        cfg = {"rss": [{"name": "A", "url": "https://example.com/a"}]}
        items = [{"title": f"t{i}", "feedName": "A", "published": ""} for i in range(9)]
        with patch.object(server, "load_config", return_value=cfg), \
                patch.object(server, "fetch_rss_aggregated", return_value=items):
            status, _, body = self._get("/api/rss")

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"pageSize": 4, "items": items})

    def test_debug_reports_rss_article_counts_per_feed(self):
        cfg = {"rss": [{"name": "Busy", "url": "https://example.com/busy"},
                       {"name": "Dead", "url": "https://example.com/dead"},
                       {"name": "Down", "url": "https://example.com/down"}]}
        today = dt.datetime.now(dt.timezone.utc)
        feeds = {
            "https://example.com/busy": ("", [
                {"title": f"b{i}", "link": "", "image": "",
                 "published": (today - dt.timedelta(hours=i)).isoformat()}
                for i in range(20)
            ]),
            "https://example.com/dead": ("", [
                {"title": "d", "link": "", "image": "",
                 "published": (today - dt.timedelta(days=40)).isoformat()},
            ]),
        }

        def fake_fetch(url, limit=4):
            if url not in feeds:
                raise OSError("down")
            return feeds[url]

        with patch.object(server, "load_config", return_value=cfg), \
                patch("parsers.rss.fetch_rss", side_effect=fake_fetch):
            status, _, body = self._get("/api/debug")

        self.assertEqual(status, 200)
        rss = {e["url"]: e["rss"] for e in json.loads(body)["cache"] if "rss" in e}
        # 3 feeds x 4 = 12 slots; Dead is hidden, Down failed, Busy takes all.
        self.assertEqual(rss["https://example.com/busy"],
                         {"name": "Busy", "articles": 20, "shown": 12,
                          "hidden": False, "newestDays": 0})
        self.assertEqual(rss["https://example.com/dead"],
                         {"name": "Dead", "articles": 1, "shown": 0,
                          "hidden": True, "newestDays": 40})
        self.assertIsNone(rss["https://example.com/down"]["articles"])
        self.assertEqual(rss["https://example.com/down"]["shown"], 0)

    def test_unknown_path_falls_through_to_static(self):
        status, _, _ = self._get("/no-such-file.txt")

        self.assertEqual(status, 404)

    def test_every_route_is_a_handler_method(self):
        for path, handler in server.DashboardHandler._GET_ROUTES.items():
            self.assertTrue(path.startswith("/api/"), path)
            self.assertIs(getattr(server.DashboardHandler, handler.__name__), handler)


class StaticCachingTests(_ServerTestCase):
    def test_static_file_has_etag_and_revalidates(self):
        status, headers, body = self._get("/style.css")

        self.assertEqual(status, 200)
        self.assertTrue(body)
        self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertTrue(headers["ETag"])

    def test_matching_etag_gets_304_without_body(self):
        _, headers, _ = self._get("/style.css")

        status, headers304, body = self._get("/style.css", {"If-None-Match": headers["ETag"]})

        self.assertEqual(status, 304)
        self.assertEqual(body, b"")
        self.assertEqual(headers304["ETag"], headers["ETag"])

    def test_stale_etag_gets_full_response(self):
        status, _, body = self._get("/style.css", {"If-None-Match": '"0-0"'})

        self.assertEqual(status, 200)
        self.assertTrue(body)


if __name__ == "__main__":
    unittest.main()
