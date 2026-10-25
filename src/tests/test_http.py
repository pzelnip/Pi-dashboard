"""HTTP-level tests: GET routing, and static-file caching (ETag + no-cache, 304)."""

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
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

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
