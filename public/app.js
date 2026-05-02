// Dashboard client: bootstrap. Wires up the three rotating panels (NHL,
// weather, RSS), shared timers, the debug overlay, and version-watch.
//
// Real work lives in:
//   panels/{nhl,weather,calendar,clock,countdown,rss}.js
//   rotator.js, util/dom.js, util/time.js
//   debug.js — debug sheet + auto-reload poll

import { fetchJson, refreshUpdatedLabels } from "./util/dom.js";
import { setupDebugOverlay, watchVersion } from "./debug.js";
import { initNhlRotator, refreshNHL, setNhlRotationMs } from "./panels/nhl.js";
import { initWeatherRotator, refreshWeather, setWeatherRotationMs } from "./panels/weather.js";
import { refreshCalendar } from "./panels/calendar.js";
import { renderClock } from "./panels/clock.js";
import { hasCountdowns, renderCountdown, setCountdowns } from "./panels/countdown.js";
import { initRssRotator, refreshRSS, setRssRotationMs } from "./panels/rss.js";

const REFRESH_NHL_MS = 30 * 1000;
const REFRESH_WEATHER_MS = 10 * 60 * 1000;

async function start() {
  let calendarEnabled = false;
  try {
    const cfg = await fetchJson("/api/config");
    const secs = cfg?.rotation?.rssSeconds;
    if (typeof secs === "number" && secs > 0) setRssRotationMs(secs * 1000);
    const wxSecs = cfg?.rotation?.weatherPanelSeconds;
    if (typeof wxSecs === "number" && wxSecs > 0) setWeatherRotationMs(wxSecs * 1000);
    // Default nhlPanelSeconds to weatherPanelSeconds if not explicitly set.
    const nhlSecs = cfg?.rotation?.nhlPanelSeconds ?? cfg?.rotation?.weatherPanelSeconds;
    if (typeof nhlSecs === "number" && nhlSecs > 0) setNhlRotationMs(nhlSecs * 1000);
    calendarEnabled = !!cfg?.calendar?.enabled;
    setCountdowns(Array.isArray(cfg?.countdowns) ? cfg.countdowns : []);
  } catch (e) { /* fall back to default */ }

  // Build the weather views list based on what's actually configured.
  const weatherViews = ["weather"];
  if (calendarEnabled) weatherViews.push("calendar");
  weatherViews.push("clock");
  if (hasCountdowns()) weatherViews.push("countdown");

  initNhlRotator();
  initWeatherRotator(weatherViews);
  initRssRotator();

  refreshNHL(); setInterval(refreshNHL, REFRESH_NHL_MS);
  refreshWeather(); setInterval(refreshWeather, REFRESH_WEATHER_MS);
  refreshRSS();  // rotation timer takes over from here; each rotation fetches.

  if (calendarEnabled) {
    refreshCalendar(); setInterval(refreshCalendar, 5 * 60 * 1000);
  }
  if (hasCountdowns()) {
    // Re-render hourly so the day count rolls over at midnight without a page reload.
    renderCountdown(); setInterval(renderCountdown, 60 * 60 * 1000);
  }

  // Clock ticks every minute; render immediately so it's ready when rotation lands on it.
  renderClock(); setInterval(renderClock, 60 * 1000);

  // Keep "X ago" labels accurate as time passes between data refreshes.
  setInterval(refreshUpdatedLabels, 5 * 1000);

  setupDebugOverlay();
  watchVersion();
}

start();
