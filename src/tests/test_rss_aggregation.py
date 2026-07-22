"""Tests for RSS aggregation and date parsing logic."""

import unittest
from unittest.mock import patch

import datetime as dt

from parsers.rss import _parse_published_date, fetch_rss_aggregated, mark_stale_feeds


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
    def test_selects_by_global_sort_grouped_by_feed(self, mock_fetch):
        # Feed1 has articles at Jan and Dec; Feed2 has article at Jun.
        # Global sort: Dec (Feed1), Jun (Feed2), Jan (Feed1).
        # All within per-feed cap of 4, so all selected.
        # Grouped: Feed1 first (newest=Dec), then Feed2.
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
        # Feed1 group first (its newest selected article is Dec)
        self.assertEqual(result[0]["title"], "New")
        self.assertEqual(result[0]["feedName"], "Feed1")
        self.assertEqual(result[0]["feedImage"], "img1.png")
        self.assertEqual(result[1]["title"], "Old")
        self.assertEqual(result[1]["feedName"], "Feed1")
        # Feed2 group second
        self.assertEqual(result[2]["title"], "Mid")
        self.assertEqual(result[2]["feedName"], "Feed2")

    @patch("parsers.rss.fetch_rss")
    def test_age_hours_computed_from_published(self, mock_fetch):
        mock_fetch.side_effect = [
            ("img1.png", [
                {"title": "SixHours", "link": "", "published": "2020-12-01T06:00:00Z", "image": ""},
                {"title": "TwoDays", "link": "", "published": "2020-11-29T12:00:00Z", "image": ""},
            ]),
        ]
        now = dt.datetime(2020, 12, 1, 12, 0, 0)
        result = fetch_rss_aggregated(
            [{"name": "Feed1", "url": "http://f1"}], items_per_feed=4, now=now
        )
        by_title = {i["title"]: i for i in result}
        self.assertEqual(by_title["SixHours"]["ageHours"], 6.0)
        self.assertEqual(by_title["TwoDays"]["ageHours"], 48.0)

    @patch("parsers.rss.fetch_rss")
    def test_age_hours_none_when_unparseable_and_clamped_when_future(self, mock_fetch):
        mock_fetch.side_effect = [
            ("img1.png", [
                {"title": "NoDate", "link": "", "published": "", "image": ""},
                {"title": "BadDate", "link": "", "published": "not a date", "image": ""},
                {"title": "Future", "link": "", "published": "2020-12-02T00:00:00Z", "image": ""},
            ]),
        ]
        now = dt.datetime(2020, 12, 1, 12, 0, 0)
        result = fetch_rss_aggregated(
            [{"name": "Feed1", "url": "http://f1"}], items_per_feed=4, now=now
        )
        by_title = {i["title"]: i for i in result}
        self.assertIsNone(by_title["NoDate"]["ageHours"])
        self.assertIsNone(by_title["BadDate"]["ageHours"])
        # Slightly-future timestamps (clock skew) clamp to 0 rather than negative.
        self.assertEqual(by_title["Future"]["ageHours"], 0.0)

    @patch("parsers.rss.fetch_rss")
    def test_per_feed_cap_applied_via_global_sort(self, mock_fetch):
        # Feed1 has 6 articles, Feed2 has 2.  With items_per_feed=4,
        # only 4 from Feed1 should be selected (the 4 newest globally).
        mock_fetch.side_effect = [
            ("img1.png", [
                {"title": "F1-Jan", "link": "", "published": "2020-01-01T00:00:00Z", "image": ""},
                {"title": "F1-Feb", "link": "", "published": "2020-02-01T00:00:00Z", "image": ""},
                {"title": "F1-Mar", "link": "", "published": "2020-03-01T00:00:00Z", "image": ""},
                {"title": "F1-Apr", "link": "", "published": "2020-04-01T00:00:00Z", "image": ""},
                {"title": "F1-May", "link": "", "published": "2020-05-01T00:00:00Z", "image": ""},
                {"title": "F1-Jun", "link": "", "published": "2020-06-01T00:00:00Z", "image": ""},
            ]),
            ("img2.png", [
                {"title": "F2-Jul", "link": "", "published": "2020-07-01T00:00:00Z", "image": ""},
                {"title": "F2-Aug", "link": "", "published": "2020-08-01T00:00:00Z", "image": ""},
            ]),
        ]

        feeds = [{"name": "Feed1", "url": "http://f1"}, {"name": "Feed2", "url": "http://f2"}]
        result = fetch_rss_aggregated(feeds, items_per_feed=4)

        self.assertEqual(len(result), 6)  # 4 from Feed1 + 2 from Feed2
        # Feed2 group first (newest=Aug), then Feed1 (newest=Jun)
        self.assertEqual(result[0]["feedName"], "Feed2")
        self.assertEqual(result[1]["feedName"], "Feed2")
        self.assertEqual(result[2]["feedName"], "Feed1")
        # Feed1 should have Jun, May, Apr, Mar (the 4 newest), not Jan/Feb
        feed1_titles = [r["title"] for r in result if r["feedName"] == "Feed1"]
        self.assertEqual(feed1_titles, ["F1-Jun", "F1-May", "F1-Apr", "F1-Mar"])

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
    def test_explicit_max_items_caps_selection(self, mock_fetch):
        # 10 feeds each returning 4 items = 40 eligible, explicit cap of 32.
        def make_items(feed_idx):
            return [
                {"title": f"F{feed_idx}-{i}", "link": "", "published": f"2020-{feed_idx+1:02d}-{i+1:02d}T00:00:00Z", "image": ""}
                for i in range(4)
            ]
        mock_fetch.side_effect = [
            (f"img{i}.png", make_items(i)) for i in range(10)
        ]
        feeds = [{"name": f"Feed{i}", "url": f"http://f{i}"} for i in range(10)]

        result = fetch_rss_aggregated(feeds, items_per_feed=4, max_items=32)

        self.assertEqual(len(result), 32)

    @patch("parsers.rss.fetch_rss")
    def test_default_max_items_scales_with_feed_count(self, mock_fetch):
        # No explicit cap: every feed gets its full items_per_feed share, so a
        # low-frequency feed with only older posts is never crowded out.
        def make_items(feed_idx):
            return [
                {"title": f"F{feed_idx}-{i}", "link": "", "published": f"2020-{feed_idx+1:02d}-{i+1:02d}T00:00:00Z", "image": ""}
                for i in range(4)
            ]
        mock_fetch.side_effect = [
            (f"img{i}.png", make_items(i)) for i in range(10)
        ]
        feeds = [{"name": f"Feed{i}", "url": f"http://f{i}"} for i in range(10)]

        result = fetch_rss_aggregated(feeds, items_per_feed=4)

        self.assertEqual(len(result), 40)
        self.assertTrue(all(any(it["feedName"] == f"Feed{i}" for it in result) for i in range(10)))

    @patch("parsers.rss.fetch_rss")
    def test_fewer_than_max_items_not_padded(self, mock_fetch):
        # 2 feeds with 4 items each = 8 total, fewer than 32, no padding.
        mock_fetch.side_effect = [
            ("img1.png", [
                {"title": f"A{i}", "link": "", "published": f"2020-01-{i+1:02d}T00:00:00Z", "image": ""}
                for i in range(4)
            ]),
            ("img2.png", [
                {"title": f"B{i}", "link": "", "published": f"2020-02-{i+1:02d}T00:00:00Z", "image": ""}
                for i in range(4)
            ]),
        ]
        feeds = [{"name": "Feed1", "url": "http://f1"}, {"name": "Feed2", "url": "http://f2"}]
        result = fetch_rss_aggregated(feeds, items_per_feed=4)
        self.assertEqual(len(result), 8)

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


class MarkStaleFeedsTests(unittest.TestCase):
    """Staleness escalates in three tiers as a feed's newest article ages:
    14 days -> items marked "aged" (subtle styling); 20 days -> a warning
    entry is prepended ahead of the (still-rendered) items; 30 days -> the
    feed's items are dropped from the result entirely.
    """

    NOW = dt.datetime(2026, 7, 18, 12, 0, 0)

    def _item(self, feed, published, title="t", image="img.png"):
        return {
            "title": title,
            "link": "http://x",
            "published": published,
            "image": "",
            "feedName": feed,
            "feedImage": image,
        }

    def test_fresh_feed_untouched(self):
        items = [self._item("Fresh", "2026-07-17T00:00:00Z")]
        out = mark_stale_feeds(items, now=self.NOW)
        self.assertEqual(out, items)
        self.assertNotIn("stale", out[0])
        self.assertNotIn("aged", out[0])

    def test_aged_feed_items_marked_but_no_warning(self):
        items = [
            self._item("Aging", "2026-07-01T00:00:00Z", title="A"),
            self._item("Aging", "2026-06-29T00:00:00Z", title="B"),
        ]
        out = mark_stale_feeds(items, now=self.NOW)
        self.assertEqual(len(out), 2)
        self.assertFalse(any(o.get("stale") for o in out))
        self.assertTrue(all(o["aged"] for o in out))
        self.assertEqual([o["title"] for o in out], ["A", "B"])

    def test_boundary_exactly_14_days_is_aged(self):
        items = [self._item("Edge", "2026-07-04T12:00:00Z")]
        out = mark_stale_feeds(items, now=self.NOW)
        self.assertTrue(out[0]["aged"])
        self.assertNotIn("stale", out[0])

    def test_boundary_13_days_is_fresh(self):
        items = [self._item("Edge", "2026-07-05T12:00:00Z")]
        out = mark_stale_feeds(items, now=self.NOW)
        self.assertNotIn("stale", out[0])
        self.assertNotIn("aged", out[0])

    def test_warn_feed_warning_replaces_oldest_story(self):
        items = [
            self._item("Dead", "2026-06-27T00:00:00Z", title="Old A"),
            self._item("Dead", "2026-06-25T00:00:00Z", title="Old B"),
            self._item("Dead", "2026-06-20T00:00:00Z", title="Old C"),
        ]
        out = mark_stale_feeds(items, now=self.NOW)
        # Warning entry prepended, taking the oldest story's slot — total
        # count for the feed stays at 3, not 4, so pagination is unaffected.
        self.assertEqual(len(out), 3)
        self.assertTrue(out[0]["stale"])
        self.assertEqual(out[0]["feedName"], "Dead")
        self.assertEqual(out[0]["feedImage"], "img.png")
        # Age is measured from the feed's *newest* article (Jun 27 -> 21 days).
        self.assertEqual(out[0]["staleDays"], 21)
        self.assertIn("21 days", out[0]["title"])
        self.assertEqual(out[0]["link"], "")
        self.assertEqual([o["title"] for o in out[1:]], ["Old A", "Old B"])
        self.assertTrue(all(o["aged"] for o in out[1:]))

    def test_boundary_exactly_20_days_is_warned(self):
        items = [self._item("Edge", "2026-06-28T12:00:00Z")]
        out = mark_stale_feeds(items, now=self.NOW)
        self.assertTrue(out[0]["stale"])
        self.assertEqual(out[0]["staleDays"], 20)

    def test_boundary_19_days_is_aged_not_warned(self):
        items = [self._item("Edge", "2026-06-29T12:00:00Z")]
        out = mark_stale_feeds(items, now=self.NOW)
        self.assertEqual(len(out), 1)
        self.assertNotIn("stale", out[0])
        self.assertTrue(out[0]["aged"])

    def test_hidden_feed_dropped_entirely(self):
        items = [
            self._item("Zombie", "2026-05-01T00:00:00Z", title="A"),
            self._item("Zombie", "2026-04-01T00:00:00Z", title="B"),
        ]
        out = mark_stale_feeds(items, now=self.NOW)
        self.assertEqual(out, [])

    def test_boundary_exactly_30_days_is_hidden(self):
        items = [self._item("Edge", "2026-06-18T12:00:00Z")]
        out = mark_stale_feeds(items, now=self.NOW)
        self.assertEqual(out, [])

    def test_boundary_29_days_is_warned_not_hidden(self):
        # Single-item group: the warning takes the only story's slot.
        items = [self._item("Edge", "2026-06-19T12:00:00Z")]
        out = mark_stale_feeds(items, now=self.NOW)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]["stale"])
        self.assertEqual(out[0]["staleDays"], 29)

    def test_mixed_feeds_preserve_order_and_position(self):
        items = [
            self._item("Fresh1", "2026-07-18T00:00:00Z", title="F1"),
            self._item("Warned", "2026-06-27T00:00:00Z", title="D1"),
            self._item("Warned", "2026-06-25T00:00:00Z", title="D2"),
            self._item("Fresh2", "2026-07-16T00:00:00Z", title="F2"),
        ]
        out = mark_stale_feeds(items, now=self.NOW)
        # Warned's D2 (oldest) is dropped, replaced by the warning entry.
        self.assertEqual([o["feedName"] for o in out], ["Fresh1", "Warned", "Warned", "Fresh2"])
        self.assertEqual(out[0]["title"], "F1")
        self.assertTrue(out[1]["stale"])
        self.assertEqual(out[2]["title"], "D1")
        self.assertEqual(out[3]["title"], "F2")

    def test_feed_with_no_parseable_dates_left_alone(self):
        # Can't tell if it's stale or merely dateless — don't warn.
        items = [
            self._item("Dateless", "", title="A"),
            self._item("Dateless", "not a date", title="B"),
        ]
        out = mark_stale_feeds(items, now=self.NOW)
        self.assertEqual(len(out), 2)
        self.assertFalse(any(o.get("stale") for o in out))
        self.assertFalse(any(o.get("aged") for o in out))

    def test_empty_list(self):
        self.assertEqual(mark_stale_feeds([], now=self.NOW), [])

    def test_does_not_mutate_original_items(self):
        items = [self._item("Aging", "2026-06-25T00:00:00Z", title="A")]
        mark_stale_feeds(items, now=self.NOW)
        self.assertNotIn("aged", items[0])


if __name__ == "__main__":
    unittest.main()
