"""Tests for RSS aggregation and date parsing logic."""

import unittest
from unittest.mock import patch

from parsers.rss import _parse_published_date, fetch_rss_aggregated


class ParsePublishedDateTests(unittest.TestCase):
    def test_rfc2822_date(self):
        d = _parse_published_date("Thu, 01 May 2026 14:30:00 +0000")
        self.assertEqual(d.year, 2026)
        self.assertEqual(d.month, 5)
        self.assertEqual(d.day, 1)

    def test_iso8601_date_with_z(self):
        d = _parse_published_date("2026-05-01T13:00:00Z")
        self.assertEqual(d.year, 2026)
        self.assertEqual(d.month, 5)

    def test_iso8601_date_with_offset(self):
        d = _parse_published_date("2026-05-01T13:00:00+00:00")
        self.assertEqual(d.year, 2026)

    def test_empty_string_returns_min(self):
        import datetime as dt
        self.assertEqual(_parse_published_date(""), dt.datetime.min)

    def test_unparseable_returns_min(self):
        import datetime as dt
        self.assertEqual(_parse_published_date("not a date"), dt.datetime.min)


class FetchRssAggregatedTests(unittest.TestCase):
    @patch("parsers.rss.fetch_rss")
    def test_aggregates_and_sorts_by_date(self, mock_fetch):
        # Two feeds with items at known dates.
        mock_fetch.side_effect = [
            ("img1.png", [
                {"title": "Old", "link": "", "published": "2020-01-01T00:00:00Z", "image": ""},
                {"title": "New", "link": "", "published": "2020-12-01T00:00:00Z", "image": ""},
            ]),
            ("img2.png", [
                {"title": "Mid", "link": "", "published": "2020-06-01T00:00:00Z", "image": ""},
            ]),
        ]

        feeds = [{"name": "Feed1", "url": "http://f1"}, {"name": "Feed2", "url": "http://f2"}]
        result = fetch_rss_aggregated(feeds, items_per_feed=4)

        self.assertEqual(len(result), 3)
        self.assertEqual(result[0]["title"], "New")
        self.assertEqual(result[0]["feedName"], "Feed1")
        self.assertEqual(result[0]["feedImage"], "img1.png")
        self.assertEqual(result[1]["title"], "Mid")
        self.assertEqual(result[1]["feedName"], "Feed2")
        self.assertEqual(result[2]["title"], "Old")

    @patch("parsers.rss.fetch_rss")
    def test_skips_failed_feeds(self, mock_fetch):
        mock_fetch.side_effect = [
            Exception("network error"),
            ("img.png", [
                {"title": "OK", "link": "", "published": "2020-06-01T00:00:00Z", "image": ""},
            ]),
        ]

        feeds = [{"name": "Bad", "url": "http://bad"}, {"name": "Good", "url": "http://good"}]
        result = fetch_rss_aggregated(feeds, items_per_feed=4)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["title"], "OK")

    @patch("parsers.rss.fetch_rss")
    def test_empty_feeds_returns_empty(self, mock_fetch):
        result = fetch_rss_aggregated([], items_per_feed=4)
        self.assertEqual(result, [])


if __name__ == "__main__":
    unittest.main()
