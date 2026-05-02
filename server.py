#!/usr/bin/env python3
"""Dashboard server: serves ./public and proxies three API endpoints."""

import copy
import hashlib
import json
import mimetypes
import os
import platform
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(HERE, "public")
PUBLIC_REAL = os.path.realpath(PUBLIC_DIR)
CONFIG_PATH = os.path.join(HERE, "config.json")
LOCAL_CONFIG_PATH = os.path.join(HERE, "config.local.json")
PORT = int(os.environ.get("DASHBOARD_PORT", "8080"))
USER_AGENT = "Mozilla/5.0 (compatible; pi-dashboard/1.0)"


def _current_version() -> str:
    try:
        sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=HERE,
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        return sha.decode().strip()
    except Exception:
        return str(int(time.time()))


def _latest_commit() -> tuple[float | None, str]:
    try:
        out = subprocess.check_output(
            ["git", "log", "-1", "--format=%ct%n%s", "HEAD"],
            cwd=HERE,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).decode().strip().split("\n", 1)
        return float(out[0]), (out[1] if len(out) > 1 else "")
    except Exception:
        return None, ""


VERSION = _current_version()
LATEST_COMMIT_AT, LATEST_COMMIT_SUBJECT = _latest_commit()
SERVER_STARTED_AT = time.time()

_cache: dict[str, tuple[float, bytes]] = {}
_cache_lock = threading.Lock()

# Held while update-dashboard.sh is running so concurrent POST /api/update
# requests don't fan out into multiple git pull / restart attempts.
_update_lock = threading.Lock()
UPDATE_LOG_PATH = os.path.join(HERE, "update.log")
UPDATE_SCRIPT_PATH = os.path.join(HERE, "update-dashboard.sh")


def _merge_dicts(base: dict, overlay: dict) -> dict:
    """Recursively merge overlay into base. Lists and scalars in overlay replace base."""
    out = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge_dicts(out[key], value)
        else:
            out[key] = value
    return out


# Built-in safe defaults used when config.json itself is unreadable / invalid.
# These match the public-facing keys the request handlers and the frontend
# read; values are intentionally minimal so the dashboard starts but flags
# missing data (no weather coords, no feeds) rather than crashing.
_DEFAULT_CONFIG: dict = {
    "weather": {},
    "nhl": {"favorites": []},
    "countdowns": [],
    "rss": [],
    "rotation": {
        "rssSeconds": 30,
        "weatherPanelSeconds": 10,
        "nhlPanelSeconds": 10,
    },
    "calendar": {"urls": []},
}


def _warn(msg: str) -> None:
    sys.stderr.write(f"[config] {msg}\n")


def _coerce_str_list(value, key: str) -> list[str]:
    """Coerce ``value`` to a list[str]. Logs and drops bad entries.

    A bare string is treated as a single-element list (common slip-up in
    hand-edited JSON, e.g. ``"calendar": {"urls": "https://..."}``).
    """
    if value is None:
        return []
    if isinstance(value, str):
        _warn(f"{key} should be a list, got string; coercing to single-element list")
        return [value]
    if not isinstance(value, list):
        _warn(f"{key} should be a list, got {type(value).__name__}; ignoring")
        return []
    out: list[str] = []
    for i, item in enumerate(value):
        if isinstance(item, str):
            out.append(item)
        else:
            _warn(f"{key}[{i}] should be a string, got {type(item).__name__}; dropping")
    return out


def _coerce_positive_number(value, key: str, default):
    """Coerce ``value`` to a positive number. Returns ``default`` on failure."""
    if isinstance(value, bool):  # bool is a subclass of int — exclude it
        _warn(f"{key} should be a number, got bool; using default {default}")
        return default
    if isinstance(value, (int, float)):
        if value > 0:
            return value
        _warn(f"{key} should be > 0, got {value}; using default {default}")
        return default
    if isinstance(value, str):
        try:
            num = float(value)
        except ValueError:
            _warn(f"{key} should be a number, got string {value!r}; using default {default}")
            return default
        if num > 0:
            _warn(f"{key} should be a number, got string {value!r}; coercing to {num}")
            return num
        _warn(f"{key} should be > 0, got {num}; using default {default}")
        return default
    _warn(f"{key} should be a number, got {type(value).__name__}; using default {default}")
    return default


def validate_config(cfg) -> dict:
    """Normalize ``cfg`` to the shape the rest of the server (and frontend) expect.

    Coerces what is reasonable, drops what isn't, and logs each correction so
    a bad config deploy is visible in journalctl without crashing the server.
    Always returns a dict with the keys the handlers access.
    """
    if not isinstance(cfg, dict):
        _warn(f"top-level config must be an object, got {type(cfg).__name__}; using defaults")
        return copy.deepcopy(_DEFAULT_CONFIG)

    out: dict = {}

    # weather: pass through dict; lat/lon validated lazily in the handler
    # (handler already checks for None — keep that behaviour). Just ensure
    # it's a dict so .get() doesn't AttributeError.
    weather = cfg.get("weather")
    if weather is None:
        out["weather"] = {}
    elif isinstance(weather, dict):
        out["weather"] = weather
    else:
        _warn(f"weather should be an object, got {type(weather).__name__}; ignoring")
        out["weather"] = {}

    # nhl.favorites: list of strings
    nhl = cfg.get("nhl")
    if not isinstance(nhl, dict):
        if nhl is not None:
            _warn(f"nhl should be an object, got {type(nhl).__name__}; ignoring")
        nhl = {}
    out["nhl"] = {"favorites": _coerce_str_list(nhl.get("favorites"), "nhl.favorites")}
    # Preserve any other nhl keys the user set so we don't silently drop forward-compat fields.
    for k, v in nhl.items():
        if k != "favorites":
            out["nhl"].setdefault(k, v)

    # countdowns: list of {date, title} objects
    countdowns_raw = cfg.get("countdowns")
    countdowns: list[dict] = []
    if countdowns_raw is None:
        pass
    elif not isinstance(countdowns_raw, list):
        _warn(f"countdowns should be a list, got {type(countdowns_raw).__name__}; ignoring")
    else:
        for i, entry in enumerate(countdowns_raw):
            if not isinstance(entry, dict):
                _warn(f"countdowns[{i}] should be an object, got {type(entry).__name__}; dropping")
                continue
            date = entry.get("date")
            title = entry.get("title")
            if not isinstance(date, str) or not isinstance(title, str):
                _warn(f"countdowns[{i}] needs string date+title; dropping {entry!r}")
                continue
            countdowns.append({"date": date, "title": title})
    out["countdowns"] = countdowns

    # rss: list of {name, url} objects
    rss_raw = cfg.get("rss")
    rss_out: list[dict] = []
    if rss_raw is None:
        pass
    elif not isinstance(rss_raw, list):
        _warn(f"rss should be a list, got {type(rss_raw).__name__}; ignoring")
    else:
        for i, entry in enumerate(rss_raw):
            if not isinstance(entry, dict):
                _warn(f"rss[{i}] should be an object, got {type(entry).__name__}; dropping")
                continue
            url = entry.get("url")
            if not isinstance(url, str) or not url:
                _warn(f"rss[{i}] missing/non-string url; dropping {entry!r}")
                continue
            name = entry.get("name")
            if not isinstance(name, str):
                name = url
            rss_out.append({"name": name, "url": url})
    out["rss"] = rss_out

    # rotation: numbers > 0; fall back per-key
    rotation_raw = cfg.get("rotation")
    if not isinstance(rotation_raw, dict):
        if rotation_raw is not None:
            _warn(f"rotation should be an object, got {type(rotation_raw).__name__}; ignoring")
        rotation_raw = {}
    rotation_out: dict = {}
    for key, default in _DEFAULT_CONFIG["rotation"].items():
        if key in rotation_raw:
            rotation_out[key] = _coerce_positive_number(rotation_raw[key], f"rotation.{key}", default)
        else:
            rotation_out[key] = default
    out["rotation"] = rotation_out

    # calendar.urls: list of strings
    calendar_raw = cfg.get("calendar")
    if calendar_raw is None:
        out["calendar"] = {"urls": []}
    elif not isinstance(calendar_raw, dict):
        _warn(f"calendar should be an object, got {type(calendar_raw).__name__}; ignoring")
        out["calendar"] = {"urls": []}
    else:
        out["calendar"] = {"urls": _coerce_str_list(calendar_raw.get("urls"), "calendar.urls")}

    return out


def _read_json_file(path: str, *, warn_if_missing: bool = False) -> dict | None:
    """Read+parse a JSON file. Returns None on any failure (with stderr log).

    When ``warn_if_missing`` is True, a missing file is also logged via ``_warn``
    (use this for the primary config so a missing file is visible in journalctl).
    """
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        if warn_if_missing:
            _warn(f"{path} not found; using defaults")
        return None
    except (OSError, json.JSONDecodeError) as e:
        _warn(f"failed to load {path}: {e}")
        return None
    if not isinstance(data, dict):
        _warn(f"{path} top level must be an object, got {type(data).__name__}; ignoring")
        return None
    return data


def load_config() -> dict:
    """Load and validate the merged config. Never raises.

    On a malformed ``config.json`` we fall back to built-in defaults so the
    server still starts. On a malformed ``config.local.json`` we keep the
    main file's values. Either way, ``validate_config`` is the last step and
    guarantees the returned shape is safe for the handlers and the frontend.
    """
    base = _read_json_file(CONFIG_PATH, warn_if_missing=True)
    if base is None:
        # Deep-copy the default so callers can't mutate our singleton.
        base = copy.deepcopy(_DEFAULT_CONFIG)

    if os.path.isfile(LOCAL_CONFIG_PATH):
        overlay = _read_json_file(LOCAL_CONFIG_PATH)
        if overlay is not None:
            try:
                base = _merge_dicts(base, overlay)
            except Exception as e:
                _warn(f"failed to merge {LOCAL_CONFIG_PATH}: {e}; using base config only")

    return validate_config(base)


def fetch_cached(url: str, ttl_seconds: int) -> bytes:
    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and hit[0] > now:
            return hit[1]

    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read()
    except Exception:
        # On network failure, return any cached body we still have (even if expired).
        # The frontend stays useful when upstream APIs blip.
        if hit:
            return hit[1]
        raise

    with _cache_lock:
        # Amortized eviction: drop entries whose TTL expired more than a day ago.
        # Keeps the stale-fallback window generous while preventing unbounded growth
        # over long uptimes (NHL adds two new keys per calendar day).
        cutoff = now - 86400
        for u in [u for u, (exp, _) in _cache.items() if exp < cutoff]:
            del _cache[u]
        _cache[url] = (now + ttl_seconds, body)
    return body


# ---------- NHL ----------

PERIOD_ORDINAL = {1: "1st", 2: "2nd", 3: "3rd", 4: "OT", 5: "2OT", 6: "3OT"}


def _status_text(game: dict) -> str:
    state = game.get("gameState", "")
    pd = game.get("periodDescriptor") or {}
    period_num = pd.get("number")
    period_type = pd.get("periodType", "REG")
    clock = game.get("clock") or {}
    time_remaining = clock.get("timeRemaining")
    in_intermission = clock.get("inIntermission", False)

    if state in ("OFF", "FINAL"):
        if period_type == "OT":
            return "Final/OT"
        if period_type == "SO":
            return "Final/SO"
        return "Final"

    if state in ("LIVE", "CRIT"):
        if period_num is None:
            return ""  # pre-game LIVE transition: let the frontend show start time
        ord_label = PERIOD_ORDINAL.get(period_num, f"P{period_num}")
        if in_intermission:
            return f"End of {ord_label}"
        if time_remaining:
            return f"{ord_label} · {time_remaining}"
        return ord_label

    return ""  # scheduled / pre-game: frontend will show start time instead


def _team(t: dict, favorites: set[str] | None = None) -> dict:
    abbrev = t.get("abbrev", "")
    return {
        "abbrev": abbrev,
        "name": (t.get("commonName") or {}).get("default", ""),
        "score": t.get("score"),
        "logo": t.get("logo", ""),
        "isFavorite": bool(favorites) and abbrev in favorites,
    }


def _series_text(s: dict | None) -> str:
    if not s:
        return ""
    top = s.get("topSeedTeamAbbrev")
    top_w = s.get("topSeedWins", 0)
    bot = s.get("bottomSeedTeamAbbrev")
    bot_w = s.get("bottomSeedWins", 0)
    needed = s.get("neededToWin", 4)
    game_num = s.get("gameNumberOfSeries", "?")
    if top_w == 0 and bot_w == 0:
        return f"Game {game_num}"
    if top_w >= needed:
        return f"Game {game_num} ({top} won {top_w}-{bot_w}) ✅"
    if bot_w >= needed:
        return f"Game {game_num} ({bot} won {bot_w}-{top_w}) ✅"
    if top_w > bot_w:
        return f"Game {game_num} ({top} leads {top_w}-{bot_w})"
    if bot_w > top_w:
        return f"Game {game_num} ({bot} leads {bot_w}-{top_w})"
    return f"Game {game_num} (tied {top_w}-{bot_w})"


def fetch_nhl(date: str | None, favorites: list[str]) -> list[dict]:
    # Use the Pi's local date when no explicit date is passed. The NHL API's
    # /schedule/now endpoint lags the calendar rollover, so we anchor on the
    # server clock instead.
    target_date = date or dt.date.today().isoformat()
    url = f"https://api-web.nhle.com/v1/schedule/{target_date}"
    # 20s TTL is shorter than the client's 30s poll so live-game state changes
    # (period clock, score) reach the kiosk on every poll without re-fetching.
    raw = fetch_cached(url, ttl_seconds=20)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("upstream returned non-JSON response (got HTML?)")
    weeks = data.get("gameWeek", [])

    fav_set = set(favorites or [])
    games_out = []
    for week in weeks:
        if week.get("date") != target_date:
            continue
        for game in week.get("games", []):
            home = game.get("homeTeam", {})
            away = game.get("awayTeam", {})
            is_fav = bool(fav_set) and (
                home.get("abbrev") in fav_set or away.get("abbrev") in fav_set
            )
            games_out.append(
                {
                    "home": _team(home, fav_set),
                    "away": _team(away, fav_set),
                    "state": game.get("gameState", ""),
                    "startTime": game.get("startTimeUTC", ""),
                    "statusText": _status_text(game),
                    "seriesText": _series_text(game.get("seriesStatus")),
                    "isFavorite": is_fav,
                }
            )
    return games_out


# ---------- Weather ----------


def fetch_weather(lat: float, lon: float) -> dict:
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m",
        "daily": "temperature_2m_max,temperature_2m_min,weather_code",
        "forecast_days": 4,
        "timezone": "auto",
    }
    url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params)
    raw = fetch_cached(url, ttl_seconds=600)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("upstream returned non-JSON response (got HTML?)")
    return {
        "current": data.get("current", {}),
        "daily": data.get("daily", {}),
        "units": {
            "current": data.get("current_units", {}),
            "daily": data.get("daily_units", {}),
        },
    }


# ---------- RSS ----------

ATOM_NS = "{http://www.w3.org/2005/Atom}"
MEDIA_NS = "{http://search.yahoo.com/mrss/}"

_IMG_SRC_RE = re.compile(r"""<img\b[^>]*\bsrc=["']([^"']+)["']""", re.IGNORECASE)


def _extract_image(el, html_fields: list[str]) -> str:
    # 1. Yahoo media namespace: <media:thumbnail url="..."> or <media:content url="...">
    for tag in ("thumbnail", "content"):
        m = el.find(f"{MEDIA_NS}{tag}")
        if m is not None:
            url = m.get("url") or m.get("href")
            if url:
                return url

    # 2. <enclosure url="..." type="image/..."> (RSS 2.0)
    enc = el.find("enclosure")
    if enc is not None and (enc.get("type") or "").startswith("image/"):
        url = enc.get("url")
        if url:
            return url

    # 3. First <img> inside an HTML-bearing field like description/summary/content.
    for field in html_fields:
        html = el.findtext(field)
        if html:
            match = _IMG_SRC_RE.search(html)
            if match:
                return match.group(1)

    return ""


def _extract_feed_image(root) -> str:
    # RSS 2.0: <rss><channel><image><url>...</url></image>
    ch = root.find("channel")
    if ch is not None:
        img = ch.find("image")
        if img is not None:
            url = (img.findtext("url") or "").strip()
            if url:
                return url
        # Also try <itunes:image href="..."> and channel-level <media:thumbnail>
        for tag in (f"{MEDIA_NS}thumbnail", f"{MEDIA_NS}image"):
            m = ch.find(tag)
            if m is not None:
                url = m.get("url") or m.get("href") or ""
                if url:
                    return url

    # Atom: <feed><logo> (preferred) or <icon>
    for tag in ("logo", "icon"):
        el = root.find(f"{ATOM_NS}{tag}")
        if el is not None and el.text:
            return el.text.strip()

    return ""


def _build_item(el, title_field, link_fn, published_fields, html_fields) -> dict | None:
    title = (el.findtext(title_field) or "").strip()
    if not title:
        return None
    link = link_fn(el)
    published = ""
    for f in published_fields:
        if val := el.findtext(f):
            published = val.strip()
            break
    return {
        "title": title,
        "link": link,
        "published": published,
        "image": _extract_image(el, html_fields),
    }


def parse_rss(xml_bytes: bytes, limit: int = 4) -> tuple[str, list[dict]]:
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        raise ValueError("upstream returned non-XML response (got HTML?)")
    feed_image = _extract_feed_image(root)

    # RSS 2.0: <rss><channel><item>
    items = [
        item
        for el in root.findall(".//item")
        if (
            item := _build_item(
                el,
                title_field="title",
                link_fn=lambda e: (e.findtext("link") or "").strip(),
                published_fields=["pubDate"],
                html_fields=["description", "content:encoded"],
            )
        )
    ]

    # Atom: <feed><entry>
    if not items:

        def atom_link(e):
            link_el = e.find(f"{ATOM_NS}link")
            return link_el.get("href", "") if link_el is not None else ""

        items = [
            item
            for el in root.findall(f"{ATOM_NS}entry")
            if (
                item := _build_item(
                    el,
                    title_field=f"{ATOM_NS}title",
                    link_fn=atom_link,
                    published_fields=[f"{ATOM_NS}published", f"{ATOM_NS}updated"],
                    html_fields=[f"{ATOM_NS}summary", f"{ATOM_NS}content"],
                )
            )
        ]

    return feed_image, items[:limit]


def fetch_rss(url: str) -> tuple[str, list[dict]]:
    raw = fetch_cached(url, ttl_seconds=900)
    return parse_rss(raw)


# ---------- Calendar (.ics) ----------


def _ics_unfold(text: str) -> list[str]:
    # RFC 5545: lines that start with a space or tab are continuations.
    out: list[str] = []
    for raw_line in text.splitlines():
        if raw_line.startswith((" ", "\t")) and out:
            out[-1] += raw_line[1:]
        else:
            out.append(raw_line)
    return out


def _ics_parse_dt(value: str, params: dict[str, str]) -> tuple[object, bool]:
    """Return (datetime-or-date, is_all_day)."""
    is_date = params.get("VALUE") == "DATE" or (len(value) == 8 and "T" not in value)
    if is_date:
        return dt.date(int(value[0:4]), int(value[4:6]), int(value[6:8])), True
    # Timed value: 20260421T140000 or 20260421T140000Z
    is_utc = value.endswith("Z")
    if is_utc:
        value = value[:-1]
    naive = dt.datetime.strptime(value, "%Y%m%dT%H%M%S")
    if is_utc:
        naive = naive.replace(tzinfo=dt.timezone.utc).astimezone().replace(tzinfo=None)
    return naive, False


def _ics_unescape(text: str) -> str:
    return (
        text.replace("\\n", " ")
        .replace("\\N", " ")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
    )


def parse_ics(text: str) -> list[dict]:
    """Parse a minimal subset of RFC 5545. Skips events with RRULE."""
    lines = _ics_unfold(text)
    events: list[dict] = []
    current: dict | None = None
    skipped_recurring = 0

    for line in lines:
        if line == "BEGIN:VEVENT":
            current = {}
            continue
        if line == "END:VEVENT":
            if current is not None and "start" in current and "summary" in current:
                if current.pop("_recurring", False):
                    skipped_recurring += 1
                else:
                    events.append(current)
            current = None
            continue
        if current is None:
            continue

        # Property line: NAME[;PARAM=VAL;...]:VALUE
        if ":" not in line:
            continue
        try:
            head, _, value = line.partition(":")
            parts = head.split(";")
            name = parts[0].upper()
            params = {}
            for p in parts[1:]:
                if "=" in p:
                    k, _, v = p.partition("=")
                    params[k.upper()] = v

            if name == "SUMMARY":
                current["summary"] = _ics_unescape(value)
            elif name == "DTSTART":
                current["start"], current["allDay"] = _ics_parse_dt(value, params)
            elif name == "DTEND":
                current["end"], _ = _ics_parse_dt(value, params)
            elif name == "RRULE":
                current["_recurring"] = True
        except Exception as e:
            sys.stderr.write(f"[calendar] skipping event due to parse error: {e}\n")
            current = None  # discard this event entirely; END:VEVENT won't append it

    if skipped_recurring:
        sys.stderr.write(f"[calendar] skipped {skipped_recurring} recurring event(s)\n")
    return events


def _event_occurs_today(ev: dict, today: dt.date) -> bool:
    start = ev["start"]
    end = ev.get("end", start)
    # All-day events: iCal DTEND is exclusive (next day). Treat missing end as same day.
    start_d = (
        start
        if isinstance(start, dt.date) and not isinstance(start, dt.datetime)
        else start.date()
    )
    end_d = (
        end
        if isinstance(end, dt.date) and not isinstance(end, dt.datetime)
        else end.date()
    )
    if ev.get("allDay"):
        # DTEND is exclusive for all-day per RFC 5545
        return start_d <= today < end_d if end_d > start_d else start_d == today
    return start_d <= today <= end_d


def _redact_url(url: str) -> str:
    h = hashlib.sha256(url.encode()).hexdigest()[:8]
    return f"<sha256:{h}>"


def fetch_calendar(urls: list[str]) -> list[dict]:
    today = dt.date.today()
    all_events: list[dict] = []
    for idx, url in enumerate(urls):
        try:
            raw = fetch_cached(url, ttl_seconds=300)
        except Exception as e:
            sys.stderr.write(f"[calendar] fetch failed for url #{idx} ({_redact_url(url)}): {e}\n")
            continue
        text = raw.decode("utf-8", errors="replace")
        for ev in parse_ics(text):
            if not _event_occurs_today(ev, today):
                continue
            start = ev["start"]
            end = ev.get("end", start)
            all_events.append(
                {
                    "summary": ev["summary"],
                    "start": start.isoformat(),
                    "end": end.isoformat() if hasattr(end, "isoformat") else str(end),
                    "allDay": bool(ev.get("allDay")),
                    "source": idx,
                }
            )

    # All-day first, then by start time.
    all_events.sort(key=lambda e: (not e["allDay"], e["start"]))
    return all_events


# ---------- HTTP handler ----------


class DashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, message: str):
        # HTTP 200 with {error} so the frontend can render an inline error
        # without losing whatever's already on screen. Last-good data is
        # already served transparently via fetch_cached's stale fallback.
        self._send_json({"error": message}, status=200)

    def _serve_static(self, rel_path: str):
        if rel_path in ("", "/"):
            rel_path = "index.html"
        rel_path = rel_path.lstrip("/")
        full = os.path.realpath(os.path.join(PUBLIC_DIR, rel_path))
        if os.path.commonpath([full, PUBLIC_REAL]) != PUBLIC_REAL or not os.path.isfile(full):
            self.send_error(404, "Not Found")
            return
        ctype, _ = mimetypes.guess_type(full)
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/version":
            self._send_json({"version": VERSION})
            return

        try:
            cfg = load_config()
        except Exception as e:
            self._send_error_json(f"config error: {e}")
            return

        if path == "/api/debug":
            now = time.time()
            cal_url_set = set((cfg.get("calendar") or {}).get("urls") or [])
            with _cache_lock:
                cache_entries = [
                    {"url": u, "ttlRemaining": round(exp - now, 1)}
                    for u, (exp, _body) in _cache.items()
                    if u not in cal_url_set
                ]
            cache_entries.sort(key=lambda e: e["url"])
            self._send_json(
                {
                    "version": VERSION,
                    "versionShort": VERSION[:7],
                    "serverStartedAt": SERVER_STARTED_AT,
                    "latestCommitAt": LATEST_COMMIT_AT,
                    "latestCommitSubject": LATEST_COMMIT_SUBJECT,
                    "pythonVersion": platform.python_version(),
                    "platform": platform.platform(),
                    "rssFeedCount": len(cfg.get("rss", []) or []),
                    "calendarUrlCount": len(cal_url_set),
                    "cache": cache_entries,
                }
            )
            return

        if path == "/api/logs":
            which = (query.get("which", [""])[0] or "").lower()
            if which not in ("service", "update"):
                self._send_error_json("which must be 'service' or 'update'")
                return
            try:
                lines_arg = int(query.get("lines", ["200"])[0])
            except ValueError:
                lines_arg = 200
            lines_arg = max(1, min(lines_arg, 2000))

            if which == "service":
                # No shell — argv list keeps `lines_arg` from being injected.
                try:
                    out = subprocess.run(
                        [
                            "journalctl",
                            "-u",
                            "dashboard.service",
                            "-n",
                            str(lines_arg),
                            "--no-pager",
                        ],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                except FileNotFoundError:
                    self._send_error_json("journalctl not available on this host")
                    return
                except subprocess.TimeoutExpired:
                    self._send_error_json("journalctl timed out")
                    return
                if out.returncode != 0:
                    self._send_error_json(
                        f"journalctl failed: {out.stderr.strip() or 'unknown error'}"
                    )
                    return
                lines = out.stdout.splitlines()
                self._send_json(
                    {
                        "lines": lines[-lines_arg:],
                        "source": "journalctl -u dashboard.service",
                        "truncated": False,
                    }
                )
                return

            # which == "update"
            if not os.path.isfile(UPDATE_LOG_PATH):
                self._send_json(
                    {
                        "lines": [],
                        "source": f"file:{UPDATE_LOG_PATH}",
                        "truncated": False,
                        "note": "no log yet",
                    }
                )
                return
            try:
                with open(UPDATE_LOG_PATH, "rb") as f:
                    # Cheap tail: read last 256KB and split. update.log is
                    # plain text and grows slowly so this is fine.
                    f.seek(0, os.SEEK_END)
                    size = f.tell()
                    chunk = 256 * 1024
                    f.seek(max(0, size - chunk))
                    raw = f.read()
                text = raw.decode("utf-8", errors="replace")
                lines = text.splitlines()
                truncated = size > chunk
                self._send_json(
                    {
                        "lines": lines[-lines_arg:],
                        "source": f"file:{UPDATE_LOG_PATH}",
                        "truncated": truncated,
                    }
                )
            except Exception as e:
                self._send_error_json(f"failed to read update log: {e}")
            return

        if path == "/api/config":
            # Expose only the client-relevant subset of config.
            cal_urls = (cfg.get("calendar") or {}).get("urls") or []
            self._send_json(
                {
                    "rotation": cfg.get("rotation", {"rssSeconds": 30}),
                    "calendar": {"enabled": bool(cal_urls)},
                    "countdowns": cfg.get("countdowns", []) or [],
                }
            )
            return

        if path == "/api/nhl":
            date_override = query.get("date", [None])[0]
            favorites = cfg.get("nhl", {}).get("favorites", []) or []
            try:
                if date_override:
                    # Debug override: single-day response, no yesterday view.
                    games = fetch_nhl(date_override, favorites)
                    has_live = any(g["state"] in ("LIVE", "CRIT") for g in games)
                    self._send_json(
                        {
                            "today": {"date": date_override, "games": games},
                            "yesterday": None,
                            "hasLiveToday": has_live,
                        }
                    )
                else:
                    today_iso = dt.date.today().isoformat()
                    yesterday_iso = (dt.date.today() - dt.timedelta(days=1)).isoformat()
                    today_games = fetch_nhl(today_iso, favorites)
                    yesterday_games = fetch_nhl(yesterday_iso, favorites)
                    has_live = any(g["state"] in ("LIVE", "CRIT") for g in today_games)
                    self._send_json(
                        {
                            "today": {"date": today_iso, "games": today_games},
                            "yesterday": {
                                "date": yesterday_iso,
                                "games": yesterday_games,
                            },
                            "hasLiveToday": has_live,
                        }
                    )
            except Exception as e:
                self._send_error_json(str(e))
            return

        if path == "/api/weather":
            w = cfg.get("weather", {})
            lat, lon = w.get("latitude"), w.get("longitude")
            if lat is None or lon is None:
                self._send_error_json("weather lat/lon missing in config.json")
                return
            try:
                payload = {"label": w.get("label", ""), **fetch_weather(lat, lon)}
                self._send_json(payload)
            except Exception as e:
                self._send_error_json(str(e))
            return

        if path == "/api/rss":
            feeds = cfg.get("rss", []) or []
            try:
                idx = int(query.get("feed", ["0"])[0])
            except ValueError:
                idx = 0
            if not feeds:
                self._send_error_json("no rss feeds configured")
                return
            idx %= len(feeds)
            feed = feeds[idx]
            try:
                feed_image, items = fetch_rss(feed["url"])
                self._send_json(
                    {
                        "index": idx,
                        "total": len(feeds),
                        "name": feed.get("name", feed["url"]),
                        "feedImage": feed_image,
                        "items": items,
                    }
                )
            except Exception as e:
                self._send_error_json(str(e))
            return

        if path == "/api/calendar":
            cal_urls = (cfg.get("calendar") or {}).get("urls") or []
            if not cal_urls:
                self._send_json(
                    {
                        "enabled": False,
                        "events": [],
                        "date": dt.date.today().isoformat(),
                    }
                )
                return
            try:
                events = fetch_calendar(cal_urls)
                self._send_json(
                    {
                        "enabled": True,
                        "events": events,
                        "date": dt.date.today().isoformat(),
                    }
                )
            except Exception as e:
                self._send_error_json(str(e))
            return

        # static
        self._serve_static(path)

    def do_POST(self):
        # No CSRF token / auth: dashboard runs LAN-only with no users beyond
        # its own kiosk tab. Adding a token would be theatre.
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/update":
            self.send_error(404, "Not Found")
            return

        if not os.path.isfile(UPDATE_SCRIPT_PATH):
            self._send_error_json(f"update script not found at {UPDATE_SCRIPT_PATH}")
            return

        if not _update_lock.acquire(blocking=False):
            self._send_error_json("update already running")
            return
        try:
            # Detached so the script can outlive this request — its
            # systemctl restart will kill us mid-flight, which is fine. The
            # frontend's /api/version poll picks up the new SHA and reloads.
            subprocess.Popen(
                ["/usr/bin/env", "bash", UPDATE_SCRIPT_PATH, "--force"],
                cwd=HERE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            self._send_json({"started": True})
        except Exception as e:
            self._send_error_json(f"failed to start update: {e}")
        finally:
            # Release immediately — Popen returns as soon as the child
            # forks, so the lock would otherwise just be held for the
            # ~milliseconds of subprocess startup. The script's own pid
            # file or systemd state is the real concurrency boundary,
            # and update-dashboard.sh is idempotent (it no-ops when
            # already at HEAD).
            _update_lock.release()


def main():
    if not os.path.isdir(PUBLIC_DIR):
        os.makedirs(PUBLIC_DIR, exist_ok=True)
    # Run config through the validator at startup so any warnings are
    # printed to journalctl up front rather than only on the first request.
    # Failures are logged; we still proceed (load_config never raises).
    try:
        load_config()
    except Exception as e:
        _warn(f"unexpected error during startup config validation: {e}")
    server = ThreadingHTTPServer(("", PORT), DashboardHandler)
    print(f"Dashboard running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
