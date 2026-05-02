"""Tests for RSS 2.0 and Atom parsing."""

import unittest

from tests._helpers import fixture_bytes

import server


class ParseRssTests(unittest.TestCase):
    def test_rss20_basic_fields(self):
        raw = fixture_bytes("rss20.xml")

        feed_image, items = server.parse_rss(raw)

        self.assertEqual(feed_image, "https://example.com/feed-logo.png")
        self.assertEqual(len(items), 4)  # default limit
        self.assertEqual(items[0]["title"], "First story headline")
        self.assertEqual(items[0]["link"], "https://example.com/story-1")
        self.assertEqual(items[0]["published"], "Thu, 01 May 2026 14:30:00 +0000")

    def test_rss20_image_extraction_priority(self):
        raw = fixture_bytes("rss20.xml")

        _, items = server.parse_rss(raw)

        # Item 1: <img> inside HTML description
        self.assertEqual(items[0]["image"], "https://example.com/story-1.jpg")
        # Item 2: <media:thumbnail>
        self.assertEqual(items[1]["image"], "https://example.com/story-2-thumb.jpg")
        # Item 3: <enclosure type="image/...">
        self.assertEqual(items[2]["image"], "https://example.com/story-3-encl.jpg")
        # Item 4: no image
        self.assertEqual(items[3]["image"], "")

    def test_rss20_custom_limit(self):
        raw = fixture_bytes("rss20.xml")

        _, items = server.parse_rss(raw, limit=2)

        self.assertEqual(len(items), 2)

    def test_rss20_skips_items_without_title(self):
        raw = fixture_bytes("rss20.xml")

        _, items = server.parse_rss(raw, limit=10)

        # Fixture has 6 <item> entries; the last one has no title and should be dropped.
        self.assertEqual(len(items), 5)
        for item in items:
            self.assertTrue(item["title"])

    def test_atom_basic_fields(self):
        raw = fixture_bytes("atom.xml")

        feed_image, items = server.parse_rss(raw)

        self.assertEqual(feed_image, "https://simonwillison.net/static/logo.png")
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["title"], "An Atom entry")
        self.assertEqual(items[0]["link"], "https://simonwillison.net/2026/May/1/an-atom-entry/")
        self.assertEqual(items[0]["published"], "2026-05-01T13:00:00Z")
        self.assertEqual(items[0]["image"], "https://simonwillison.net/img1.png")

    def test_atom_falls_back_to_updated_when_no_published(self):
        raw = fixture_bytes("atom.xml")

        _, items = server.parse_rss(raw)

        # Second entry has no <published>, should fall back to <updated>
        self.assertEqual(items[1]["published"], "2026-05-01T12:00:00Z")

    def test_parse_rss_raises_on_html(self):
        with self.assertRaises(ValueError):
            server.parse_rss(b"<html><body>not xml</body></html>not even close")

    def test_parse_rss_empty_when_no_items(self):
        empty = b'<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>'

        feed_image, items = server.parse_rss(empty)

        self.assertEqual(items, [])
        self.assertEqual(feed_image, "")


if __name__ == "__main__":
    unittest.main()
