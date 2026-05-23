"""Config loader: reads config.json plus optional config.local.json overlay."""

import json
import os
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
LOCAL_CONFIG_PATH = os.path.join(HERE, "config.local.json")

# Serialize writes to config.local.json so concurrent requests don't clobber.
_local_config_lock = threading.Lock()


def _merge_dicts(base: dict, overlay: dict) -> dict:
    """Recursively merge overlay into base. Lists and scalars in overlay replace base."""
    out = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge_dicts(out[key], value)
        else:
            out[key] = value
    return out


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        cfg = json.load(f)
    if os.path.isfile(LOCAL_CONFIG_PATH):
        with open(LOCAL_CONFIG_PATH) as f:
            cfg = _merge_dicts(cfg, json.load(f))
    return cfg


def load_local_config() -> dict:
    """Read config.local.json or return empty dict if it doesn't exist."""
    if os.path.isfile(LOCAL_CONFIG_PATH):
        with open(LOCAL_CONFIG_PATH) as f:
            return json.load(f)
    return {}


def save_local_config(cfg: dict) -> None:
    """Atomically write config.local.json (thread-safe)."""
    with _local_config_lock:
        tmp = LOCAL_CONFIG_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cfg, f, indent=2)
            f.write("\n")
        os.replace(tmp, LOCAL_CONFIG_PATH)
