"""Tests for countdown CRUD operations via config.local.json."""

import json
import os
import tempfile
import threading
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


class UpdateCountdownsTests(unittest.TestCase):
    BASE = [{"date": "2026-12-25", "title": "Xmas"}]

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        cfg_path = os.path.join(self._tmpdir.name, "config.json")
        self._local_path = os.path.join(self._tmpdir.name, "config.local.json")
        with open(cfg_path, "w") as f:
            json.dump({"countdowns": self.BASE, "other": 1}, f)
        with open(self._local_path, "w") as f:
            json.dump({"keep": True}, f)
        patch.object(config, "CONFIG_PATH", cfg_path).start()
        patch.object(config, "LOCAL_CONFIG_PATH", self._local_path).start()
        self.addCleanup(patch.stopall)

    def _local(self):
        with open(self._local_path) as f:
            return json.load(f)

    def test_change_starts_from_effective_list_and_is_saved_locally(self):
        new = {"date": "2027-01-01", "title": "NY"}

        result = config.update_countdowns(lambda cds: cds + [new])

        self.assertEqual(result, self.BASE + [new])
        self.assertEqual(self._local(), {"keep": True, "countdowns": self.BASE + [new]})

    def test_value_error_aborts_without_writing(self):
        def reject(cds):
            raise ValueError("countdown not found")

        with self.assertRaisesRegex(ValueError, "not found"):
            config.update_countdowns(reject)
        self.assertEqual(self._local(), {"keep": True})

    def test_concurrent_updates_keep_both_changes(self):
        # Each change waits until the other has had a chance to start; without
        # the lock spanning read-modify-write, one append would be lost.
        started = threading.Barrier(2, timeout=0.2)

        def append(title):
            def change(cds):
                try:
                    started.wait()
                except threading.BrokenBarrierError:
                    pass  # serialized: the other update is waiting on the lock
                return cds + [{"date": "2027-01-01", "title": title}]
            return change

        threads = [threading.Thread(target=config.update_countdowns, args=(append(t),))
                   for t in ("A", "B")]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)

        titles = sorted(c["title"] for c in self._local()["countdowns"])
        self.assertEqual(titles, ["A", "B", "Xmas"])


if __name__ == "__main__":
    unittest.main()
