"""pi_time: the server clock and UTC offset behind /api/time."""

import calendar
import os
import time
import unittest
from unittest.mock import patch

from tests import helpers  # ensures repo root is on sys.path

import server


def _utc(*fields):
    return calendar.timegm((*fields, 0, 0, 0))


class PiTimeTests(unittest.TestCase):
    def _in_tz(self, tz):
        # POSIX rules strings, so the result doesn't depend on the host's tzdata.
        patch.dict(os.environ, {"TZ": tz}).start()
        self.addCleanup(time.tzset)
        self.addCleanup(patch.stopall)
        time.tzset()

    def test_reports_clock_and_offset(self):
        self._in_tz("MST7")
        now = _utc(2026, 11, 3, 19, 19, 37) + 0.25

        result = server.pi_time(now)

        self.assertEqual(result, {"now": round(now * 1000), "offsetMinutes": -420,
                                  "nextChange": None})

    def test_reports_upcoming_offset_change(self):
        self._in_tz("PST8PDT,M3.2.0,M11.1.0")
        # 1:00 AM PDT on the fall-back night; clocks go back at 2:00 AM PDT.
        now = _utc(2026, 11, 1, 8, 0, 0)

        result = server.pi_time(now)

        self.assertEqual(result["offsetMinutes"], -420)
        self.assertEqual(result["nextChange"],
                         {"at": _utc(2026, 11, 1, 9, 0, 0) * 1000, "offsetMinutes": -480})

    def test_ignores_offset_changes_beyond_two_days(self):
        self._in_tz("PST8PDT,M3.2.0,M11.1.0")

        result = server.pi_time(_utc(2026, 10, 29, 8, 0, 0))

        self.assertIsNone(result["nextChange"])


if __name__ == "__main__":
    unittest.main()
