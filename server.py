#!/usr/bin/env python3
"""Dashboard server: serves ./public and proxies three API endpoints."""

import json
import mimetypes
import os
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
CONFIG_PATH = os.path.join(HERE, "config.json")
LOCAL_CONFIG_PATH = os.path.join(HERE, "config.local.json")
PORT = int(os.environ.get("DASHBOARD_PORT", "8080"))
USER_AGENT = "Mozilla/5.0 (compatible; pi-dashboard/1.0)"


def _current_version() -> str:
    try:
        sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=HERE, stderr=subprocess.DEVNULL, timeout=2,
        )
        return sha.decode().strip()
    except Exception:
        return str(int(time.time()))


VERSION = _current_version()

_cache: dict[str, tuple[float, bytes]] = {}
_cache_lock = threading.Lock()


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


def fetch_cached(url: str, ttl_seconds: int) -> bytes:
    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and hit[0] > now:
            return hit[1]

    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read()

    with _cache_lock:
        _cache[url] = (now + ttl_seconds, body)
    return body


def stale_cached(url: str) -> bytes | None:
    with _cache_lock:
        hit = _cache.get(url)
        return hit[1] if hit else None


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
        ord_label = PERIOD_ORDINAL.get(period_num, f"P{period_num}")
        if in_intermission:
            return f"End of {ord_label}"
        if time_remaining:
            return f"{ord_label} · {time_remaining}"
        return ord_label

    return ""  # scheduled / pre-game: frontend will show start time instead


def _team(t: dict) -> dict:
    return {
        "abbrev": t.get("abbrev", ""),
        "name": (t.get("commonName") or {}).get("default", ""),
        "score": t.get("score"),
        "logo": t.get("logo", ""),
    }


def _series_text(s: dict | None) -> str:
    if not s:
        return ""
    top = s.get("topSeedTeamAbbrev")
    top_w = s.get("topSeedWins", 0)
    bot = s.get("bottomSeedTeamAbbrev")
    bot_w = s.get("bottomSeedWins", 0)
    if top_w == 0 and bot_w == 0:
        return f"Game {s.get('gameNumberOfSeries', '?')}"
    if top_w > bot_w:
        return f"Game {s.get('gameNumberOfSeries', '?')} ({top} leads {top_w}-{bot_w})"
    if bot_w > top_w:
        return f"Game {s.get('gameNumberOfSeries', '?')} ({bot} leads {bot_w}-{top_w})"
    return f"Game {s.get('gameNumberOfSeries', '?')} (tied {top_w}-{bot_w})"


def fetch_nhl(date: str | None, teams: list[str]) -> list[dict]:
    path = f"schedule/{date}" if date else "schedule/now"
    url = f"https://api-web.nhle.com/v1/{path}"
    raw = fetch_cached(url, ttl_seconds=20)
    data = json.loads(raw)

    # API returns a full week; filter to requested date (or first week entry = today).
    target_date = date
    weeks = data.get("gameWeek", [])
    if not target_date and weeks:
        target_date = weeks[0].get("date")

    games_out = []
    for week in weeks:
        if week.get("date") != target_date:
            continue
        for game in week.get("games", []):
            home = game.get("homeTeam", {})
            away = game.get("awayTeam", {})
            if teams:
                if home.get("abbrev") not in teams and away.get("abbrev") not in teams:
                    continue
            games_out.append({
                "home": _team(home),
                "away": _team(away),
                "state": game.get("gameState", ""),
                "startTime": game.get("startTimeUTC", ""),
                "statusText": _status_text(game),
                "seriesText": _series_text(game.get("seriesStatus")),
            })
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
    data = json.loads(raw)
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


def parse_rss(xml_bytes: bytes, limit: int = 4) -> tuple[str, list[dict]]:
    root = ET.fromstring(xml_bytes)
    feed_image = _extract_feed_image(root)
    items = []

    # RSS 2.0: <rss><channel><item>
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        published = (item.findtext("pubDate") or "").strip()
        image = _extract_image(item, ["description", "content:encoded"])
        if title:
            items.append({
                "title": title, "link": link, "published": published, "image": image,
            })

    # Atom: <feed><entry>
    if not items:
        for entry in root.findall(f"{ATOM_NS}entry"):
            title = (entry.findtext(f"{ATOM_NS}title") or "").strip()
            link_el = entry.find(f"{ATOM_NS}link")
            link = link_el.get("href", "") if link_el is not None else ""
            published = (
                entry.findtext(f"{ATOM_NS}published")
                or entry.findtext(f"{ATOM_NS}updated")
                or ""
            ).strip()
            image = _extract_image(entry, [f"{ATOM_NS}summary", f"{ATOM_NS}content"])
            if title:
                items.append({
                    "title": title, "link": link, "published": published, "image": image,
                })

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
    return (text.replace("\\n", " ").replace("\\N", " ")
                .replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\"))


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

    if skipped_recurring:
        sys.stderr.write(f"[calendar] skipped {skipped_recurring} recurring event(s)\n")
    return events


def _event_occurs_today(ev: dict, today: dt.date) -> bool:
    start = ev["start"]
    end = ev.get("end", start)
    # All-day events: iCal DTEND is exclusive (next day). Treat missing end as same day.
    start_d = start if isinstance(start, dt.date) and not isinstance(start, dt.datetime) else start.date()
    end_d = end if isinstance(end, dt.date) and not isinstance(end, dt.datetime) else end.date()
    if ev.get("allDay"):
        # DTEND is exclusive for all-day per RFC 5545
        return start_d <= today < end_d if end_d > start_d else start_d == today
    return start_d <= today <= end_d


def fetch_calendar(urls: list[str]) -> list[dict]:
    today = dt.date.today()
    all_events: list[dict] = []
    for idx, url in enumerate(urls):
        try:
            raw = fetch_cached(url, ttl_seconds=300)
        except Exception as e:
            sys.stderr.write(f"[calendar] fetch failed for {url}: {e}\n")
            continue
        text = raw.decode("utf-8", errors="replace")
        for ev in parse_ics(text):
            if not _event_occurs_today(ev, today):
                continue
            start = ev["start"]
            end = ev.get("end", start)
            all_events.append({
                "summary": ev["summary"],
                "start": start.isoformat(),
                "end": end.isoformat() if hasattr(end, "isoformat") else str(end),
                "allDay": bool(ev.get("allDay")),
                "source": idx,
            })

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

    def _send_error_json(self, message: str, stale=None):
        # HTTP 200 with {error, stale} so the frontend can keep showing last-good data.
        self._send_json({"error": message, "stale": stale}, status=200)

    def _serve_static(self, rel_path: str):
        if rel_path in ("", "/"):
            rel_path = "index.html"
        rel_path = rel_path.lstrip("/")
        full = os.path.normpath(os.path.join(PUBLIC_DIR, rel_path))
        if not full.startswith(PUBLIC_DIR) or not os.path.isfile(full):
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

        if path == "/api/config":
            # Expose only the client-relevant subset of config.
            cal_urls = (cfg.get("calendar") or {}).get("urls") or []
            self._send_json({
                "rotation": cfg.get("rotation", {"rssSeconds": 30}),
                "calendar": {"enabled": bool(cal_urls)},
            })
            return

        if path == "/api/nhl":
            date = query.get("date", [None])[0]
            teams = cfg.get("nhl", {}).get("teams", []) or []
            try:
                games = fetch_nhl(date, teams)
                self._send_json(games)
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
                self._send_json({
                    "index": idx,
                    "total": len(feeds),
                    "name": feed.get("name", feed["url"]),
                    "feedImage": feed_image,
                    "items": items,
                })
            except Exception as e:
                self._send_error_json(str(e))
            return

        if path == "/api/calendar":
            cal_urls = (cfg.get("calendar") or {}).get("urls") or []
            if not cal_urls:
                self._send_json({"enabled": False, "events": [], "date": dt.date.today().isoformat()})
                return
            try:
                events = fetch_calendar(cal_urls)
                self._send_json({
                    "enabled": True,
                    "events": events,
                    "date": dt.date.today().isoformat(),
                })
            except Exception as e:
                self._send_error_json(str(e))
            return

        # static
        self._serve_static(path)


def main():
    if not os.path.isdir(PUBLIC_DIR):
        os.makedirs(PUBLIC_DIR, exist_ok=True)
    server = ThreadingHTTPServer(("", PORT), DashboardHandler)
    print(f"Dashboard running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
