"""Config loader: reads config.json plus optional config.local.json overlay."""

import json
import os
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
LOCAL_CONFIG_PATH = os.path.join(HERE, "config.local.json")

# Extensions we're willing to serve as the page background. The path comes from
# config (trusted input), but keeping this to image types means a typo can't
# turn /api/background into a way to read arbitrary files off the Pi.
BACKGROUND_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"}

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


def resolve_background_image(cfg: dict):
    """Absolute path to the configured background image, or None.

    `background.image` points at a file on the machine running the dashboard
    (the Pi), not a URL. `~` is expanded and relative paths resolve against
    src/. A missing/blank setting, a path that doesn't exist, or a non-image
    extension all return None — a bad path just falls back to the plain dark
    background rather than breaking the page.
    """
    raw = (cfg.get("background") or {}).get("image") or ""
    raw = raw.strip()
    if not raw:
        return None
    path = os.path.expanduser(raw)
    if not os.path.isabs(path):
        path = os.path.join(HERE, path)
    path = os.path.realpath(path)
    if os.path.splitext(path)[1].lower() not in BACKGROUND_IMAGE_EXTS:
        return None
    if not os.path.isfile(path):
        return None
    return path


def _clamped_number(value, low: float, high: float, default: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return default
    return max(low, min(high, float(value)))


def background_settings(cfg: dict) -> dict:
    """Client-facing background block for /api/config: {enabled, dim, blur}.

    The image path itself is deliberately not exposed — the frontend just
    points at /api/background. Values are clamped here so the browser can
    apply them straight into CSS custom properties without re-validating.
    """
    bg = cfg.get("background") or {}
    return {
        "enabled": resolve_background_image(cfg) is not None,
        "dim": _clamped_number(bg.get("dim"), 0.0, 0.95, 0.45),
        "blur": _clamped_number(bg.get("blur"), 0, 60, 18),
    }


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
