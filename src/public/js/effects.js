// Visual effects: per-browser presets and the helpers individual effects use.

// ---------- Visual effects ----------

// Effects that are cheap on a desktop GPU but costly on the Pi, which draws
// every frame in software. Each effect resolves per browser from the first
// source that sets it:
//
//   URL (?fade=150)  →  saved in this browser (debug panel → Display)
//                    →  server config  →  the active preset's value
//
// The preset itself resolves the same way: ?fx=lite, saved, config
// effects.preset, else "full". So an explicit setting always beats a preset.
// The kiosk loads ?fx=lite (runKiosk.sh); everything else defaults to full.
//
// To add an effect: give it a value in each preset, an FX_SETTINGS entry, and
// an apply() that pushes it into the page (usually a CSS var or body class).
// The debug panel's Display view picks it up automatically.
// lite keeps every optional effect off: the Pi composites in software, and
// even small continuous animations cost it a sizeable share of a core.
const FX_PRESETS = {
  full: {
    fade: 400, transition: "rise", liveGlass: true, drift: true, weather: true,
    stagger: true, goals: true, clockRoll: true, clockSeconds: "full", tilt: true,
    progress: true, newStories: true, timeOfDay: true, glassPolish: true,
    finals: true, livePulse: true,
  },
  lite: {
    fade: 150, transition: "fade", liveGlass: false, drift: false, weather: false,
    stagger: false, goals: false, clockRoll: false, clockSeconds: "off", tilt: false,
    progress: false, newStories: false, timeOfDay: false, glassPolish: false,
    finals: false, livePulse: false,
  },
};
const FX_DEFAULT_PRESET = "full";
const FX_STORAGE_KEY = "dashboard.fx";
const FX_TRANSITIONS = ["fade", "rise", "zoom", "blur"];
const FX_CLOCK_SECONDS = ["off", "simple", "full"];

// An on/off effect that toggles body.fx-<cls>; `after` runs once the flag is
// set, for effects that need to re-render something.
function fxToggle(label, hint, cls, after) {
  return {
    label, hint,
    input: { type: "toggle" },
    parse: parseFxBool,
    apply(on) {
      document.body.classList.toggle(`fx-${cls}`, on);
      if (after) after(on);
    },
  };
}

const FX_SETTINGS = {
  fade: {
    label: "Fade length",
    unit: "ms",
    hint: "Cross-fade between views; 0 = instant. The news fade is half this.",
    input: { type: "number", min: 0, max: 2000, step: 50 },
    parse: parseFadeMs,
    fromConfig: (cfg) => cfg?.rotation?.fade,
    apply(ms) {
      fadeMs = ms;
      const root = document.documentElement.style;
      root.setProperty("--fade-view", `${ms}ms`);
      root.setProperty("--fade-rss", `${Math.round(ms / 2)}ms`);
    },
  },
  transition: {
    label: "View transition",
    hint: "How views swap: fade, rise (fade + lift), zoom, or blur. Takes the fade length.",
    input: { type: "select", options: FX_TRANSITIONS },
    parse: (v) => (FX_TRANSITIONS.includes(v) ? v : null),
    apply(style) { document.body.dataset.fxTransition = style; },
  },
  liveGlass: fxToggle("Live glass",
    "Panels blur the wallpaper live (backdrop-filter) instead of a pre-blurred copy.", "live-glass"),
  drift: fxToggle("Drifting wallpaper",
    "The wallpaper slowly pans and zooms. Uses live glass so the panels follow it.", "drift"),
  weather: fxToggle("Weather scenes",
    "Animated rain, snow, stars, clouds, fog and lightning behind the weather.", "weather",
    () => { if (_lastWeatherData) { renderWeather(_lastWeatherData); renderNhlWeather(); } }),
  stagger: fxToggle("Staggered entrances",
    "Cards, forecast days and headlines slide in one after another when a view appears.", "stagger"),
  goals: fxToggle("Goal celebrations",
    "A burst and glow on a game card when a live score goes up.", "goals"),
  clockRoll: fxToggle("Rolling clock",
    "Clock digits roll into place when they change.", "clock-roll"),
  clockSeconds: {
    label: "Clock seconds",
    hint: "Seconds under the clock's AM/PM: off, simple (no animation), or full (they roll in). Off ticks the clock once a minute.",
    input: { type: "select", options: FX_CLOCK_SECONDS },
    parse: (v) => (FX_CLOCK_SECONDS.includes(v) ? v : null),
    apply(mode) {
      document.body.dataset.fxClockSeconds = mode;
      // Once the clock is running, redraw now and re-arm at the new cadence.
      if (_clockTimer) { renderClock(); scheduleClockTick(); }
    },
  },
  tilt: fxToggle("Panel tilt",
    "Panels tilt toward the pointer with a glossy sheen (mouse only).", "tilt", setupPanelTilt),
  progress: fxToggle("Rotation progress",
    "A thin bar under the dots fills up as the view's time runs out, so you can see the next change coming.", "progress"),
  newStories: fxToggle("New-story highlights",
    "Headlines this browser hasn't shown before get a brief glow, and the news icon lights up.", "new-stories"),
  timeOfDay: fxToggle("Time-of-day tint",
    "The wallpaper's tint shifts through the day: cool morning, neutral midday, warm evening, deep-blue night.",
    "tod", updateTimeOfDay),
  glassPolish: fxToggle("Glass polish",
    "Panels get a lit top edge, a soft gradient and a faint inner glow.", "glass-polish"),
  finals: fxToggle("Final-score settle",
    "When a live game ends, the winner's row lights up and the FINAL pill settles in.", "finals"),
  livePulse: fxToggle("Live pulse",
    "The red dot on LIVE games pulses, and so does the live game's pill in game details.", "live-pulse"),
};

let fxConfig = null;  // /api/config payload, kept so a saved change can re-resolve
let fxState = null;   // { preset: {value, source}, <effect>: {value, source}, … }
const fxOn = {};      // effect key -> current value, for code that checks a flag

function parseFxBool(value) {
  if (value === true || value === false) return value;
  const v = String(value ?? "").toLowerCase();
  if (["1", "on", "true", "yes"].includes(v)) return true;
  if (["0", "off", "false", "no"].includes(v)) return false;
  return null;
}

// A fade as ms, or null if the value isn't one: a number (or numeric string,
// from the URL), true for the full preset's length, false for none.
function parseFadeMs(value) {
  if (value === true) return FX_PRESETS.full.fade;
  if (value === false) return 0;
  if (value == null || value === "") return null;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(Math.round(ms), 2000) : null;
}

function parseFxPreset(value) {
  return typeof value === "string" && Object.hasOwn(FX_PRESETS, value) ? value : null;
}

// Settings saved in this browser. Storage can be missing or throw (private
// windows, cleared site data), so every access degrades to "nothing saved".
function loadSavedFx() {
  try {
    const saved = JSON.parse(localStorage.getItem(FX_STORAGE_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch (e) { return {}; }
}

function saveFx(settings) {
  try {
    if (Object.keys(settings).length) localStorage.setItem(FX_STORAGE_KEY, JSON.stringify(settings));
    else localStorage.removeItem(FX_STORAGE_KEY);
    return true;
  } catch (e) { return false; }
}

function resolveFx(cfg) {
  const url = new URLSearchParams(location.search);
  const saved = loadSavedFx();
  const pick = (parse, sources) => {
    for (const [source, raw] of sources) {
      const value = parse(raw);
      if (value != null) return { value, source };
    }
    return null;
  };
  const state = {
    preset: pick(parseFxPreset, [["url", url.get("fx")], ["saved", saved.preset], ["config", cfg?.effects?.preset]])
      ?? { value: FX_DEFAULT_PRESET, source: "default" },
  };
  for (const [key, def] of Object.entries(FX_SETTINGS)) {
    const fromConfig = def.fromConfig ? def.fromConfig(cfg) : cfg?.effects?.[key];
    state[key] = pick(def.parse, [["url", url.get(key)], ["saved", saved[key]], ["config", fromConfig]])
      ?? { value: FX_PRESETS[state.preset.value][key], source: "preset" };
  }
  return state;
}

function applyEffects() {
  fxState = resolveFx(fxConfig);
  for (const key of Object.keys(FX_SETTINGS)) fxOn[key] = fxState[key].value;
  for (const [key, def] of Object.entries(FX_SETTINGS)) def.apply(fxState[key].value);
}

// ---- Effect helpers ----

// Panel tilt: panels lean a few degrees toward the pointer, and a soft sheen
// follows it. Pointer devices only; listeners stay attached once added and
// simply do nothing while the effect is off.
let _tiltReady = false;
function setupPanelTilt(on) {
  if (!on || _tiltReady || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  _tiltReady = true;
  document.querySelectorAll(".panel").forEach(panel => {
    panel.addEventListener("pointermove", (e) => {
      if (!fxOn.tilt) return;
      const r = panel.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      panel.style.setProperty("--tilt-x", `${((0.5 - y) * 4).toFixed(2)}deg`);
      panel.style.setProperty("--tilt-y", `${((x - 0.5) * 4).toFixed(2)}deg`);
      panel.style.setProperty("--sheen-x", `${(x * 100).toFixed(1)}%`);
      panel.style.setProperty("--sheen-y", `${(y * 100).toFixed(1)}%`);
      panel.classList.add("fx-tilting");
    });
    panel.addEventListener("pointerleave", () => {
      panel.classList.remove("fx-tilting");
      panel.style.setProperty("--tilt-x", "0deg");
      panel.style.setProperty("--tilt-y", "0deg");
    });
  });
}

// Weather scene layer for the .wx-sky backdrop: a handful of absolutely
// positioned spans the CSS animates (rain streaks, flakes, stars, clouds, fog
// bands, a lightning flash). Randomised per render so it doesn't look tiled.
function buildWeatherFx(skyClasses) {
  const layer = document.createElement("div");
  layer.className = "wx-fx";
  layer.setAttribute("aria-hidden", "true");
  const has = c => skyClasses.includes(c);
  const night = has("wx-night");
  const rand = (min, max) => (min + Math.random() * (max - min)).toFixed(2);
  const add = (cls, count, style) => {
    for (let i = 0; i < count; i++) {
      const s = document.createElement("span");
      s.className = cls;
      s.setAttribute("style", style(i));
      layer.appendChild(s);
    }
  };
  if (has("wx-sky-rain") || has("wx-sky-storm")) {
    add("fx-rain", has("wx-sky-storm") ? 70 : 50, () =>
      `left:${rand(-5, 115)}%;--d:${rand(0.55, 0.95)}s;animation-delay:-${rand(0, 1)}s;--l:${rand(18, 34)}px;opacity:${rand(0.4, 0.85)}`);
  }
  if (has("wx-sky-storm")) add("fx-lightning", 1, () => `--d:${rand(7, 11)}s`);
  if (has("wx-sky-snow")) {
    add("fx-snow", 45, () =>
      `left:${rand(-5, 105)}%;--d:${rand(6, 12)}s;animation-delay:-${rand(0, 12)}s;--s:${rand(3, 7)}px;--sway:${rand(-30, 30)}px;opacity:${rand(0.5, 0.95)}`);
  }
  if (has("wx-sky-clouds") || has("wx-sky-rain") || has("wx-sky-storm") || has("wx-sky-snow")) {
    add("fx-cloud", 4, i =>
      `top:${rand(-12, 40)}%;--w:${rand(300, 520)}px;--d:${rand(60, 110)}s;animation-delay:-${rand(0, 110)}s;opacity:${rand(0.22, 0.42)}`);
  }
  if (has("wx-sky-fog")) {
    add("fx-fog", 3, i => `top:${20 + i * 25}%;--d:${rand(40, 70)}s;animation-delay:-${rand(0, 70)}s`);
  }
  if (night && (has("wx-sky-clear") || has("wx-sky-clouds"))) {
    // Mostly in the open sky above the forecast strip, where they show.
    add("fx-star", 55, i =>
      `left:${rand(0, 100)}%;top:${i < 45 ? rand(0, 42) : rand(42, 100)}%;--d:${rand(2.5, 6)}s;animation-delay:-${rand(0, 6)}s;--s:${rand(1, 2.8)}px`);
  }
  if (!night && has("wx-sky-clear")) add("fx-rays", 1, () => "");
  return layer;
}

// Clock digits that roll in when they change. The previous string rides on a
// data attribute so only the digits that actually changed animate.
function renderRollingDigits(el, text) {
  const prev = el.dataset.prev || "";
  el.dataset.prev = text;
  el.replaceChildren(...[...text].map((ch, i) => {
    const s = document.createElement("span");
    s.className = "fx-digit" + (prev && prev[i] !== ch ? " fx-roll" : "");
    s.textContent = ch;
    return s;
  }));
}

// Score events for goal celebrations and the final-score settle: remember
// each of today's games (score + whether it was live) so the next render can
// tell what just happened. Keyed by game id. Nothing fires on the first
// sighting of a game, so a page load never replays old goals or finals.
const _gameMemory = {};
function scoreEventsFor(g, live, final) {
  if ((!fxOn.goals && !fxOn.finals) || g.id == null) return {};
  const prev = _gameMemory[g.id];
  const now = { away: Number(g.away.score) || 0, home: Number(g.home.score) || 0, live };
  _gameMemory[g.id] = now;
  if (!prev) return {};
  const events = {};
  if (fxOn.goals && live) {
    if (now.away > prev.away) events.goal = "away";
    else if (now.home > prev.home) events.goal = "home";
  }
  if (fxOn.finals && final && prev.live) events.justFinal = true;
  return events;
}

// Time-of-day tint: a colour washed over the wallpaper, interpolated between
// these hour stops (local time, wrapping at midnight) and written to
// --tod-tint. Updated every few minutes, so the change is never visible.
const TOD_STOPS = [
  [0, [20, 40, 110, 0.22]],     // night
  [5, [40, 50, 120, 0.18]],     // before dawn
  [7, [255, 150, 120, 0.10]],   // dawn
  [9, [170, 210, 255, 0.08]],   // cool morning
  [13, [255, 255, 255, 0]],     // neutral midday
  [17, [255, 190, 110, 0.10]],  // golden afternoon
  [19.5, [255, 125, 80, 0.15]], // sunset
  [21, [90, 60, 140, 0.16]],    // dusk
  [23, [20, 40, 110, 0.22]],    // night
  [24, [20, 40, 110, 0.22]],
];
function timeOfDayTint(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  let i = 0;
  while (i < TOD_STOPS.length - 2 && TOD_STOPS[i + 1][0] <= h) i++;
  const [h0, c0] = TOD_STOPS[i];
  const [h1, c1] = TOD_STOPS[i + 1];
  const t = (h - h0) / (h1 - h0);
  const c = c0.map((v, k) => v + (c1[k] - v) * t);
  return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${c[3].toFixed(3)})`;
}
let _todTimer = null;
function updateTimeOfDay(on) {
  clearInterval(_todTimer);
  _todTimer = null;
  if (!on) return;
  const set = () => document.documentElement.style.setProperty("--tod-tint", timeOfDayTint());
  set();
  _todTimer = setInterval(set, 5 * 60 * 1000);
}

// New-story highlights: the headlines this browser has already shown, kept in
// localStorage so a reload (e.g. the kiosk's nightly restart) doesn't make
// everything "new" again. The very first run seeds the list without
// highlighting anything.
const SEEN_STORIES_KEY = "dashboard.seenStories";
const SEEN_STORIES_MAX = 600;
let _seenStories = null;
function storyKey(item) {
  return item.link || `${item.feedName || ""}|${item.title || ""}`;
}
// Returns the set of keys among `items` that are new, and records them all.
function takeNewStories(items) {
  if (!fxOn.newStories) return new Set();
  let firstRun = false;
  if (!_seenStories) {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(SEEN_STORIES_KEY) || "null"); } catch (e) { /* treat as none */ }
    firstRun = !Array.isArray(stored);
    _seenStories = new Set(Array.isArray(stored) ? stored : []);
  }
  const fresh = new Set();
  for (const item of items) {
    const key = storyKey(item);
    if (!_seenStories.has(key)) {
      if (!firstRun) fresh.add(key);
      _seenStories.add(key);
    }
  }
  if (_seenStories.size > SEEN_STORIES_MAX) {
    _seenStories = new Set([..._seenStories].slice(-SEEN_STORIES_MAX));
  }
  try { localStorage.setItem(SEEN_STORIES_KEY, JSON.stringify([..._seenStories])); } catch (e) { /* in-memory only */ }
  return fresh;
}
