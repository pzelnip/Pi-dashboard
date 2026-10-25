# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A zero-dependency Pi-kiosk dashboard. A single Python stdlib HTTP server serves a static SPA and proxies a handful of upstream APIs (NHL, Open-Meteo, RSS/Atom, iCal). It is meant to run on a Raspberry Pi displayed via Chromium in kiosk mode. Local development is the same as deployed runtime — there is no build step, no bundler. There is a Python `unittest` suite for the server-side parsers and cache; the frontend has no tests and is exercised manually in the browser.

## Run / develop

All Pi-runtime code lives under `src/` (server, parsers, cache, config, the
checked-in `config.json`, and the static frontend in `src/public/`). Docs live
under `docs/`; `CLAUDE.md` and `README.md` stay at the repo root.

```bash
python3 src/server.py             # serves on :8080
DASHBOARD_PORT=8765 python3 src/server.py   # alternate port (use this for ad-hoc testing if 8080 is taken)
```

Edit any file under `src/public/` or `src/server.py` and reload the browser — the server reads `src/config.json` per request and serves static files with `Cache-Control: no-cache` and an mtime-based `ETag` (the browser revalidates on every load and gets a 304 when nothing changed), so no restart is needed for content changes. Restart Python only if you edit Python.

Server-side unit tests live in `src/tests/` and use stdlib `unittest` only:

```bash
cd src && python3 -m unittest discover -v
```

Fixtures (small captured payloads for NHL JSON, RSS/Atom XML, iCal) live in
`src/tests/fixtures/`. Tests mock `urllib.request.urlopen` and never touch the
network. There is no JS test runner — frontend changes are verified manually
in the browser.

To smoke-test the running server, hit the JSON endpoints with `curl` and
inspect the page in a browser:

```bash
curl -s http://localhost:8080/api/nhl | jq             # {today, yesterday, hasLiveToday}
curl -s 'http://localhost:8080/api/nhl?date=2026-04-21' | jq  # debug override (yesterday only)
curl -s http://localhost:8080/api/weather | jq
curl -s http://localhost:8080/api/rss | jq            # every page of the merged feeds
curl -s http://localhost:8080/api/calendar | jq
curl -s http://localhost:8080/api/config | jq          # rotation intervals + feature flags
curl -s http://localhost:8080/api/version | jq         # git SHA, for kiosk auto-reload
```

To see what the Pi actually renders, use `pi-screenshot.sh` (details in
`docs/pi-screenshots.md`). `./pi-screenshot.sh live` pulls the kiosk's current
screen over ssh, and `./pi-screenshot.sh mac` renders the local working copy
at the Pi's resolution. Both write to `pi-shots/latest-<mode>.png`, which you
can Read to inspect layout. Mac and Pi render fonts and emoji differently, so
check layout-sensitive changes against a `live` shot rather than trusting the
Mac rendering.

When making frontend changes, exercise both the rotation timers and the dots/prev-next controls in a real browser; they're the area most likely to regress. Also visually verify the cross-fade transitions on view swap — RSS fades around the `innerHTML` rewrite while weather/NHL stack their views and toggle `.active`, so a mistake in either path won't show up in `curl`.

## Configuration

`src/config.json` is checked in with the author's defaults. `src/config.local.json` (gitignored, see `src/config.local.example.json`) is recursively merged on top — use it for personal calendar URLs or location overrides without touching the committed file. The merge happens on every request inside `load_config()`.

Notable knobs the frontend reads from `config.json` via `/api/config`:

- `rotation.{rssSeconds, weatherPanelSeconds, nhlPanelSeconds}` — per-panel rotation cadence; `nhlPanelSeconds` defaults to `weatherPanelSeconds` if omitted. `rotation.fade` sets the cross-fade length in ms for every viewer (`false`/`0` = instant; the RSS fade is half of it).
- `effects.preset` — default visual-effects preset (`full`/`lite`). Visual effects are resolved **per browser** (see "Visual effects" below), so this and `rotation.fade` are only server-wide defaults.
- `nhl.favorites` — array of team abbreviations (`["EDM", "VAN"]`). Favorited teams sort to the top of their status group and get a ★ next to the team name. Empty/missing means no preference.
- `nhl.seasonStart` — fallback ISO date (`"2026-09-29"`) of the next season's first game; the NHL schedule's own `regularSeasonStartDate` takes precedence when present, so this rarely needs touching. During the deep off-season the NHL panel adds a "days until the NHL season" countdown view. On the eve of the opener (and opening day itself) the panel drops the countdown and shows the real opening-night slate instead — `find_opening_night` surfaces tomorrow's games when today is still empty. Omit/empty (or a past date) and both behaviours are simply skipped.
- `countdowns` — list of `{date, title}` objects driving the countdown view in the weather panel.
- `calendar.urls` — list of public iCalendar (`.ics`) URLs. Multiple are merged. The calendar view is suppressed entirely when none are configured.
- `background.{image, dim, blur}` — `image` is a path on the *dashboard host* (absolute, `~`-relative, or relative to `src/`), not a URL, and not a file under `public/`; the server streams it from `/api/background`. Set it and `js/main.js` puts `.has-bg` on `<body>`, which turns the panels into translucent frosted glass over the wallpaper. Blank, missing, non-image, or non-existent → the flat dark theme, unchanged. `dim` (0–0.95) is the scrim over the photo, `blur` (0–60px, `0` skips it) the panel frosting, pre-blurred once in `frostBackground()` rather than a live `backdrop-filter`, which the Pi composites in software; both are clamped server-side in `background_settings()`.

## Architecture

### Server (`src/server.py`, ~660 lines + `cache.py`, `config.py` and `parsers/`)

Python 3 stdlib server. Three concerns are layered:

1. **Caching layer** (`fetch_cached`): every upstream HTTP fetch goes through this. Each URL has its own TTL (NHL: 20s for the week holding today, longer for past/future weeks; weather: 600s, RSS: 900s, calendar: 300s). On upstream network failure, `fetch_cached` returns the *expired* cached body if any exists — this is what keeps the dashboard useful when an external API blips. Don't bypass this; if you add a new upstream, route it through `fetch_cached` and pick a TTL that respects rate limits. Also pass a `validate` callable (`json.loads`, `ET.fromstring`, …): a 200 whose body fails it is treated as a failure and never cached, so an error page can't become the stale fallback. Every failure is logged to stderr as `[cache] <host>#<hash> …` with the status, content type, size and a body snippet — check `journalctl -u dashboard | grep '\[cache\]'` on the Pi first when a panel shows an upstream error. A failed URL is not retried for `FAILURE_BACKOFF_SECONDS` (stale body or the same error is returned meanwhile), and concurrent misses on one URL share a single fetch. Code that fetches several URLs per request uses `fetch_many` (a shared thread pool) so they run in parallel. Callers whose data can lag one refresh (RSS, calendars) pass `stale_while_revalidate=True`: an expired body is returned at once and refetched in the background (on a separate `_refresh_pool`, so slow refreshes never hold up `fetch_many`), so those requests only wait on an upstream the very first time. Don't use it for the live NHL page, where it would delay scores by a poll.

2. **Per-API parsers** (`fetch_nhl`, `fetch_weather`, `parse_rss`, `parse_ics` + `_event_occurs_today`): each takes raw bytes from the cache and produces the JSON shape the frontend expects. The NHL parser maps NHL API states (`LIVE`/`CRIT`/`FUT`/`PRE`/`OFF`/`FINAL`) and computes `statusText` server-side. The RSS parser handles both RSS 2.0 (`<item>`) and Atom (`<entry>`) — both branches share `_build_item`.

   The NHL handler does *not* call `/schedule/now` upstream. That endpoint lags the calendar rollover (still returns yesterday's slate hours into the user's morning), so `fetch_nhl` always anchors on the Pi's local date and hits `/schedule/<YYYY-MM-DD>` instead. Each such page covers seven days, so `games_on` reads every date from a page anchored on yesterday ± whole weeks: one page answers yesterday through today+5, and the off-season look-back/look-ahead costs at most two more. `nhl_overview` builds the `{today, yesterday, hasLiveToday, offSeason, deepOffSeason, seasonStart, openingNight}` envelope; the frontend rotates between the two views when no live game is in progress, and pins to today only when one is. If you "fix" `fetch_nhl` to use `/schedule/now`, you will reintroduce a real bug.

3. **HTTP handler** (`DashboardHandler`): `do_GET` answers `/api/version` first (before config loads, so a broken config can't stop auto-update), then dispatches `/api/*` through the `_GET_ROUTES` table to one `_get_<name>(self, cfg, query)` method per endpoint — add new GET endpoints there. Everything else falls through to a sandboxed static-file server (the path is `realpath`'d and must stay inside `public/`). Countdown edits go through `config.update_countdowns`, which holds the local-config lock across the whole read-modify-write. Errors are returned as HTTP 200 with `{error: "..."}` so the frontend can render an inline message without losing what's on screen — the actual stale-data fallback happens transparently in `fetch_cached`.

`/api/version` returns the current git SHA (computed once at startup); the frontend polls it and reloads on change. This is how the kiosk auto-updates after a deploy.

### Frontend (`src/public/js/`, ~3,300 lines across nine files)

Three rotating panels (NHL, weather, RSS). The code is split into classic (non-module) scripts that `index.html` loads in dependency order and that share one global scope, so a top-level `let`/`const`/function in one file is visible to the others. There's still no build step:

| File | Contents |
| --- | --- |
| `util.js` | shared state, fit-to-window zoom, formatting/fetch helpers, `loadScript` |
| `rotator.js` | `createRotator` |
| `nhl.js` | game cards and paging, game-details wiring, `refreshNHL`, off-season views |
| `weather.js` | weather, calendar, clock and countdown views |
| `rss.js` | news pages |
| `effects.js` | visual-effects presets and helpers |
| `main.js` | background, `start()`, wake/day-rollover recovery, version polling, debug stub |
| `game-details.js` | game-details modal contents — loaded by `loadScript` on the first open |
| `debug.js` | debug overlay — loaded on first open (debug dot or the d / ? keys) |

Two rules follow from sharing a global scope. Top-level code that *runs* at load (not just declares) may only use what earlier files define; everything else runs from `start()`, the last line of `main.js`. And names must be unique across files. The two lazy files are what the kiosk never opens, so it never parses them. Keep them self-contained: nothing outside may call into them except through their loader.

The key abstraction is `createRotator({...})` — every rotating panel is an instance:

- Owns the active-view index, rotation timer, and dots/prev-next controls.
- `setViews(newViews)` swaps the active set without losing position when the previously-active view is still in the new list. NHL uses this to flip between today-only and today/yesterday based on whether games are live. Weather uses it at startup based on which features are configured. RSS uses it once the feed count is known.
- `onShow(activeView)` is the only per-panel hook. RSS uses it to render the next page from the items it already holds (`/api/rss` returns every page at once; `refreshRSS` re-fetches every few minutes); weather uses it to hide the city label on non-weather views; NHL has no `onShow` (its views are pre-rendered).

The weather panel is special: it stacks four views (weather, calendar, clock, countdown) inside one panel. The calendar view shares the panel header, which is why `refreshCalendar` calls `setUpdated("weather")`.

**Visual effects** (`js/effects.js`, CSS at the end of `style.css`): anything that costs the Pi frames — fades, transition styles, live glass, drifting wallpaper, weather scenes, staggered entrances, goal and final-score events, rolling clock, panel tilt, rotation progress, new-story highlights, time-of-day tint, glass polish, live pulse — is a setting in `FX_SETTINGS` with a value in each `FX_PRESETS` entry (`full`, `lite`). Each resolves per browser from URL param (`?fx=lite`, `?fade=150`) → `localStorage` (`dashboard.fx`, edited in the debug panel's Display view) → server config → the preset's value, and `applyEffects()` pushes it into the page (CSS vars like `--fade-view`). The Pi's kiosk loads `?fx=lite` from `runKiosk.sh`. Add new effects there rather than as ad-hoc flags: gate their CSS on the `body.fx-*` class / `data-fx-transition` that `applyEffects()` sets, keep them off in `lite`, and measure on the Pi before letting anything into `lite` (it composites in software, so continuous animations and long transitions are expensive). Toggles use `fxToggle()`; code that needs a flag reads `fxOn.<key>`.

CSS classes for the dots/nav controls are `.rot-*` (shared by all three panels). Don't reintroduce panel-specific class names — the controls are intentionally shared.

The desktop layout is designed for the kiosk's 1920x1200 display and scaled to fit any other window: `applyFitZoom()` in `js/util.js` sets CSS `zoom` on `<html>` to `min(innerWidth/1920, innerHeight/1200)` (exactly 1 on the Pi; phone layout under 720px is never zoomed). Two consequences when editing: in desktop CSS, use `calc(N * var(--vh))` / `var(--vw)` instead of `vh`/`vw`, which ignore the zoom; and in JS, `getBoundingClientRect()` returns zoomed px while `clientHeight`/`scrollHeight` don't, so convert rects to layout px before comparing. `setNhlPages` divides by the view's own rect-height/`offsetHeight` ratio rather than `fitZoom`, which also covers transforms on the view (the `zoom` view transition scales hidden views).

UI text uses the bundled Inter variable font (`src/public/fonts/`, declared via `@font-face` and the `--font-sans` token at the top of `style.css`). Don't add system UI font stacks (`-apple-system`, `system-ui`, …) to new rules: they resolve to San Francisco on the Mac but DejaVu Sans on the Pi, which is wider and changes every text measurement. Anything that measures rendered text (like the NHL card paging, `setNhlPages`) must re-run once the font loads; see `repageNhl`.

All time/date formatting in `js/` passes an explicit `"en-US"` locale and `hour12: true`. The Pi's system locale renders 24-hour by default, so calling `toLocaleTimeString()` with no args (or with `[]`) produces "20:03" on the deployed device but "8:03 PM" on a Mac dev machine — silent regression. The clock view also builds its date string manually (weekday/month from `toLocaleDateString("en-US", {...})`, day-of-month + ordinal suffix from `getDate()` + helper) for the same reason.

### HTML (`src/public/index.html`, ~130 lines)

Three panels, each with `data-body="<name>"` for `bodyEl()`/`showError()` lookups, `[data-updated-for="<name>"]` for the "X ago" labels, and `id="<panel>-dots"` / `id="<panel>-nav"` for rotator controls. Each panel body contains stacked `.view` elements that the rotator toggles `.active` on. The clock and countdown views appear in both the NHL and weather panels, so their markup lives once in `<template id="tpl-clock">` / `tpl-countdown` and is cloned into every `[data-template]` view at startup; render them with `renderClockView(view)` / `renderCountdownView(view)` (and the weather widget with `renderWeatherView(el, data)`) rather than duplicating per panel.

### Feature inventory

`docs/Overview.md` is the user-facing inventory of what each panel does. When you add a new user-facing feature (new view, new panel control, new config knob), update `docs/Overview.md` in the same change so the inventory stays current.

## Deployment

`docs/deployment.md` has the full Pi setup. The TL;DR: a cron job on the Pi runs `update-dashboard.sh` every 30 minutes, which fetches `origin/main` and `systemctl restart`s the service if the remote is ahead. The frontend's `/api/version` poll then triggers a browser reload. The cron is only a fallback: after pushing to `main`, the usual path is the dashboard's "Force update" button, which runs the same script immediately. A second cron entry runs `restart-kiosk.sh` at 3 AM to restart the service and relaunch Chromium on the kiosk's Wayland display, so the browser never runs for weeks at a time.
