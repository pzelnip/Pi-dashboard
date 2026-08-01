"""Tests for background image resolution and the /api/config background block."""

import os
import tempfile
import unittest
from unittest.mock import patch

from tests import helpers  # ensures repo root is on sys.path

import config


class ResolveBackgroundImageTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        # realpath: macOS temp dirs are symlinked (/var -> /private/var) and
        # resolve_background_image realpaths what it returns.
        self.tmp = os.path.realpath(self._tmpdir.name)
        self.img = os.path.join(self.tmp, "wallpaper.jpg")
        with open(self.img, "wb") as f:
            f.write(b"\xff\xd8\xff")  # not a real JPEG; only the path matters

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_absolute_path_resolves(self):
        cfg = {"background": {"image": self.img}}
        self.assertEqual(config.resolve_background_image(cfg), self.img)

    def test_missing_section_returns_none(self):
        self.assertIsNone(config.resolve_background_image({}))

    def test_blank_and_whitespace_return_none(self):
        self.assertIsNone(config.resolve_background_image({"background": {"image": ""}}))
        self.assertIsNone(config.resolve_background_image({"background": {"image": "   "}}))

    def test_null_image_returns_none(self):
        self.assertIsNone(config.resolve_background_image({"background": {"image": None}}))

    def test_nonexistent_path_returns_none(self):
        cfg = {"background": {"image": os.path.join(self.tmp, "nope.png")}}
        self.assertIsNone(config.resolve_background_image(cfg))

    def test_non_image_extension_returns_none(self):
        secret = os.path.join(self.tmp, "secrets.json")
        with open(secret, "w") as f:
            f.write("{}")
        cfg = {"background": {"image": secret}}
        self.assertIsNone(config.resolve_background_image(cfg))

    def test_extension_match_is_case_insensitive(self):
        upper = os.path.join(self.tmp, "shot.PNG")
        with open(upper, "wb") as f:
            f.write(b"x")
        cfg = {"background": {"image": upper}}
        self.assertEqual(config.resolve_background_image(cfg), upper)

    def test_relative_path_resolves_against_src_dir(self):
        with patch.object(config, "HERE", self.tmp):
            cfg = {"background": {"image": "wallpaper.jpg"}}
            self.assertEqual(config.resolve_background_image(cfg), self.img)

    def test_tilde_is_expanded(self):
        with patch.dict(os.environ, {"HOME": self.tmp}):
            cfg = {"background": {"image": "~/wallpaper.jpg"}}
            self.assertEqual(config.resolve_background_image(cfg), self.img)


class BackgroundSettingsTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = os.path.realpath(self._tmpdir.name)
        self.img = os.path.join(self.tmp, "wallpaper.png")
        with open(self.img, "wb") as f:
            f.write(b"x")

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_disabled_when_no_image(self):
        settings = config.background_settings({})
        self.assertFalse(settings["enabled"])
        self.assertEqual(settings["dim"], 0.45)
        self.assertEqual(settings["blur"], 18)

    def test_enabled_with_custom_values(self):
        cfg = {"background": {"image": self.img, "dim": 0.7, "blur": 30}}
        self.assertEqual(
            config.background_settings(cfg),
            {"enabled": True, "dim": 0.7, "blur": 30.0},
        )

    def test_out_of_range_values_are_clamped(self):
        cfg = {"background": {"image": self.img, "dim": 5, "blur": -3}}
        settings = config.background_settings(cfg)
        self.assertEqual(settings["dim"], 0.95)
        self.assertEqual(settings["blur"], 0)

    def test_non_numeric_values_fall_back_to_defaults(self):
        cfg = {"background": {"image": self.img, "dim": "dark", "blur": None}}
        settings = config.background_settings(cfg)
        self.assertEqual(settings["dim"], 0.45)
        self.assertEqual(settings["blur"], 18)

    def test_configured_but_missing_file_is_disabled(self):
        cfg = {"background": {"image": "/no/such/image.jpg", "dim": 0.6}}
        settings = config.background_settings(cfg)
        self.assertFalse(settings["enabled"])
        # dim/blur are still reported; they just don't get used by the client.
        self.assertEqual(settings["dim"], 0.6)


if __name__ == "__main__":
    unittest.main()
