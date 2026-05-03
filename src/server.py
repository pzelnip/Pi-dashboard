#!/usr/bin/env python3
"""Dashboard server: serves ./public and proxies a handful of API endpoints.

This file is the entry point and HTTP routing layer. The real work lives in:
  - cache.py          — in-memory TTL cache with stale-on-failure fallback
  - config.py         — config.json + config.local.json overlay
  - parsers/nhl.py    — NHL schedule
  - parsers/weather.py — Open-Meteo
  - parsers/rss.py    — RSS 2.0 + Atom
  - parsers/calendar.py — iCalendar (.ics)
"""

import json
import mimetypes
import os
import platform
import subprocess
import sys
import threading
import time
import urllib.parse
import datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cache
from config import HERE, load_config
from parsers.calendar import fetch_calendar
from parsers.nhl import fetch_nhl
from parsers.rss import fetch_rss
from parsers.weather import fetch_weather

PUBLIC_DIR = os.path.join(HERE, "public")
PUBLIC_REAL = os.path.realpath(PUBLIC_DIR)
PORT = int(os.environ.get("DASHBOARD_PORT", "8080"))

# Repo root is the parent of src/. The update script and its log live there:
# update-dashboard.sh is admin/deployment tooling (not Pi-runtime code), and
# the Pi cron writes update.log next to the script per deployment.md.
REPO_ROOT = os.path.dirname(HERE)


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

# Held while update-dashboard.sh is running so concurrent POST /api/update
# requests don't fan out into multiple git pull / restart attempts.
_update_lock = threading.Lock()
UPDATE_LOG_PATH = os.path.join(REPO_ROOT, "update.log")
UPDATE_SCRIPT_PATH = os.path.join(REPO_ROOT, "update-dashboard.sh")


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
            with cache._cache_lock:
                cache_entries = [
                    {"url": u, "ttlRemaining": round(exp - now, 1)}
                    for u, (exp, _body) in cache._cache.items()
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
                cwd=REPO_ROOT,
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
    server = ThreadingHTTPServer(("", PORT), DashboardHandler)
    print(f"Dashboard running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
