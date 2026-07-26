"""Tests for the optional per-event countdown icon helper."""

import unittest

from tests import helpers  # ensures repo root is on sys.path

from server import _clean_countdown_icon, _MAX_ICON_LEN


class CleanCountdownIconTests(unittest.TestCase):
    def test_simple_emoji_kept(self):
        self.assertEqual(_clean_countdown_icon("🎄"), "🎄")

    def test_whitespace_stripped(self):
        self.assertEqual(_clean_countdown_icon("  🎂 "), "🎂")

    def test_blank_becomes_empty(self):
        self.assertEqual(_clean_countdown_icon("   "), "")

    def test_empty_string(self):
        self.assertEqual(_clean_countdown_icon(""), "")

    def test_none_becomes_empty(self):
        self.assertEqual(_clean_countdown_icon(None), "")

    def test_non_string_becomes_empty(self):
        self.assertEqual(_clean_countdown_icon(123), "")

    def test_zwj_sequence_within_limit(self):
        # A family emoji (ZWJ sequence) is several code points but still one glyph.
        family = "👨‍👩‍👧"
        self.assertLessEqual(len(family), _MAX_ICON_LEN)
        self.assertEqual(_clean_countdown_icon(family), family)


if __name__ == "__main__":
    unittest.main()
