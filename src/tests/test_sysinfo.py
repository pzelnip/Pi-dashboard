"""Tests for the host health metrics shown in the debug overlay."""

import os
import tempfile
import unittest
from unittest.mock import patch

from tests import helpers  # ensures repo root is on sys.path

import sysinfo

# Trimmed /proc/meminfo from the Pi 3B+ while Chromium was swapping.
MEMINFO = """\
MemTotal:         927744 kB
MemFree:           48432 kB
MemAvailable:     267264 kB
Buffers:           20480 kB
Cached:           396288 kB
SwapTotal:        926720 kB
SwapFree:         226304 kB
"""


class TempFileMixin:
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._tmpdir.cleanup()

    def write(self, name, text):
        path = os.path.join(self._tmpdir.name, name)
        with open(path, "w") as f:
            f.write(text)
        return path

    def missing(self):
        return os.path.join(self._tmpdir.name, "does-not-exist")


class SystemLoadTests(unittest.TestCase):
    def test_rounds_averages_and_reports_cores(self):
        with patch("sysinfo.os.getloadavg", return_value=(3.4712, 1.8666, 0.7349)), \
             patch("sysinfo.os.cpu_count", return_value=4):
            self.assertEqual(
                sysinfo.system_load(),
                {"one": 3.47, "five": 1.87, "fifteen": 0.73, "cpus": 4},
            )

    def test_unknown_core_count_falls_back_to_one(self):
        with patch("sysinfo.os.getloadavg", return_value=(0.5, 0.5, 0.5)), \
             patch("sysinfo.os.cpu_count", return_value=None):
            self.assertEqual(sysinfo.system_load()["cpus"], 1)

    def test_unavailable_returns_none(self):
        with patch("sysinfo.os.getloadavg", side_effect=OSError):
            self.assertIsNone(sysinfo.system_load())

    def test_missing_getloadavg_returns_none(self):
        with patch("sysinfo.os.getloadavg", side_effect=AttributeError):
            self.assertIsNone(sysinfo.system_load())


class MemoryUsageTests(TempFileMixin, unittest.TestCase):
    def test_parses_meminfo_in_mb(self):
        with patch("sysinfo.MEMINFO_PATH", self.write("meminfo", MEMINFO)):
            self.assertEqual(
                sysinfo.memory_usage(),
                {"totalMb": 906, "availableMb": 261, "swapTotalMb": 905, "swapUsedMb": 684},
            )

    def test_no_swap_reports_zero(self):
        text = "MemTotal: 1024000 kB\nMemAvailable: 512000 kB\n"
        with patch("sysinfo.MEMINFO_PATH", self.write("meminfo", text)):
            mem = sysinfo.memory_usage()
        self.assertEqual((mem["swapTotalMb"], mem["swapUsedMb"]), (0, 0))

    def test_missing_file_returns_none(self):
        with patch("sysinfo.MEMINFO_PATH", self.missing()):
            self.assertIsNone(sysinfo.memory_usage())

    def test_missing_required_fields_returns_none(self):
        with patch("sysinfo.MEMINFO_PATH", self.write("meminfo", "MemTotal: 1024 kB\n")):
            self.assertIsNone(sysinfo.memory_usage())


class CpuTemperatureTests(TempFileMixin, unittest.TestCase):
    def test_converts_millidegrees(self):
        with patch("sysinfo.THERMAL_PATH", self.write("temp", "61224\n")):
            self.assertEqual(sysinfo.cpu_temperature(), 61.2)

    def test_missing_file_returns_none(self):
        with patch("sysinfo.THERMAL_PATH", self.missing()):
            self.assertIsNone(sysinfo.cpu_temperature())

    def test_garbage_returns_none(self):
        with patch("sysinfo.THERMAL_PATH", self.write("temp", "n/a\n")):
            self.assertIsNone(sysinfo.cpu_temperature())


if __name__ == "__main__":
    unittest.main()
