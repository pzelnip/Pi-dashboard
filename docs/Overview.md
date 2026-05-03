# Dashboard Overview

A feature-by-feature inventory of the Pi Dashboard. The project README focuses
on running it; this doc describes what shows up on screen and what each panel
does. See [`README.md`](../README.md) for run/setup instructions and
[`docs/deployment.md`](deployment.md) for the Pi-side deployment flow.

The UI is three panels — **NHL**, **Weather**, **RSS** — laid out in a
responsive grid. Each panel rotates between one or more stacked "views" with
shared dot/prev-next controls and touch-swipe support. All upstream data is
proxied through the local server (`/api/*`) and cached with stale-on-failure
fallback so the kiosk stays useful when an external API blips.

---

## NHL Panel

Source: `src/parsers/nhl.py`, rendering in `src/public/app.js` (`renderNHL`,
`renderGameDetails`).

### Today vs Yesterday rotation

- The panel has two views: **today's** games and **yesterday's** games.
- When *no* game is currently live, the panel rotates between today and
  yesterday on the configured cadence (`rotation.nhlPanelSeconds`, default
  falls back to `rotation.weatherPanelSeconds`).
- When a live game is in progress, the panel **pins to today** and the
  rotation collapses to a single view until the game ends.
- The server anchors on the Pi's local date and hits
  `/schedule/<YYYY-MM-DD>` upstream rather than `/schedule/now`, which lags
  the calendar rollover.

### Game card

For each game the panel shows a card with:

- **Status pill** — colour-coded by state:
  - `LIVE` / `CRIT`: red pill with a pulsing dot, period + clock
    (e.g. "2nd · 7:42", "End of 1st").
  - `FUT` / `PRE`: scheduled, shows local start time (en-US, 12-hour).
  - `OFF` / `FINAL`: muted "Final", "Final/OT", or "Final/SO".
- **Team rows** — logo, common name, score. The leading team (live) or
  winning team (final) is visually emphasised; the losing team is dimmed.
- **Favourite-team star** — see below.
- **Playoff round badge** — see below.
- **Series text** — for playoff games: `Game 5 (EDM leads 3-2)`,
  `Game 7 (tied 3-3)`, `Game 6 (VAN won 4-2) ✅`, etc.

### Favourite teams

Configured via `nhl.favorites` in `config.json` (array of three-letter team
abbreviations, e.g. `["EDM", "VAN", "MTL"]`).

- Each favourited team gets a **★ star** beside its name.
- Within each status group (live / scheduled / final), favourites bubble to
  the top so the games you care about appear first.

### Playoff round badge

Playoff games (`gameType === 3`) get a Roman-numeral badge derived from the
upstream `seriesStatus.round`:

- `I` — Round 1
- `II` — Round 2
- `III` — Conference Final
- `IV` — Stanley Cup Final

Hovering the badge shows the long label as a tooltip. Regular-season games
have no badge.

### Game details modal

Clicking a game card (or pressing Enter / Space when keyboard-focused) opens
a side-sheet modal with extra information. The modal:

- Has a focus trap (Tab cycles within the sheet) and is dismissible with
  Escape, the Close button, or a backdrop click.
- Renders all upstream-derived strings via DOM APIs (`textContent`) — no
  HTML injection from the third-party feed.

Fields shown when available:

- Full team names (e.g. "Tampa Bay Lightning"), abbreviations, scores,
  favourite stars.
- Status, start time.
- Venue, with a "(neutral site)" annotation when applicable.
- Game type label (Preseason / Regular Season / Playoffs / All-Star).
- Series info for playoff games (round title, game number, current series
  state).
- Broadcasts — deduped network + country code (e.g. "TNT US", "SN CA").
- Betting odds — single representative moneyline value per team
  (American format preferred, e.g. `+142` / `-170`).
- Links: **Game center**, **Series page**, **Tickets** — open in a new tab,
  rel=noopener. Site-relative paths from the upstream are normalised to
  `https://www.nhl.com/...`.

### Debug date override

`GET /api/nhl?date=YYYY-MM-DD` returns a single-day envelope (no yesterday
view). Useful for verifying playoff / final-state rendering without waiting
for live data.

---

## Weather Panel

The weather panel stacks up to **four views** inside one panel and rotates
through whichever ones are configured. The panel's "X ago" label refreshes
when any of its views fetches fresh data.

### Weather view

Source: Open-Meteo (`src/parsers/weather.py`).

- **Hero block** — current temperature (rounded, with unit), weather-code
  emoji + label (e.g. "Partly cloudy ⛅"), wind speed, humidity.
- **Daily strip** — 4-day forecast (today + 3): short weekday label, icon,
  min/max range.
- **Clickable** — the entire weather view is a link to
  `https://www.windy.com/?<lat>,<lon>,9` for a detailed forecast at the
  configured coordinates. Opens in a new tab. Configured via
  `weather.latitude` / `weather.longitude` in `config.json`.
- **Label** — `weather.label` (e.g. city name) renders next to the panel
  title; hidden on the other rotation views.

### Calendar view

Source: one or more public iCalendar (`.ics`) URLs (`src/parsers/calendar.py`).

- Configured via `calendar.urls` in `config.json` (or, more typically,
  `config.local.json`). The view is suppressed entirely when no URLs are
  configured.
- Multiple feeds are merged. Today's events only.
- All-day events are listed first ("All day"), followed by timed events
  sorted by start time.
- TZID-aware: `Z` (UTC) and `TZID=<IANA name>` (e.g. America/Vancouver) are
  resolved via stdlib `zoneinfo` and converted to host-local time. Floating
  / unknown TZIDs fall back to naive parsing with a server-side warning.
- Recurring events (with `RRULE`) are skipped (logged to stderr).

### Clock view

- Large 12-hour time + a manually-built date string
  (`Tuesday, May 6th, 2026`). Always renders en-US locale to avoid silent
  24-hour regressions on the Pi's default system locale.
- Re-renders every minute.
- Always present (no config flag).

### Countdown view

Source: `countdowns` in `config.json` (array of `{date, title}` entries).

- Picks the **nearest upcoming** date. If all are past, shows the
  most-recent past one as "X is past, what's next?".
- Same-day entries render as `Today is <title>`; future entries as
  `<N> day(s) until <title>`.
- View is suppressed entirely when no countdowns are configured.
- Re-renders hourly so the day count rolls over at midnight without a page
  reload.

---

## RSS Panel

Source: `src/parsers/rss.py`, rendering in `src/public/app.js` (`renderRSS`).

- Configured via `rss` in `config.json` — array of `{name, url}`. All entries
  rotate.
- Cadence: `rotation.rssSeconds` (default 30 seconds).
- Each rotation **fetches** the next feed and updates the panel header
  (feed name + favicon/logo) and item list.
- Cross-fades the panel body and header on swap (~200 ms).
- Per-feed logo: extracted from `<channel><image><url>` (RSS 2.0),
  `<media:thumbnail>`, or Atom `<logo>` / `<icon>`. Falls back to a built-in
  generic RSS icon when none is present or the upstream URL fails to load.
- Item images: extracted from `<media:thumbnail>` / `<media:content>`,
  `<enclosure type="image/...">`, or the first `<img>` inside an HTML-bearing
  description / summary / content field.
- **Both RSS 2.0 (`<item>`) and Atom (`<entry>`) are supported** via a
  shared item-builder.
- Top 4 items per feed are shown. Clicking an item opens the article in a
  new tab.

---

## Cross-cutting features

### Rotator controls

Every panel uses the same `createRotator` abstraction:

- **Dots** — one per view, click to jump.
- **Prev / next arrows** (`‹` / `›`) — step by one.
- **Touch swipe** — left = next, right = previous. Requires ≥40 px X-delta
  and X must dominate Y by 1.5× (so vertical scrolling stays responsive).
- All controls share the same `.rot-*` CSS classes so they look consistent
  across panels.

### Cross-fade transitions

- NHL and weather toggle a `.active` class on stacked `.view` elements; CSS
  fades the active view in.
- RSS dims the panel header + body, swaps `innerHTML`, then fades back in.

### Stale-data fallback

Every upstream fetch (NHL, weather, RSS, calendar) goes through `fetch_cached`
in `src/cache.py` with a per-URL TTL (NHL: 20 s, weather: 600 s, RSS: 900 s,
calendar: 300 s). On upstream failure, the cached body is returned even if
expired — the dashboard keeps showing the last good data instead of an empty
panel.

When even the cache is empty, the API returns
`{ "error": "<message>" }` with HTTP 200 and the panel renders an inline
warning without destroying the rest of the layout.

### Auto-reload after deploy

- `GET /api/version` returns the current git SHA (computed once at server
  startup).
- The frontend polls it every 30 s and reloads the page when the SHA
  changes — i.e. as soon as the Pi's `update-dashboard.sh` cron has pulled
  and restarted the service.
- See [`docs/deployment.md`](deployment.md) for the full update flow.

### Debug overlay

A small dot in the bottom corner (also bound to the **`d`** or **`?`**
keyboard shortcut) opens a debug side-sheet showing:

- Git SHA — short + full, both linking to the matching commit on GitHub.
- Latest commit — relative time + subject.
- Server uptime (live-counting, ticks every second).
- Viewport dimensions.
- **User agent** — structured fields from `navigator.userAgentData`
  (brands, platform, mobile/desktop) when available, plus the raw UA
  string as a clickable link to `whatismybrowser.com` for parsing.
- **Python version** — clickable link to
  `docs.python.org/release/<version>/`.
- Platform string.
- RSS feed count, calendar URL count.
- **Cache table** — every entry currently held in `fetch_cached` with
  remaining TTL.
- **Service log / Update log** — tail of `journalctl -u dashboard.service`
  and `update.log` respectively (Pi-only; no-op locally).
- **Force update** button — kicks `update-dashboard.sh --force` on the Pi
  with a 3 s cancellable countdown banner; fast-polls `/api/version` post-
  fire so reload happens within ~1 s of the new SHA being live.

Escape closes the overlay (or returns to the field list from a log view).
Arrow keys scroll the sheet body when open.

### Cache headers

- All static assets are served with `Cache-Control: no-store`. Editing a
  file under `src/public/` and reloading the browser is enough — no bundler,
  no service worker.
- `config.json` is re-read on every request inside `load_config()` (with
  recursive merge from `config.local.json` if present), so config changes
  also take effect on reload without restarting Python.

---

## Configuration cheatsheet

All knobs live in [`src/config.json`](../src/config.json) (defaults, checked
in) merged with `src/config.local.json` (gitignored personal overrides; see
[`src/config.local.example.json`](../src/config.local.example.json)).

| Key | Effect |
| --- | --- |
| `weather.latitude` / `weather.longitude` | Open-Meteo coordinates and Windy.com link target. |
| `weather.label` | Display string next to the weather panel header. |
| `nhl.favorites` | Array of team abbreviations; star + sort-to-top. |
| `countdowns` | Array of `{date, title}` for the countdown view. |
| `calendar.urls` | Array of public `.ics` URLs (typically only in `config.local.json`). |
| `rss` | Array of `{name, url}`; all rotate. |
| `rotation.rssSeconds` | RSS feed cadence (seconds). |
| `rotation.weatherPanelSeconds` | Weather panel view cadence (seconds). |
| `rotation.nhlPanelSeconds` | NHL panel view cadence (seconds). Falls back to `weatherPanelSeconds`. |

---

## Adding new features

When you ship a new user-facing feature, please add a bullet (or section) to
this file so the inventory stays current. The reminder also lives in
[`CLAUDE.md`](../CLAUDE.md).
