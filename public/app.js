// Dashboard client: polls /api/* on independent schedules and renders into panels.

const REFRESH_NHL_MS = 60 * 1000;
const REFRESH_WEATHER_MS = 10 * 60 * 1000;
const REFRESH_RSS_MS = 15 * 60 * 1000;

let rssIndex = 0;
let rssTotal = 1;
let rssRotationMs = 30 * 1000;

function setUpdated(panel) {
  const el = document.querySelector(`[data-updated-for="${panel}"]`);
  if (el) el.textContent = new Date().toLocaleTimeString();
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

function renderNHL(games) {
  const el = bodyEl("nhl");
  el.classList.remove("error");
  if (!games.length) {
    el.innerHTML = '<p style="color:#888">No games today.</p>';
    return;
  }
  const startTime = iso =>
    new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const row = (t, isHome) => `
    <div class="game-team ${isHome ? "home" : "away"}">
      <span class="team-name">${t.name || t.abbrev}</span>
      <span class="team-score">${t.score ?? ""}</span>
    </div>`;

  el.innerHTML = `<div class="games-grid">${
    games.map(g => {
      const right = g.state === "FUT" || g.state === "PRE"
        ? startTime(g.startTime)
        : g.statusText;
      return `
        <div class="game">
          <div class="game-header">${g.seriesText || ""}</div>
          <div class="game-body">
            <div class="game-teams">
              ${row(g.away, false)}
              ${row(g.home, true)}
            </div>
            <div class="game-status">${right}</div>
          </div>
        </div>`;
    }).join("")
  }</div>`;
}

async function refreshNHL() {
  try {
    const data = await fetchJson("/api/nhl");
    if (data && data.error) {
      if (data.stale) {
        renderNHL(data.stale);
        bodyEl("nhl").classList.add("stale");
      } else {
        showError("nhl", data.error);
      }
    } else {
      renderNHL(data);
    }
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
  const el = bodyEl("weather");
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
    <div class="wx-current">
      <div class="wx-temp">${curIcon} ${Math.round(cur.temperature_2m)}${tempUnit}</div>
      <div class="wx-meta">
        <div>${curDesc}</div>
        <div>Wind ${Math.round(cur.wind_speed_10m)} ${windUnit}</div>
        <div>Humidity ${cur.relative_humidity_2m}%</div>
      </div>
    </div>
    <div class="wx-daily">
      ${days.map((d, i) => `
        <div class="wx-day">
          <div class="wx-day-label">${dayLabel(d.date, i)}</div>
          <div class="wx-day-icon">${d.icon}</div>
          <div class="wx-day-range">${Math.round(d.min)}° / ${Math.round(d.max)}°</div>
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

// ---------- RSS ----------

function renderRSS(payload) {
  rssTotal = payload.total || 1;
  document.getElementById("rss-title").innerHTML =
    `${payload.name} <span class="rss-dots">${
      Array.from({length: rssTotal}, (_, i) =>
        `<span class="rss-dot ${i === payload.index ? 'active' : ''}"></span>`
      ).join("")
    }</span>`;

  const el = bodyEl("rss");
  el.classList.remove("error");
  if (!payload.items || !payload.items.length) {
    el.innerHTML = '<p style="color:#888">No items.</p>';
    return;
  }
  el.innerHTML = `<ul class="rss-list">${
    payload.items.map(i => `
      <li class="rss-item"><a href="${i.link}" target="_blank" rel="noopener">${i.title}</a></li>
    `).join("")
  }</ul>`;
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

// ---------- Bootstrap ----------

async function start() {
  try {
    const cfg = await fetchJson("/api/config");
    const secs = cfg?.rotation?.rssSeconds;
    if (typeof secs === "number" && secs > 0) rssRotationMs = secs * 1000;
  } catch (e) { /* fall back to default */ }

  refreshNHL(); setInterval(refreshNHL, REFRESH_NHL_MS);
  refreshWeather(); setInterval(refreshWeather, REFRESH_WEATHER_MS);
  refreshRSS(); setInterval(refreshRSS, REFRESH_RSS_MS);
  setInterval(rotateRSS, rssRotationMs);
}

start();
