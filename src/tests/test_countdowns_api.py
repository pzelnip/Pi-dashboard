"""Tests for countdown CRUD operations via config.local.json."""

import json
import os
import tempfile
import unittest
from unittest.mock import patch

from tests import helpers  # ensures repo root is on sys.path

import config


class LoadLocalConfigTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self._local_path = os.path.join(self._tmpdir.name, "config.local.json")

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_returns_empty_dict_when_no_file(self):
        with patch.object(config, "LOCAL_CONFIG_PATH", self._local_path):
            result = config.load_local_config()
        self.assertEqual(result, {})

    def test_reads_existing_file(self):
        with open(self._local_path, "w") as f:
            json.dump({"countdowns": [{"date": "2026-12-25", "title": "Xmas"}]}, f)
        with patch.object(config, "LOCAL_CONFIG_PATH", self._local_path):
            result = config.load_local_config()
        self.assertEqual(result["countdowns"], [{"date": "2026-12-25", "title": "Xmas"}])


class SaveLocalConfigTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self._local_path = os.path.join(self._tmpdir.name, "config.local.json")

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_creates_file_when_absent(self):
        with patch.object(config, "LOCAL_CONFIG_PATH", self._local_path):
            config.save_local_config({"countdowns": [{"date": "2026-01-01", "title": "NY"}]})
        with open(self._local_path) as f:
            data = json.load(f)
        self.assertEqual(data["countdowns"], [{"date": "2026-01-01", "title": "NY"}])

    def test_overwrites_existing_file(self):
        with open(self._local_path, "w") as f:
            json.dump({"old": True}, f)
        with patch.object(config, "LOCAL_CONFIG_PATH", self._local_path):
            config.save_local_config({"countdowns": []})
        with open(self._local_path) as f:
            data = json.load(f)
        self.assertEqual(data, {"countdowns": []})

    def test_atomic_write_does_not_leave_tmp(self):
        with patch.object(config, "LOCAL_CONFIG_PATH", self._local_path):
            config.save_local_config({"x": 1})
        # .tmp file should not exist after write completes
        self.assertFalse(os.path.exists(self._local_path + ".tmp"))


if __name__ == "__main__":
    unittest.main()
