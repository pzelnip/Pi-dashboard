"""Tests for countdown date validation including annual (MM-DD) format."""

import unittest

from tests import helpers  # ensures repo root is on sys.path

from server import _valid_countdown_date


class ValidCountdownDateTests(unittest.TestCase):
    def test_standard_date_valid(self):
        self.assertTrue(_valid_countdown_date("2026-12-25"))

    def test_standard_date_leap_day(self):
        self.assertTrue(_valid_countdown_date("2024-02-29"))

    def test_standard_date_invalid_month(self):
        self.assertFalse(_valid_countdown_date("2026-13-01"))

    def test_standard_date_invalid_day(self):
        self.assertFalse(_valid_countdown_date("2026-02-30"))

    def test_annual_date_valid(self):
        self.assertTrue(_valid_countdown_date("12-25"))

    def test_annual_date_feb_29(self):
        self.assertTrue(_valid_countdown_date("02-29"))

    def test_annual_date_jan_01(self):
        self.assertTrue(_valid_countdown_date("01-01"))

    def test_annual_date_invalid_month(self):
        self.assertFalse(_valid_countdown_date("13-01"))

    def test_annual_date_invalid_day(self):
        self.assertFalse(_valid_countdown_date("02-30"))

    def test_annual_date_month_zero(self):
        self.assertFalse(_valid_countdown_date("00-15"))

    def test_annual_date_day_zero(self):
        self.assertFalse(_valid_countdown_date("06-00"))

    def test_empty_string(self):
        self.assertFalse(_valid_countdown_date(""))

    def test_garbage(self):
        self.assertFalse(_valid_countdown_date("not-a-date"))

    def test_partial_format(self):
        self.assertFalse(_valid_countdown_date("2026-12"))


if __name__ == "__main__":
    unittest.main()
