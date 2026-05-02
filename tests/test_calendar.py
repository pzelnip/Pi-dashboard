"""Tests for iCal parsing and same-day filtering."""

import datetime as dt
import io
import unittest
from contextlib import redirect_stderr

from tests._helpers import fixture_text

import server


class IcsUnfoldTests(unittest.TestCase):
    def test_unfolds_continuation_lines(self):
        text = "SUMMARY:Long summary\n  continued here\nDTSTART:20260101"

        lines = server._ics_unfold(text)

        self.assertEqual(lines, ["SUMMARY:Long summary continued here", "DTSTART:20260101"])

    def test_first_line_with_leading_space_is_kept(self):
        # If the first line starts with space and there's no previous line to fold into,
        # it should not crash.
        text = " stray\nNORMAL:value"

        lines = server._ics_unfold(text)

        self.assertEqual(lines[-1], "NORMAL:value")


class IcsParseDtTests(unittest.TestCase):
    def test_parses_date_only(self):
        result, all_day = server._ics_parse_dt("20260501", {"VALUE": "DATE"})

        self.assertEqual(result, dt.date(2026, 5, 1))
        self.assertTrue(all_day)

    def test_parses_date_only_without_explicit_value_param(self):
        result, all_day = server._ics_parse_dt("20260501", {})

        self.assertEqual(result, dt.date(2026, 5, 1))
        self.assertTrue(all_day)

    def test_parses_naive_timed(self):
        result, all_day = server._ics_parse_dt("20260501T143000", {})

        self.assertEqual(result, dt.datetime(2026, 5, 1, 14, 30, 0))
        self.assertFalse(all_day)

    def test_parses_utc_timed(self):
        # UTC value should be converted to local naive.
        result, all_day = server._ics_parse_dt("20260501T180000Z", {})

        self.assertIsInstance(result, dt.datetime)
        self.assertIsNone(result.tzinfo)
        self.assertFalse(all_day)


class IcsUnescapeTests(unittest.TestCase):
    def test_unescape_handles_common_sequences(self):
        result = server._ics_unescape("Has\\, comma and\\nnewline\\;semi\\\\back")

        self.assertEqual(result, "Has, comma and newline;semi\\back")


class ParseIcsTests(unittest.TestCase):
    def _parse(self, text: str):
        # parse_ics writes informational stderr lines for skipped recurring events.
        # Silence them so test output stays clean.
        with redirect_stderr(io.StringIO()):
            return server.parse_ics(text)

    def test_parses_events_and_skips_recurring(self):
        text = fixture_text("calendar.ics")

        events = self._parse(text)

        # Recurring event must be skipped.
        summaries = [e["summary"] for e in events]
        self.assertNotIn("Recurring weekly thing", summaries)
        # All-day, multi-day, timed, folded, escaped, past, future remain (7 events)
        self.assertEqual(len(events), 7)

    def test_unfolds_long_summary(self):
        text = fixture_text("calendar.ics")

        events = self._parse(text)

        folded = next(e for e in events if e["summary"].startswith("Long summary"))
        self.assertIn("RFC 5545 says so", folded["summary"])

    def test_unescapes_summary(self):
        text = fixture_text("calendar.ics")

        events = self._parse(text)

        escaped = next(e for e in events if "comma" in e["summary"])
        self.assertEqual(escaped["summary"], "Has, comma and newline")


class EventOccursTodayTests(unittest.TestCase):
    def setUp(self):
        self.today = dt.date(2026, 5, 1)

    def test_all_day_today_with_exclusive_end(self):
        ev = {
            "start": dt.date(2026, 5, 1),
            "end": dt.date(2026, 5, 2),
            "allDay": True,
            "summary": "x",
        }

        self.assertTrue(server._event_occurs_today(ev, self.today))

    def test_all_day_yesterday_excluded(self):
        ev = {
            "start": dt.date(2026, 4, 30),
            "end": dt.date(2026, 5, 1),  # exclusive end
            "allDay": True,
            "summary": "x",
        }

        self.assertFalse(server._event_occurs_today(ev, self.today))

    def test_all_day_multiday_spans_today(self):
        ev = {
            "start": dt.date(2026, 4, 30),
            "end": dt.date(2026, 5, 3),
            "allDay": True,
            "summary": "x",
        }

        self.assertTrue(server._event_occurs_today(ev, self.today))

    def test_all_day_missing_end_treats_as_same_day(self):
        ev = {"start": dt.date(2026, 5, 1), "allDay": True, "summary": "x"}

        self.assertTrue(server._event_occurs_today(ev, self.today))

    def test_timed_event_today_inclusive_end(self):
        ev = {
            "start": dt.datetime(2026, 5, 1, 18, 0),
            "end": dt.datetime(2026, 5, 1, 19, 0),
            "allDay": False,
            "summary": "x",
        }

        self.assertTrue(server._event_occurs_today(ev, self.today))

    def test_future_event_excluded(self):
        ev = {
            "start": dt.date(2026, 6, 1),
            "end": dt.date(2026, 6, 2),
            "allDay": True,
            "summary": "x",
        }

        self.assertFalse(server._event_occurs_today(ev, self.today))


if __name__ == "__main__":
    unittest.main()
