"""Tests for load_config deep-merge behavior and _merge_dicts."""

import json
import os
import tempfile
import unittest
from unittest.mock import patch

import server


class MergeDictsTests(unittest.TestCase):
    def test_overlay_replaces_scalars(self):
        result = server._merge_dicts({"a": 1, "b": 2}, {"b": 3})

        self.assertEqual(result, {"a": 1, "b": 3})

    def test_overlay_replaces_lists(self):
        # Lists are replaced wholesale, not merged.
        result = server._merge_dicts({"items": [1, 2, 3]}, {"items": [9]})

        self.assertEqual(result, {"items": [9]})

    def test_nested_dicts_merge_recursively(self):
        base = {"weather": {"label": "Victoria", "latitude": 48.4}}
        overlay = {"weather": {"latitude": 50.0}}

        result = server._merge_dicts(base, overlay)

        self.assertEqual(result, {"weather": {"label": "Victoria", "latitude": 50.0}})

    def test_overlay_dict_replaces_non_dict(self):
        # If base[key] is not a dict, overlay's dict wins outright.
        result = server._merge_dicts({"weather": "old"}, {"weather": {"label": "x"}})

        self.assertEqual(result, {"weather": {"label": "x"}})

    def test_does_not_mutate_inputs(self):
        base = {"a": {"b": 1}}
        overlay = {"a": {"b": 2}}

        server._merge_dicts(base, overlay)

        self.assertEqual(base, {"a": {"b": 1}})
        self.assertEqual(overlay, {"a": {"b": 2}})


class LoadConfigTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self._cfg_path = os.path.join(self._tmpdir.name, "config.json")
        self._local_path = os.path.join(self._tmpdir.name, "config.local.json")

    def tearDown(self):
        self._tmpdir.cleanup()

    def _write(self, path: str, payload: dict) -> None:
        with open(path, "w") as f:
            json.dump(payload, f)

    def test_loads_base_config_when_no_local(self):
        self._write(self._cfg_path, {"weather": {"label": "Victoria"}})

        with patch.object(server, "CONFIG_PATH", self._cfg_path), patch.object(
            server, "LOCAL_CONFIG_PATH", self._local_path
        ):
            cfg = server.load_config()

        self.assertEqual(cfg, {"weather": {"label": "Victoria"}})

    def test_local_config_deep_merges_over_base(self):
        self._write(
            self._cfg_path,
            {
                "weather": {"label": "Victoria", "latitude": 48.4, "longitude": -123.3},
                "rss": [{"name": "A", "url": "https://a"}],
            },
        )
        self._write(
            self._local_path,
            {
                "weather": {"latitude": 49.0},  # only override one field
                "calendar": {"urls": ["https://cal"]},  # adds new key
            },
        )

        with patch.object(server, "CONFIG_PATH", self._cfg_path), patch.object(
            server, "LOCAL_CONFIG_PATH", self._local_path
        ):
            cfg = server.load_config()

        # Latitude overridden, label preserved from base.
        self.assertEqual(cfg["weather"]["latitude"], 49.0)
        self.assertEqual(cfg["weather"]["label"], "Victoria")
        self.assertEqual(cfg["weather"]["longitude"], -123.3)
        # New top-level key added.
        self.assertEqual(cfg["calendar"], {"urls": ["https://cal"]})
        # rss list untouched.
        self.assertEqual(cfg["rss"], [{"name": "A", "url": "https://a"}])

    def test_local_list_replaces_base_list(self):
        self._write(self._cfg_path, {"rss": [{"name": "A"}, {"name": "B"}]})
        self._write(self._local_path, {"rss": [{"name": "Z"}]})

        with patch.object(server, "CONFIG_PATH", self._cfg_path), patch.object(
            server, "LOCAL_CONFIG_PATH", self._local_path
        ):
            cfg = server.load_config()

        self.assertEqual(cfg["rss"], [{"name": "Z"}])


if __name__ == "__main__":
    unittest.main()
