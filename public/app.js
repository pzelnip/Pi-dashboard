// Dashboard client: polls /api/* on independent schedules and renders into panels.

const REFRESH_NHL_MS = 30 * 1000;
const REFRESH_WEATHER_MS = 10 * 60 * 1000;

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

const TIME_FMT = { hour: "numeric", minute: "2-digit", hour12: true };
const formatTime = d => new Date(d).toLocaleTimeString("en-US", TIME_FMT);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function safeUrl(u) {
  try {
    const parsed = new URL(u, location.href);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") ? u : "";
  } catch { return ""; }
}

// ---------- Rotator ----------
// Owns the index, timer, dots/nav, and active-view CSS class for one rotating
// panel. Each panel calls createRotator once; setViews() can be called later
// to swap the active set (e.g. NHL switching between today-only and today/yesterday).
function createRotator({ dotsEl, navEl, viewsContainer, viewClassPrefix, titleEl, titles, views, getRotationMs, onShow }) {
  let currentViews = views.slice();
  let index = 0;
  let timer = null;

  const wrap = i => ((i % currentViews.length) + currentViews.length) % currentViews.length;

  function renderControls() {
    const count = currentViews.length;
    if (dotsEl) {
      dotsEl.innerHTML = count > 1
        ? Array.from({length: count}, (_, i) =>
            `<button class="rot-dot ${i === index ? 'active' : ''}" data-rot-index="${i}" aria-label="View ${i + 1}"></button>`
          ).join("")
        : "";
      dotsEl.querySelectorAll(".rot-dot").forEach(btn => {
        btn.addEventListener("click", () => jumpTo(Number(btn.dataset.rotIndex)));
      });
    }
    if (navEl) {
      navEl.innerHTML = count > 1
        ? `<button class="rot-nav" data-rot-step="-1" aria-label="Previous">‹</button>
           <button class="rot-nav" data-rot-step="1" aria-label="Next">›</button>`
        : "";
      navEl.querySelectorAll(".rot-nav").forEach(btn => {
        const step = Number(btn.dataset.rotStep);
        btn.addEventListener("click", () => jumpTo(index + step));
      });
    }
  }

  function applyActiveView() {
    const active = currentViews[index];
    if (viewsContainer) {
      viewsContainer.querySelectorAll(".view").forEach(v => {
        v.classList.toggle("active", v.classList.contains(`${viewClassPrefix}${active}`));
      });
    }
    if (titleEl && titles) {
      titleEl.textContent = titles[active] ?? "";
    }
    if (dotsEl) {
      dotsEl.querySelectorAll(".rot-dot").forEach((btn, i) => {
        btn.classList.toggle("active", i === index);
      });
    }
    if (onShow) onShow(active);
  }

  function showView(i) {
    index = wrap(i);
    applyActiveView();
  }

  function jumpTo(i) {
    if (wrap(i) === index) return;
    showView(i);
    startTimer();
  }

  function rotate() { showView(index + 1); }

  function startTimer() {
    stopTimer();
    if (currentViews.length > 1) {
      timer = setInterval(rotate, getRotationMs());
    }
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function setViews(newViews) {
    const wasActive = currentViews[index];
    currentViews = newViews.slice();
    const reuseIdx = currentViews.indexOf(wasActive);
    index = reuseIdx >= 0 ? reuseIdx : 0;
    renderControls();
    applyActiveView();
    startTimer();
  }

  function start() {
    renderControls();
    applyActiveView();
    startTimer();
  }

  return { start, setViews, jumpTo, rotate, getIndex: () => index };
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
    if (isLive(g)) return `<span class="status-pill live">${escapeHtml(g.statusText || "LIVE")}</span>`;
    if (isScheduled(g)) return `<span class="status-pill scheduled">${escapeHtml(formatTime(g.startTime))}</span>`;
    return `<span class="status-pill final">${escapeHtml(g.statusText || "Final")}</span>`;
  };

  const row = (t, outcome, isFav, venue) => {
    const logoUrl = safeUrl(t.logo);
    return `
    <div class="game-team ${outcome} ${venue}">
      ${logoUrl ? `<img class="team-logo" src="${escapeHtml(logoUrl)}" alt="" onerror="this.remove()">` : ""}
      <span class="team-name">${escapeHtml(t.name || t.abbrev || "")}${isFav ? ' <span class="fav-star" aria-label="Favorite team">★</span>' : ""}</span>
      <span class="team-score">${escapeHtml(String(t.score ?? ""))}</span>
    </div>`;
  };

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
        ${g.seriesText ? `<span class="series-tag">${escapeHtml(g.seriesText)}</span>` : ""}
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

const NHL_TITLES = { today: "NHL Scores", yesterday: "Yesterday" };
let nhlRotationMs = 10000;
let nhlRotator = null;

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
    const canRotate = !!(data.yesterday && !data.hasLiveToday);
    nhlRotator.setViews(canRotate ? ["today", "yesterday"] : ["today"]);
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
  const labelEl = document.getElementById("weather-label");
  labelEl.textContent = data.label || "";
  labelEl.classList.toggle("has-label", !!data.label);
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
    el.innerHTML = `<p class="cal-empty">⚠ ${escapeHtml(data.error)}</p>`;
    return;
  }
  if (!data.events || !data.events.length) {
    el.innerHTML = '<p class="cal-empty">No events today</p>';
    return;
  }

  const timeLabel = ev => ev.allDay ? "All day" : formatTime(ev.start);

  el.innerHTML = data.events.map(ev => `
    <div class="cal-event ${ev.allDay ? "cal-allday" : ""}">
      <span class="cal-time">${escapeHtml(timeLabel(ev))}</span>
      <span class="cal-title">${escapeHtml(ev.summary)}</span>
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
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const month = now.toLocaleDateString("en-US", { month: "long" });
  const day = now.getDate();
  const year = now.getFullYear();
  const date = `${weekday}, ${month} ${day}${ordinalSuffix(day)}, ${year}`;
  const timeEl = document.querySelector("#weather .clock-time");
  const dateEl = document.querySelector("#weather .clock-date");
  if (timeEl) timeEl.textContent = formatTime(now);
  if (dateEl) dateEl.textContent = date;
}

// ---------- Countdown ----------

let countdowns = [];

function pickCountdown() {
  if (!countdowns.length) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  // Compare midnight-anchored dates to avoid DST / hour-of-day drift.
  const annotated = countdowns.map(c => {
    const [y, m, d] = c.date.split("-").map(Number);
    const days = Math.round((Date.UTC(y, m - 1, d) - todayUtc) / 86400000);
    return { ...c, days };
  });
  const upcoming = annotated.filter(c => c.days >= 0).sort((a, b) => a.days - b.days);
  if (upcoming.length) return upcoming[0];
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

const WEATHER_TITLES = { weather: "Weather", calendar: "Today", clock: "", countdown: "" };
let weatherRotationMs = 15000;
let weatherRotator = null;

function onWeatherViewShown(active) {
  // The weather "label" (city name) only makes sense on the weather view itself.
  document.getElementById("weather-label").style.display = active === "weather" ? "" : "none";
}

// ---------- RSS ----------

let rssIndex = 0;
let rssTotal = 1;
let rssRotationMs = 30 * 1000;
let rssFadeTimer = null;
let rssRotator = null;

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
  rssIndex = payload.index;
  const feedImageUrl = safeUrl(payload.feedImage);
  const logo = feedImageUrl
    ? `<img class="feed-logo" src="${escapeHtml(feedImageUrl)}" alt="" onerror="this.outerHTML=window.DEFAULT_RSS_ICON">`
    : window.DEFAULT_RSS_ICON;

  const rssPanel = document.getElementById("rss");
  const titleEl = document.getElementById("rss-title");
  const el = bodyEl("rss");

  // RSS uses the rotator with a synthetic "view per feed" set so dots/nav match
  // the count of feeds. We don't actually flip CSS classes — the body content
  // is rewritten on each feed swap.
  rssRotator.setViews(Array.from({length: rssTotal}, (_, i) => String(i)));

  const writeContent = () => {
    titleEl.innerHTML = `${logo}<span>${escapeHtml(payload.name)}</span>`;
    el.classList.remove("error");
    if (!payload.items || !payload.items.length) {
      el.innerHTML = '<p style="color: var(--text-muted)">No items.</p>';
      return;
    }
    el.innerHTML = `<ul class="rss-list">${
      payload.items.map(i => {
        const itemLink = safeUrl(i.link);
        const itemImage = safeUrl(i.image);
        return `
        <li class="rss-item">
          <a href="${escapeHtml(itemLink)}" target="_blank" rel="noopener">
            ${itemImage
              ? `<img class="rss-thumb" src="${escapeHtml(itemImage)}" alt="" loading="lazy" onerror="this.remove()">`
              : ""}
            <span class="rss-title">${escapeHtml(i.title)}</span>
          </a>
        </li>
      `;
      }).join("")
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

function onRssViewShown(active) {
  // active is a stringified feed index; only fetch if it differs from current.
  const target = Number(active);
  if (target === rssIndex) return;
  rssIndex = target;
  refreshRSS();
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
  });
  weatherRotator.start();

  rssRotator = createRotator({
    dotsEl: document.getElementById("rss-dots"),
    navEl: document.getElementById("rss-nav"),
    views: ["0"],  // renderRSS expands once we know the feed count
    getRotationMs: () => rssRotationMs,
    onShow: onRssViewShown,
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

  // Clock ticks every minute; render immediately so it's ready when rotation lands on it.
  renderClock(); setInterval(renderClock, 60 * 1000);

  // Keep "X ago" labels accurate as time passes between data refreshes.
  setInterval(refreshUpdatedLabels, 5 * 1000);

  setupDebugOverlay();
  watchVersion();
}

// ---------- Debug overlay ----------

function formatUptime(ms) {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function shortUrl(url) {
  // Trim long URLs to a recognizable head: host + first segment.
  try {
    const u = new URL(url);
    const path = u.pathname.split("/").slice(0, 3).join("/");
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

const PAGE_LOADED_AT = Date.now();

function renderDebug(data) {
  const now = Date.now();
  const uptime = formatUptime(now - data.serverStartedAt * 1000);
  const pageAge = formatAgo(now - PAGE_LOADED_AT);
  const commit = data.latestCommitAt
    ? `${formatAgo(now - data.latestCommitAt * 1000)} — "${escapeHtml(data.latestCommitSubject)}"`
    : "(unavailable)";
  const cache = data.cache.length
    ? data.cache.map(c => {
        const ttl = c.ttlRemaining > 60
          ? `${Math.round(c.ttlRemaining / 60)}m left`
          : `${Math.max(0, Math.round(c.ttlRemaining))}s left`;
        return `<div class="mono">${escapeHtml(shortUrl(c.url))} <span style="color:var(--text-muted)">(${ttl})</span></div>`;
      }).join("")
    : '<span style="color:var(--text-muted)">(empty)</span>';

  return `<dl>
    <dt>SHA</dt><dd class="mono">${escapeHtml(data.versionShort)} <span style="color:var(--text-muted)">(${escapeHtml(data.version)})</span></dd>
    <dt>Latest commit</dt><dd>${commit}</dd>
    <dt>Server uptime</dt><dd>${uptime}</dd>
    <dt>Page loaded</dt><dd>${pageAge}</dd>
    <dt>Viewport</dt><dd>${window.innerWidth}×${window.innerHeight}</dd>
    <dt>User agent</dt><dd>${escapeHtml(navigator.userAgent)}</dd>
    <dt>Python</dt><dd>${escapeHtml(data.pythonVersion)}</dd>
    <dt>Platform</dt><dd>${escapeHtml(data.platform)}</dd>
    <dt>config.local</dt><dd>${data.configLocalPresent ? "present" : "absent"}</dd>
    <dt>RSS feeds</dt><dd>${data.rssFeedCount}</dd>
    <dt>Calendar URLs</dt><dd>${data.calendarUrlCount}</dd>
    <dt>Cache (${data.cache.length})</dt><dd>${cache}</dd>
  </dl>`;
}

function setupDebugOverlay() {
  const dot = document.getElementById("debug-dot");
  const sheet = document.getElementById("debug-sheet");
  const backdrop = document.getElementById("debug-backdrop");
  const body = document.getElementById("debug-body");
  const close = document.getElementById("debug-close");
  if (!dot || !sheet || !backdrop || !body || !close) return;

  let open = false;

  async function openDebug() {
    if (open) return;
    open = true;
    sheet.classList.add("open");
    backdrop.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    body.innerHTML = "Loading…";
    try {
      const data = await fetchJson("/api/debug");
      if (data.error) throw new Error(data.error);
      body.innerHTML = renderDebug(data);
    } catch (e) {
      body.innerHTML = `<p style="color: var(--live)">Failed to load debug info: ${escapeHtml(e.message)}</p>`;
    }
  }

  function closeDebug() {
    if (!open) return;
    open = false;
    sheet.classList.remove("open");
    backdrop.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
  }

  dot.addEventListener("click", openDebug);
  close.addEventListener("click", closeDebug);
  backdrop.addEventListener("click", closeDebug);

  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.key === "d" || e.key === "D") {
      e.preventDefault();
      open ? closeDebug() : openDebug();
    } else if (e.key === "Escape" && open) {
      closeDebug();
    }
  });
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
