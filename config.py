"""Config loader: reads config.json plus optional config.local.json overlay."""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
LOCAL_CONFIG_PATH = os.path.join(HERE, "config.local.json")


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
