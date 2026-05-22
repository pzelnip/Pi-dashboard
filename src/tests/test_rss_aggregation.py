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
        self.assertIsNone(d.tzinfo)  # always naive

    def test_iso8601_date_with_z(self):
        d = _parse_published_date("2026-05-01T13:00:00Z")
        self.assertEqual(d.year, 2026)
        self.assertEqual(d.month, 5)
        self.assertIsNone(d.tzinfo)

    def test_iso8601_date_with_offset(self):
        d = _parse_published_date("2026-05-01T13:00:00+00:00")
        self.assertEqual(d.year, 2026)
        self.assertIsNone(d.tzinfo)

    def test_all_results_are_naive_and_comparable(self):
        """Verify no TypeError when sorting mixed date formats."""
        import datetime as dt
        dates = [
            _parse_published_date("Thu, 01 May 2026 14:30:00 +0500"),
            _parse_published_date("2026-05-01T13:00:00Z"),
            _parse_published_date("2026-05-01T13:00:00+02:00"),
            _parse_published_date(""),
            _parse_published_date("not a date"),
        ]
        # This should not raise TypeError
        sorted_dates = sorted(dates, reverse=True)
        self.assertEqual(len(sorted_dates), 5)

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

    @patch("parsers.rss.fetch_rss")
    def test_items_without_published_sort_last(self, mock_fetch):
        mock_fetch.side_effect = [
            ("img.png", [
                {"title": "Has date", "link": "", "published": "2020-12-01T00:00:00Z", "image": ""},
                {"title": "No date", "link": "", "published": "", "image": ""},
                {"title": "Garbage date", "link": "", "published": "not a date", "image": ""},
            ]),
        ]

        feeds = [{"name": "Feed", "url": "http://f"}]
        result = fetch_rss_aggregated(feeds, items_per_feed=4)

        self.assertEqual(len(result), 3)
        self.assertEqual(result[0]["title"], "Has date")
        # Items with empty/garbage published should be at the end
        self.assertIn(result[1]["title"], ("No date", "Garbage date"))
        self.assertIn(result[2]["title"], ("No date", "Garbage date"))

    @patch("parsers.rss.fetch_rss")
    def test_does_not_mutate_original_items(self, mock_fetch):
        original_items = [
            {"title": "Item", "link": "", "published": "2020-01-01T00:00:00Z", "image": ""},
        ]
        mock_fetch.return_value = ("img.png", original_items)

        feeds = [{"name": "Feed", "url": "http://f"}]
        fetch_rss_aggregated(feeds, items_per_feed=4)

        # Original items should not have feedName/feedImage added
        self.assertNotIn("feedName", original_items[0])
        self.assertNotIn("feedImage", original_items[0])


if __name__ == "__main__":
    unittest.main()
