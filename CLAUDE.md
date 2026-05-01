# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A zero-dependency Pi-kiosk dashboard. A single Python stdlib HTTP server serves a static SPA and proxies a handful of upstream APIs (NHL, Open-Meteo, RSS/Atom, iCal). It is meant to run on a Raspberry Pi displayed via Chromium in kiosk mode. Local development is the same as deployed runtime — there is no build step, no bundler, no test suite.

## Run / develop

```bash
python3 server.py             # serves on :8080
DASHBOARD_PORT=8765 python3 server.py   # alternate port (use this for ad-hoc testing if 8080 is taken)
```

Edit any file under `public/` or `server.py` and reload the browser — the server reads `config.json` per request and serves static files with `Cache-Control: no-store`, so no restart is needed for content changes. Restart Python only if you edit `server.py`.

There is no test suite. To smoke-test changes, hit the JSON endpoints with `curl` and inspect the page in a browser:

```bash
curl -s http://localhost:8080/api/nhl | jq             # {today, yesterday, hasLiveToday}
curl -s 'http://localhost:8080/api/nhl?date=2026-04-21' | jq  # debug override (yesterday only)
curl -s http://localhost:8080/api/weather | jq
curl -s 'http://localhost:8080/api/rss?feed=0' | jq    # RSS 2.0 path
curl -s 'http://localhost:8080/api/rss?feed=2' | jq    # Atom path (Simon Willison)
curl -s http://localhost:8080/api/calendar | jq
curl -s http://localhost:8080/api/config | jq          # rotation intervals + feature flags
curl -s http://localhost:8080/api/version | jq         # git SHA, for kiosk auto-reload
```

When making frontend changes, exercise both the rotation timers and the dots/prev-next controls in a real browser; they're the area most likely to regress. Also visually verify the cross-fade transitions on view swap — RSS fades around the `innerHTML` rewrite while weather/NHL stack their views and toggle `.active`, so a mistake in either path won't show up in `curl`.

## Configuration

`config.json` is checked in with the author's defaults. `config.local.json` (gitignored, see `config.local.example.json`) is recursively merged on top — use it for personal calendar URLs or location overrides without touching the committed file. The merge happens on every request inside `load_config()`.

Notable knobs the frontend reads from `config.json` via `/api/config`:

- `rotation.{rssSeconds, weatherPanelSeconds, nhlPanelSeconds}` — per-panel rotation cadence; `nhlPanelSeconds` defaults to `weatherPanelSeconds` if omitted.
- `nhl.favorites` — array of team abbreviations (`["EDM", "VAN"]`). Favorited teams sort to the top of their status group and get a ★ next to the team name. Empty/missing means no preference.
- `countdowns` — list of `{date, title}` objects driving the countdown view in the weather panel.
- `calendar.urls` — list of public iCalendar (`.ics`) URLs. Multiple are merged. The calendar view is suppressed entirely when none are configured.

## Architecture

### Server (`server.py`, ~600 lines)

Single-file Python 3 stdlib server. Three concerns are layered:

1. **Caching layer** (`fetch_cached`): every upstream HTTP fetch goes through this. Each URL has its own TTL (NHL: 20s, weather: 600s, RSS: 900s, calendar: 300s). On upstream network failure, `fetch_cached` returns the *expired* cached body if any exists — this is what keeps the dashboard useful when an external API blips. Don't bypass this; if you add a new upstream, route it through `fetch_cached` and pick a TTL that respects rate limits.

2. **Per-API parsers** (`fetch_nhl`, `fetch_weather`, `parse_rss`, `parse_ics` + `_event_occurs_today`): each takes raw bytes from the cache and produces the JSON shape the frontend expects. The NHL parser maps NHL API states (`LIVE`/`CRIT`/`FUT`/`PRE`/`OFF`/`FINAL`) and computes `statusText` server-side. The RSS parser handles both RSS 2.0 (`<item>`) and Atom (`<entry>`) — both branches share `_build_item`.

   The NHL handler does *not* call `/schedule/now` upstream. That endpoint lags the calendar rollover (still returns yesterday's slate hours into the user's morning), so `fetch_nhl` always anchors on the Pi's local date and hits `/schedule/<YYYY-MM-DD>` instead. The handler returns a `{today, yesterday, hasLiveToday}` envelope; the frontend rotates between the two views when no live game is in progress, and pins to today only when one is. If you "fix" `fetch_nhl` to use `/schedule/now`, you will reintroduce a real bug.

3. **HTTP handler** (`DashboardHandler`): routes `/api/*` to the parsers, falls through to a sandboxed static-file server for everything else (path is `os.path.normpath`'d and required to start with `PUBLIC_DIR`). Errors are returned as HTTP 200 with `{error: "..."}` so the frontend can render an inline message without losing what's on screen — the actual stale-data fallback happens transparently in `fetch_cached`.

`/api/version` returns the current git SHA (computed once at startup); the frontend polls it and reloads on change. This is how the kiosk auto-updates after a deploy.

### Frontend (`public/app.js`, ~600 lines)

Single ES module-free file, three rotating panels (NHL, weather, RSS). The key abstraction is `createRotator({...})` — every rotating panel is an instance:

- Owns the active-view index, rotation timer, and dots/prev-next controls.
- `setViews(newViews)` swaps the active set without losing position when the previously-active view is still in the new list. NHL uses this to flip between today-only and today/yesterday based on whether games are live. Weather uses it at startup based on which features are configured. RSS uses it once the feed count is known.
- `onShow(activeView)` is the only per-panel hook. RSS uses it to fire `refreshRSS` when the rotator advances; weather uses it to hide the city label on non-weather views; NHL has no `onShow` (its views are pre-rendered).

The weather panel is special: it stacks four views (weather, calendar, clock, countdown) inside one panel. The calendar view shares the panel header, which is why `refreshCalendar` calls `setUpdated("weather")`.

CSS classes for the dots/nav controls are `.rot-*` (shared by all three panels). Don't reintroduce panel-specific class names — the controls are intentionally shared.

All time/date formatting in `app.js` passes an explicit `"en-US"` locale and `hour12: true`. The Pi's system locale renders 24-hour by default, so calling `toLocaleTimeString()` with no args (or with `[]`) produces "20:03" on the deployed device but "8:03 PM" on a Mac dev machine — silent regression. The clock view also builds its date string manually (weekday/month from `toLocaleDateString("en-US", {...})`, day-of-month + ordinal suffix from `getDate()` + helper) for the same reason.

### HTML (`public/index.html`, 70 lines)

Three panels, each with `data-body="<name>"` for `bodyEl()`/`showError()` lookups, `[data-updated-for="<name>"]` for the "X ago" labels, and `id="<panel>-dots"` / `id="<panel>-nav"` for rotator controls. Each panel body contains stacked `.view` elements that the rotator toggles `.active` on.

## Deployment

`deployment.md` has the full Pi setup. The TL;DR: a cron job on the Pi runs `update-dashboard.sh` every minute, which fetches `origin/main` and `systemctl restart`s the service if the remote is ahead. The frontend's `/api/version` poll then triggers a browser reload. So pushing to `main` is effectively the deploy.
