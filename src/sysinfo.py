"""Host health metrics for the debug overlay: load, memory, CPU temperature.

A struggling Pi (a pegged core, heavy swapping, thermal throttling) otherwise
only shows up by ssh'ing in and running `top`. Each reader returns None when
the metric isn't available on this platform — memory and temperature come
from Linux /proc and /sys, so on a Mac dev machine only load is reported.
"""

import os

MEMINFO_PATH = "/proc/meminfo"
THERMAL_PATH = "/sys/class/thermal/thermal_zone0/temp"


def system_load():
    """1/5/15-minute load averages plus the core count to judge them by."""
    try:
        one, five, fifteen = os.getloadavg()
    except (OSError, AttributeError):  # AttributeError: no getloadavg (Windows)
        return None
    return {
        "one": round(one, 2),
        "five": round(five, 2),
        "fifteen": round(fifteen, 2),
        "cpus": os.cpu_count() or 1,
    }


def memory_usage():
    """RAM and swap in MB, from /proc/meminfo.

    MemAvailable (not MemFree) is what `top` calls "avail Mem": free memory
    plus cache the kernel can reclaim, i.e. what's actually left to use.
    """
    fields = {}
    try:
        with open(MEMINFO_PATH) as f:
            for line in f:
                key, _, rest = line.partition(":")
                parts = rest.split()
                if parts:
                    fields[key] = int(parts[0])  # kB
    except (OSError, ValueError):
        return None
    if "MemTotal" not in fields or "MemAvailable" not in fields:
        return None
    swap_total = fields.get("SwapTotal", 0)
    swap_free = fields.get("SwapFree", swap_total)
    return {
        "totalMb": round(fields["MemTotal"] / 1024),
        "availableMb": round(fields["MemAvailable"] / 1024),
        "swapTotalMb": round(swap_total / 1024),
        "swapUsedMb": round((swap_total - swap_free) / 1024),
    }


def cpu_temperature():
    """SoC temperature in °C (the sysfs file holds millidegrees)."""
    try:
        with open(THERMAL_PATH) as f:
            return round(int(f.read().strip()) / 1000, 1)
    except (OSError, ValueError):
        return None


def system_health() -> dict:
    return {
        "load": system_load(),
        "memory": memory_usage(),
        "cpuTempC": cpu_temperature(),
    }
