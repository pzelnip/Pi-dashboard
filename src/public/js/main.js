// Bootstrap: background, start(), wake/day-rollover recovery, version watching.

// ---------- Bootstrap ----------

let calendarEnabled = false;

// Wallpaper behind the whole layout, served from /api/background (a file on
// the Pi named by config.background.image). Everything is opt-in: with no
// image configured the body classes are never added and the flat dark theme
// is untouched. dim/blur arrive from the server already clamped.
function applyBackground(bg) {
  if (!bg || !bg.enabled) return;
  const root = document.documentElement;
  // No cache-buster: the server sends an ETag and the browser revalidates on
  // every load, so a swapped-out file still shows up after a reload.
  const imageUrl = "/api/background";
  root.style.setProperty("--bg-image", `url("${imageUrl}")`);
  if (typeof bg.dim === "number") root.style.setProperty("--bg-dim", String(bg.dim));
  // Read by the live-glass effect's backdrop-filter; the default look uses the
  // pre-blurred copy from frostBackground() instead.
  if (typeof bg.blur === "number") root.style.setProperty("--bg-blur", `${bg.blur}px`);
  document.body.classList.add("has-bg");
  // blur: 0 means "translucent panels, no frosting" — the panels just show
  // the photo through their tint.
  const blur = typeof bg.blur === "number" ? bg.blur : 18;
  if (blur > 0) frostBackground(imageUrl, blur);
}

// The Pi composites in software, so a live backdrop-filter re-blurs the whole
// wallpaper under every panel on each frame that touches it (fades, the 1Hz
// season countdown) and pins a CPU core. Instead, blur the wallpaper once into
// a small canvas and hand that to the panels as a fixed, viewport-aligned
// background (see body.has-bg-blur .panel). Same look, no per-frame blur.
// Sized for the current window; the kiosk never resizes, so it isn't redone.
function frostBackground(imageUrl, blurPx) {
  const img = new Image();
  img.onload = () => {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;
    // Blurred output doesn't need full resolution; a quarter-size canvas is
    // cheaper to build and indistinguishable once upscaled.
    const scale = 0.25;
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    // blurPx is in design px (pre-zoom); the photo is drawn at `cover` scale
    // in screen px. Convert to canvas px so the result matches what
    // backdrop-filter drew.
    const cover = Math.max(innerWidth / iw, innerHeight / ih);
    const r = (blurPx * fitZoom / cover) * scale;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.filter = `blur(${r}px) saturate(135%)`;
    // Overdraw past the edges so the blur doesn't pull in transparent pixels
    // and leave a dark fringe; the slight stretch vanishes under the blur.
    const pad = r * 3;
    ctx.drawImage(img, -pad, -pad, w + pad * 2, h + pad * 2);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const root = document.documentElement;
      root.style.setProperty("--bg-image-frosted", `url("${URL.createObjectURL(blob)}")`);
      document.body.classList.add("has-bg-blur");
    });
  };
  img.src = imageUrl;
}

async function start() {
  try {
    const cfg = await fetchJson("/api/config");
    const secs = cfg?.rotation?.rssSeconds;
    if (typeof secs === "number" && secs > 0) rssRotationMs = secs * 1000;
    const wxSecs = cfg?.rotation?.weatherPanelSeconds;
    if (typeof wxSecs === "number" && wxSecs > 0) weatherRotationMs = wxSecs * 1000;
    // Default nhlPanelSeconds to weatherPanelSeconds if not explicitly set.
    const nhlSecs = cfg?.rotation?.nhlPanelSeconds ?? cfg?.rotation?.weatherPanelSeconds;
    if (typeof nhlSecs === "number" && nhlSecs > 0) nhlRotationMs = nhlSecs * 1000;
    fxConfig = cfg;
    calendarEnabled = !!cfg?.calendar?.enabled;
    countdowns = Array.isArray(cfg?.countdowns) ? cfg.countdowns : [];
    applyBackground(cfg?.background);
  } catch (e) { /* fall back to default */ }
  applyEffects();

  // Build the weather views list based on what's actually configured.
  const weatherViews = ["weather"];
  if (calendarEnabled) weatherViews.push("calendar");
  weatherViews.push("clock");
  if (countdowns.length) weatherViews.push("countdown");

  nhlRotator = createRotator({
    dotsEl: document.getElementById("nhl-dots"),
    navEl: document.getElementById("nhl-nav"),
    viewsContainer: document.getElementById("nhl"),
    viewClassPrefix: "view-nhl-",
    titleEl: document.getElementById("nhl-title-text"),
    titles: NHL_TITLES,
    views: ["today"],  // refreshNHL() expands to ["today","yesterday"] when appropriate
    getRotationMs: () => nhlRotationMs,
    swipeEl: bodyEl("nhl"),
  });
  nhlRotator.start();

  weatherRotator = createRotator({
    dotsEl: document.getElementById("weather-dots"),
    navEl: document.getElementById("weather-nav"),
    viewsContainer: document.getElementById("weather"),
    viewClassPrefix: "view-",
    titleEl: document.getElementById("weather-title-text"),
    titles: WEATHER_TITLES,
    views: weatherViews,
    getRotationMs: () => weatherRotationMs,
    onShow: onWeatherViewShown,
    swipeEl: bodyEl("weather"),
  });
  weatherRotator.start();

  rssRotator = createRotator({
    dotsEl: document.getElementById("rss-dots"),
    navEl: document.getElementById("rss-nav"),
    views: ["0"],  // renderRSS expands once we know the page count
    getRotationMs: () => rssRotationMs,
    onShow: onRssViewShown,
    swipeEl: bodyEl("rss"),
  });
  rssRotator.start();

  refreshNHL(); setInterval(refreshNHL, REFRESH_NHL_MS);
  refreshWeather(); setInterval(refreshWeather, REFRESH_WEATHER_MS);
  refreshRSS();  // rotation timer takes over from here; each rotation fetches.

  if (calendarEnabled) {
    refreshCalendar(); setInterval(refreshCalendar, 5 * 60 * 1000);
  }
  if (countdowns.length) {
    // Re-render hourly so the day count rolls over at midnight without a page reload.
    renderCountdown(); setInterval(renderCountdown, 60 * 60 * 1000);
  }

  // Clock ticks on each minute boundary; render immediately so it's ready when rotation lands on it.
  renderClock(); scheduleClockTick();

  // "Puck Drop" countdown ticks every second while its view is on-screen.
  setInterval(tickNhlSeason, 1000);

  // Keep "X ago" labels accurate as time passes between data refreshes.
  setInterval(refreshUpdatedLabels, 5 * 1000);

  setupDebugOverlay();
  setupGameDetails();
  watchVersion();
  watchWake();
}


// The debug overlay's code lives in debug.js, which only loads the first time
// the overlay is opened (the debug dot, or the d / ? keys). Once loaded,
// initDebugOverlay wires up its own listeners and these stubs step aside.
function setupDebugOverlay() {
  const dot = document.getElementById("debug-dot");
  if (!dot) return;
  const load = (e) => {
    e.preventDefault();
    dot.removeEventListener("click", load);
    document.removeEventListener("keydown", onKey);
    loadScript("js/debug.js").then(() => initDebugOverlay(true), err => console.error(err));
  };
  const onKey = (e) => {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.key === "d" || e.key === "D" || e.key === "?") load(e);
  };
  dot.addEventListener("click", load);
  document.addEventListener("keydown", onKey);
}

// ---------- Wake / day-rollover recovery ----------

// A backgrounded tab gets its timers throttled, and once the browser freezes or
// discards it they stop firing altogether — so on return everything on screen is
// as stale as the moment the tab lost focus. Most of the dashboard is also
// "today"-relative (the NHL slate, the calendar, the countdowns, the clock all
// anchor on the local date when they render), which means a tab that sat through
// midnight quietly shows yesterday's dashboard. So we re-check on every plausible
// resume signal and either hard-reload (date moved on) or re-fetch (same day, but
// we were away long enough for the data to have gone stale).

const RESUME_STALE_MS = 5 * 60 * 1000;

const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

let _awakeDay = dayKey();
let _awakeAt = Date.now();

function refreshAllPanels() {
  refreshNHL();
  refreshWeather();
  refreshRSS();
  if (calendarEnabled) refreshCalendar();
  if (countdowns.length) renderCountdown();
  renderClock();
}

function onWake() {
  if (dayKey() !== _awakeDay) {
    // Reload rather than refresh: a fresh document re-derives every date-anchored
    // view from scratch, and picks up any deploy we slept through.
    location.reload();
    return;
  }
  const away = Date.now() - _awakeAt;
  _awakeAt = Date.now();
  if (away >= RESUME_STALE_MS) {
    refreshAllPanels();
    checkVersion();
  }
}

function watchWake() {
  // Kiosk case: the tab is never hidden, so this interval is what catches
  // midnight. Backgrounded-tab case: the interval is throttled or frozen, and
  // the events below are what catch the return.
  setInterval(onWake, 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) onWake(); });
  window.addEventListener("focus", onWake);
  window.addEventListener("pageshow", onWake);  // back/forward-cache restore
}

// Captured at startup; read by fireUpdate so it can fast-poll for a SHA
// flip without waiting up to 30s for the next watchVersion tick.
let initialVersion = null;

async function checkVersion() {
  try {
    const { version } = await fetchJson("/api/version");
    if (!version) return;
    // First successful read just establishes the baseline — including when the
    // read at startup failed, so a transient blip doesn't disable the watcher.
    if (!initialVersion) initialVersion = version;
    else if (version !== initialVersion) location.reload();
  } catch { /* transient — try again next tick */ }
}

async function watchVersion() {
  await checkVersion();
  setInterval(checkVersion, 30 * 1000);
}

// Fill the views that share markup across panels (clock, countdown) from
// their <template> before anything renders into them.
document.querySelectorAll("[data-template]").forEach(view => {
  view.append(document.getElementById(`tpl-${view.dataset.template}`).content.cloneNode(true));
});

start();
