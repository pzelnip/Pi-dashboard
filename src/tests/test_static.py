"""Tests for static-file caching headers: ETag + no-cache, 304 on revalidation."""

import io
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from tests import helpers  # ensures repo root is on sys.path

import server


class StaticCachingTests(unittest.TestCase):
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
