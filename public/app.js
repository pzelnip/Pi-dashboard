// Dashboard client: polls /api/* on independent schedules and renders into panels.

const REFRESH_NHL_MS = 30 * 1000;
const REFRESH_WEATHER_MS = 10 * 60 * 1000;
const REFRESH_RSS_MS = 15 * 60 * 1000;

let rssIndex = 0;
let rssTotal = 1;
let rssRotationMs = 30 * 1000;
let rssRotationTimer = null;
let rssFadeTimer = null;

const _lastUpdated = {};  // { panelName: Date }

function formatAgo(ms) {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function setUpdated(panel) {
  _lastUpdated[panel] = new Date();
  refreshUpdatedLabels();
}

function refreshUpdatedLabels() {
  const now = Date.now();
  for (const [panel, when] of Object.entries(_lastUpdated)) {
    const el = document.querySelector(`[data-updated-for="${panel}"]`);
    if (el) el.textContent = formatAgo(now - when.getTime());
  }
}

function bodyEl(panel) {
  return document.querySelector(`[data-body="${panel}"]`);
}

function showError(panel, message) {
  const el = bodyEl(panel);
  el.classList.add("error");
  el.classList.remove("stale");
  el.textContent = `⚠ ${message}`;
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ---------- NHL ----------

function renderNHL(games, containerSelector, emptyMessage = "No games.") {
  const el = document.querySelector(containerSelector);
  if (!el) return;
  el.classList.remove("error");
  if (!games || !games.length) {
    el.innerHTML = `<p style="color: var(--text-muted)">${emptyMessage}</p>`;
    return;
  }

  const startTime = iso =>
    new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

  const isLive = g => g.state === "LIVE" || g.state === "CRIT";
  const isScheduled = g => g.state === "FUT" || g.state === "PRE";
  const isFinal = g => !isLive(g) && !isScheduled(g);

  // Sort: live → scheduled → final, with favorites bubbled to the top of each group.
  const statusRank = g => (isLive(g) ? 0 : isScheduled(g) ? 1 : 2);
  const sorted = [...games].sort((a, b) => {
    const s = statusRank(a) - statusRank(b);
    if (s !== 0) return s;
    return (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0);
  });

  const pillFor = g => {
    if (isLive(g)) return `<span class="status-pill live">${g.statusText || "LIVE"}</span>`;
    if (isScheduled(g)) return `<span class="status-pill scheduled">${startTime(g.startTime)}</span>`;
    return `<span class="status-pill final">${g.statusText || "Final"}</span>`;
  };

  const row = (t, outcome, isFav, venue) => `
    <div class="game-team ${outcome} ${venue}">
      ${t.logo ? `<img class="team-logo" src="${t.logo}" alt="" onerror="this.remove()">` : ""}
      <span class="team-name">${t.name || t.abbrev}${isFav ? ' <span class="fav-star" aria-label="Favorite team">★</span>' : ""}</span>
      <span class="team-score">${t.score ?? ""}</span>
    </div>`;

  const renderGame = g => {
    let awayCls = "", homeCls = "";
    const bothScores = g.away.score != null && g.home.score != null;
    if (isFinal(g) && bothScores) {
      if (g.away.score > g.home.score) { awayCls = "winner"; homeCls = "loser"; }
      else if (g.home.score > g.away.score) { homeCls = "winner"; awayCls = "loser"; }
    } else if (isLive(g) && bothScores) {
      if (g.away.score > g.home.score) awayCls = "leading";
      else if (g.home.score > g.away.score) homeCls = "leading";
    }
    const stateCls = isLive(g) ? "is-live" : isFinal(g) ? "is-final" : "";
    return `
    <div class="game ${stateCls}">
      <div class="game-meta">
        ${pillFor(g)}
        ${g.seriesText ? `<span class="series-tag">${g.seriesText}</span>` : ""}
      </div>
      <div class="game-body">
        <div class="game-teams">
          ${row(g.away, awayCls, g.away.isFavorite, "away")}
          ${row(g.home, homeCls, g.home.isFavorite, "home")}
        </div>
      </div>
    </div>`;
  };

  el.innerHTML = `<div class="games-grid">${sorted.map(renderGame).join("")}</div>`;
}

// ---------- NHL panel rotation (today ↔ yesterday) ----------

const NHL_VIEWS = ["today", "yesterday"];
const NHL_TITLES = { today: "NHL Scores", yesterday: "Yesterday" };
let nhlViewIndex = 0;
let nhlRotationMs = 10000;
let nhlRotationTimer = null;
let nhlTwoViewMode = false;

function showNhlView(i) {
  nhlViewIndex = ((i % NHL_VIEWS.length) + NHL_VIEWS.length) % NHL_VIEWS.length;
  const active = NHL_VIEWS[nhlViewIndex];

  document.querySelectorAll("#nhl .view").forEach(v => {
    v.classList.toggle("active", v.classList.contains(`view-nhl-${active}`));
  });

  document.getElementById("nhl-title-text").textContent = NHL_TITLES[active];

  document.querySelectorAll("#nhl-dots .rss-dot").forEach((btn, idx) => {
    btn.classList.toggle("active", idx === nhlViewIndex);
  });
}

function renderNhlDots() {
  const dotsEl = document.getElementById("nhl-dots");
  dotsEl.innerHTML = NHL_VIEWS.map((_, i) =>
    `<button class="rss-dot ${i === nhlViewIndex ? 'active' : ''}" data-nhl-view="${i}" aria-label="View ${i + 1}"></button>`
  ).join("");
  dotsEl.querySelectorAll(".rss-dot").forEach(btn => {
    btn.addEventListener("click", () => jumpToNhlView(Number(btn.dataset.nhlView)));
  });
}

function clearNhlDots() {
  document.getElementById("nhl-dots").innerHTML = "";
}

function rotateNhlPanel() {
  showNhlView(nhlViewIndex + 1);
}

function startNhlRotationTimer() {
  if (nhlRotationTimer) clearInterval(nhlRotationTimer);
  nhlRotationTimer = setInterval(rotateNhlPanel, nhlRotationMs);
}

function stopNhlRotationTimer() {
  if (nhlRotationTimer) {
    clearInterval(nhlRotationTimer);
    nhlRotationTimer = null;
  }
}

function jumpToNhlView(i) {
  if (i === nhlViewIndex) return;
  showNhlView(i);
  startNhlRotationTimer();
}

function updateNhlMode(data) {
  const canRotate = !!(data.yesterday && !data.hasLiveToday);
  if (canRotate) {
    if (!nhlTwoViewMode) {
      nhlTwoViewMode = true;
      renderNhlDots();
      startNhlRotationTimer();
    }
  } else {
    if (nhlTwoViewMode) {
      nhlTwoViewMode = false;
      stopNhlRotationTimer();
      clearNhlDots();
    }
    // Force today view and reset title
    nhlViewIndex = 0;
    document.querySelectorAll("#nhl .view").forEach(v => {
      v.classList.toggle("active", v.classList.contains("view-nhl-today"));
    });
    document.getElementById("nhl-title-text").textContent = "NHL Scores";
  }
}

async function refreshNHL() {
  try {
    const data = await fetchJson("/api/nhl");
    if (data && data.error) {
      showError("nhl", data.error);
      return;
    }
    renderNHL(data.today?.games, "#nhl .view-nhl-today", "No games today.");
    if (data.yesterday) {
      renderNHL(data.yesterday.games, "#nhl .view-nhl-yesterday", "No games yesterday.");
    }
    updateNhlMode(data);
    setUpdated("nhl");
  } catch (e) {
    showError("nhl", e.message);
  }
}

// ---------- Weather ----------

// Open-Meteo WMO weather codes -> short label + emoji.
const WX_CODES = {
  0: ["Clear", "☀️"], 1: ["Mostly clear", "🌤"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
  45: ["Fog", "🌫"], 48: ["Freezing fog", "🌫"],
  51: ["Drizzle", "🌦"], 53: ["Drizzle", "🌦"], 55: ["Drizzle", "🌦"],
  61: ["Rain", "🌧"], 63: ["Rain", "🌧"], 65: ["Heavy rain", "🌧"],
  71: ["Snow", "🌨"], 73: ["Snow", "🌨"], 75: ["Heavy snow", "🌨"],
  80: ["Showers", "🌦"], 81: ["Showers", "🌦"], 82: ["Heavy showers", "🌦"],
  95: ["Thunderstorm", "⛈"], 96: ["Thunderstorm", "⛈"], 99: ["Thunderstorm", "⛈"],
};

function wxLabel(code) {
  return WX_CODES[code] || [`code ${code}`, "·"];
}

function renderWeather(data) {
  document.getElementById("weather-label").textContent = data.label ? `· ${data.label}` : "";
  const el = document.querySelector("#weather .view-weather");
  el.classList.remove("error");

  const cur = data.current || {};
  const curUnits = (data.units && data.units.current) || {};
  const [curDesc, curIcon] = wxLabel(cur.weather_code);
  const tempUnit = curUnits.temperature_2m || "°C";
  const windUnit = curUnits.wind_speed_10m || "km/h";

  const daily = data.daily || {};
  const days = (daily.time || []).map((d, i) => {
    const [desc, icon] = wxLabel((daily.weather_code || [])[i]);
    return { date: d, icon, desc, max: (daily.temperature_2m_max || [])[i], min: (daily.temperature_2m_min || [])[i] };
  });

  const dayLabel = (isoDate, i) => {
    if (i === 0) return "Today";
    const d = new Date(isoDate);
    return d.toLocaleDateString([], { weekday: "short" });
  };

  el.innerHTML = `
    <div class="wx-hero">
      <div class="wx-hero-icon">${curIcon}</div>
      <div class="wx-hero-main">
        <div class="wx-temp">${Math.round(cur.temperature_2m)}${tempUnit}</div>
        <div class="wx-condition">${curDesc}</div>
        <div class="wx-meta">
          <span>Wind ${Math.round(cur.wind_speed_10m)} ${windUnit}</span>
          <span>Humidity ${cur.relative_humidity_2m}%</span>
        </div>
      </div>
    </div>
    <div class="wx-daily">
      ${days.map((d, i) => `
        <div class="wx-day">
          <div class="wx-day-label">${dayLabel(d.date, i)}</div>
          <div class="wx-day-icon">${d.icon}</div>
          <div class="wx-day-range"><span class="wx-min">${Math.round(d.min)}°</span> ${Math.round(d.max)}°</div>
        </div>
      `).join("")}
    </div>
  `;
}

async function refreshWeather() {
  try {
    const data = await fetchJson("/api/weather");
    if (data.error) {
      showError("weather", data.error);
    } else {
      renderWeather(data);
    }
    setUpdated("weather");
  } catch (e) {
    showError("weather", e.message);
  }
}

// ---------- Calendar ----------

function renderCalendar(data) {
  const el = document.querySelector("#weather .view-calendar");
  el.classList.remove("error");

  if (data.error) {
    el.innerHTML = `<p class="cal-empty">⚠ ${data.error}</p>`;
    return;
  }
  if (!data.events || !data.events.length) {
    el.innerHTML = '<p class="cal-empty">No events today</p>';
    return;
  }

  const timeLabel = ev => {
    if (ev.allDay) return "All day";
    const d = new Date(ev.start);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  };

  el.innerHTML = data.events.map(ev => `
    <div class="cal-event ${ev.allDay ? "cal-allday" : ""}">
      <span class="cal-time">${timeLabel(ev)}</span>
      <span class="cal-title">${ev.summary}</span>
    </div>
  `).join("");
}

async function refreshCalendar() {
  try {
    const data = await fetchJson("/api/calendar");
    renderCalendar(data);
    setUpdated("weather");
  } catch (e) {
    renderCalendar({ error: e.message });
  }
}

// ---------- Clock ----------

function ordinalSuffix(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

function renderClock() {
  const now = new Date();
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const month = now.toLocaleDateString("en-US", { month: "long" });
  const day = now.getDate();
  const year = now.getFullYear();
  const date = `${weekday}, ${month} ${day}${ordinalSuffix(day)}, ${year}`;
  const timeEl = document.querySelector("#weather .clock-time");
  const dateEl = document.querySelector("#weather .clock-date");
  if (timeEl) timeEl.textContent = time;
  if (dateEl) dateEl.textContent = date;
}

// ---------- Countdown ----------

let countdowns = [];

function daysBetween(fromYmd, toYmd) {
  // Compare midnight-anchored dates to avoid DST / hour-of-day drift.
  const [y1, m1, d1] = fromYmd.split("-").map(Number);
  const [y2, m2, d2] = toYmd.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

function todayYmd() {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, "0");
  const d = String(n.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function pickCountdown() {
  if (!countdowns.length) return null;
  const today = todayYmd();
  const annotated = countdowns.map(c => ({ ...c, days: daysBetween(today, c.date) }));
  const upcoming = annotated.filter(c => c.days >= 0).sort((a, b) => a.days - b.days);
  if (upcoming.length) return upcoming[0];
  // All in the past — pick the most recent.
  return annotated.sort((a, b) => b.days - a.days)[0];
}

function renderCountdown() {
  const numEl = document.querySelector("#weather .countdown-number");
  const labelEl = document.querySelector("#weather .countdown-label");
  if (!numEl || !labelEl) return;

  const c = pickCountdown();
  if (!c) {
    numEl.textContent = "";
    labelEl.textContent = "No countdowns configured";
    return;
  }

  if (c.days === 0) {
    numEl.textContent = "Today";
    labelEl.textContent = `is ${c.title}`;
  } else if (c.days > 0) {
    numEl.textContent = `${c.days} ${c.days === 1 ? "day" : "days"}`;
    labelEl.textContent = `until ${c.title}`;
  } else {
    numEl.textContent = c.title;
    labelEl.textContent = "is past, what's next?";
  }
}

// ---------- Weather panel rotation ----------

const WEATHER_VIEWS = ["weather", "calendar", "clock", "countdown"];
const WEATHER_TITLES = { weather: "Weather", calendar: "Today", clock: "", countdown: "" };
let weatherViewIndex = 0;
let weatherRotationMs = 15000;
let weatherRotationTimer = null;

function showWeatherView(i) {
  weatherViewIndex = ((i % WEATHER_VIEWS.length) + WEATHER_VIEWS.length) % WEATHER_VIEWS.length;
  const active = WEATHER_VIEWS[weatherViewIndex];

  document.querySelectorAll("#weather .view").forEach(v => {
    v.classList.toggle("active", v.classList.contains(`view-${active}`));
  });

  document.getElementById("weather-title-text").textContent = WEATHER_TITLES[active];
  document.getElementById("weather-label").style.display =
    active === "weather" ? "" : "none";

  document.querySelectorAll("#weather-dots .rss-dot").forEach((btn, idx) => {
    btn.classList.toggle("active", idx === weatherViewIndex);
  });
}

function renderWeatherDots() {
  const dotsEl = document.getElementById("weather-dots");
  dotsEl.innerHTML = WEATHER_VIEWS.map((_, i) =>
    `<button class="rss-dot ${i === weatherViewIndex ? 'active' : ''}" data-weather-view="${i}" aria-label="View ${i + 1}"></button>`
  ).join("");
  dotsEl.querySelectorAll(".rss-dot").forEach(btn => {
    btn.addEventListener("click", () => jumpToWeatherView(Number(btn.dataset.weatherView)));
  });
}

function rotateWeatherPanel() {
  showWeatherView(weatherViewIndex + 1);
}

function startWeatherRotationTimer() {
  if (weatherRotationTimer) clearInterval(weatherRotationTimer);
  weatherRotationTimer = setInterval(rotateWeatherPanel, weatherRotationMs);
}

function jumpToWeatherView(i) {
  if (i === weatherViewIndex) return;
  showWeatherView(i);
  startWeatherRotationTimer();
}

// ---------- RSS ----------

// Default RSS icon: orange square with two arcs + dot, standard recognizable mark.
window.DEFAULT_RSS_ICON = `
<svg class="feed-logo feed-logo-default" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="24" height="24" rx="4" fill="#f26522"/>
  <circle cx="6.5" cy="17.5" r="2" fill="#fff"/>
  <path d="M4 4a16 16 0 0 1 16 16h-3A13 13 0 0 0 4 7z" fill="#fff"/>
  <path d="M4 10a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7z" fill="#fff"/>
</svg>`.trim();

function renderRSS(payload) {
  rssTotal = payload.total || 1;
  const logo = payload.feedImage
    ? `<img class="feed-logo" src="${payload.feedImage}" alt="" onerror="this.outerHTML=window.DEFAULT_RSS_ICON">`
    : window.DEFAULT_RSS_ICON;

  const rssPanel = document.getElementById("rss");
  const titleEl = document.getElementById("rss-title");
  const dotsEl = document.getElementById("rss-dots");
  const el = bodyEl("rss");

  const writeContent = () => {
    titleEl.innerHTML = `${logo}<span>${payload.name}</span>`;
    dotsEl.innerHTML = `
      <button class="rss-nav" data-feed-step="-1" aria-label="Previous feed">‹</button>
      <button class="rss-nav" data-feed-step="1" aria-label="Next feed">›</button>
    `;
    dotsEl.querySelectorAll(".rss-nav").forEach(btn => {
      btn.addEventListener("click", () => jumpToFeed(rssIndex + Number(btn.dataset.feedStep)));
    });

    el.classList.remove("error");
    if (!payload.items || !payload.items.length) {
      el.innerHTML = '<p style="color: var(--text-muted)">No items.</p>';
      return;
    }
    el.innerHTML = `<ul class="rss-list">${
      payload.items.map(i => `
        <li class="rss-item">
          <a href="${i.link}" target="_blank" rel="noopener">
            ${i.image
              ? `<img class="rss-thumb" src="${i.image}" alt="" loading="lazy" onerror="this.remove()">`
              : ""}
            <span class="rss-title">${i.title}</span>
          </a>
        </li>
      `).join("")
    }</ul>`;
  };

  // Cross-fade: dim the panel body + header, swap content, fade back in.
  if (rssFadeTimer) clearTimeout(rssFadeTimer);
  rssPanel.classList.add("fading");
  rssFadeTimer = setTimeout(() => {
    writeContent();
    requestAnimationFrame(() => rssPanel.classList.remove("fading"));
    rssFadeTimer = null;
  }, 200);
}

async function refreshRSS() {
  try {
    const data = await fetchJson(`/api/rss?feed=${rssIndex}`);
    if (data.error) {
      showError("rss", data.error);
    } else {
      renderRSS(data);
    }
    setUpdated("rss");
  } catch (e) {
    showError("rss", e.message);
  }
}

function rotateRSS() {
  rssIndex = (rssIndex + 1) % rssTotal;
  refreshRSS();
}

function startRssRotationTimer() {
  if (rssRotationTimer) clearInterval(rssRotationTimer);
  rssRotationTimer = setInterval(rotateRSS, rssRotationMs);
}

function jumpToFeed(i) {
  if (i === rssIndex) return;
  rssIndex = ((i % rssTotal) + rssTotal) % rssTotal;
  refreshRSS();
  startRssRotationTimer();  // reset the timer so user gets a full cycle on the chosen feed
}

// ---------- Bootstrap ----------

async function start() {
  let calendarEnabled = false;
  try {
    const cfg = await fetchJson("/api/config");
    const secs = cfg?.rotation?.rssSeconds;
    if (typeof secs === "number" && secs > 0) rssRotationMs = secs * 1000;
    const wxSecs = cfg?.rotation?.weatherPanelSeconds;
    if (typeof wxSecs === "number" && wxSecs > 0) weatherRotationMs = wxSecs * 1000;
    // Default nhlPanelSeconds to weatherPanelSeconds if not explicitly set.
    const nhlSecs = cfg?.rotation?.nhlPanelSeconds ?? cfg?.rotation?.weatherPanelSeconds;
    if (typeof nhlSecs === "number" && nhlSecs > 0) nhlRotationMs = nhlSecs * 1000;
    calendarEnabled = !!cfg?.calendar?.enabled;
    countdowns = Array.isArray(cfg?.countdowns) ? cfg.countdowns : [];
  } catch (e) { /* fall back to default */ }

  refreshNHL(); setInterval(refreshNHL, REFRESH_NHL_MS);
  refreshWeather(); setInterval(refreshWeather, REFRESH_WEATHER_MS);
  refreshRSS(); setInterval(refreshRSS, REFRESH_RSS_MS);
  startRssRotationTimer();

  // Calendar view: only if a calendar URL is configured.
  if (!calendarEnabled) {
    WEATHER_VIEWS.splice(WEATHER_VIEWS.indexOf("calendar"), 1);
  } else {
    refreshCalendar(); setInterval(refreshCalendar, 5 * 60 * 1000);
  }

  // Countdown view: only if any countdowns are configured.
  if (!countdowns.length) {
    WEATHER_VIEWS.splice(WEATHER_VIEWS.indexOf("countdown"), 1);
  } else {
    // Re-render hourly so the day count rolls over at midnight without a page reload.
    renderCountdown(); setInterval(renderCountdown, 60 * 60 * 1000);
  }

  // Clock ticks every minute; render immediately so it's ready when rotation lands on it.
  renderClock(); setInterval(renderClock, 60 * 1000);

  // Rotate weather panel between all active views.
  renderWeatherDots();
  startWeatherRotationTimer();

  // Keep "X ago" labels accurate as time passes between data refreshes.
  setInterval(refreshUpdatedLabels, 5 * 1000);

  watchVersion();
}

async function watchVersion() {
  let initial;
  try {
    initial = (await fetchJson("/api/version"))?.version;
  } catch { return; }
  if (!initial) return;

  setInterval(async () => {
    try {
      const { version } = await fetchJson("/api/version");
      if (version && version !== initial) location.reload();
    } catch { /* transient — try again next tick */ }
  }, 30 * 1000);
}

start();
