// Weather panel: current conditions + 4-day forecast. The weather "label"
// (city name) is hidden on non-weather views via onWeatherViewShown.

import { createRotator } from "../rotator.js";
import { fetchJson, setUpdated, showError } from "../util/dom.js";

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

const fmtNum = (v, suffix = "") =>
  (v == null || Number.isNaN(v)) ? "—" : `${Math.round(v)}${suffix}`;

const WEATHER_TITLES = { weather: "Weather", calendar: "Today", clock: "", countdown: "" };

let weatherRotationMs = 15000;
let weatherRotator = null;

export function setWeatherRotationMs(ms) { weatherRotationMs = ms; }

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
        <div class="wx-temp">${fmtNum(cur.temperature_2m, tempUnit)}</div>
        <div class="wx-condition">${curDesc}</div>
        <div class="wx-meta">
          <span>Wind ${fmtNum(cur.wind_speed_10m)} ${windUnit}</span>
          <span>Humidity ${fmtNum(cur.relative_humidity_2m, "%")}</span>
        </div>
      </div>
    </div>
    <div class="wx-daily">
      ${days.map((d, i) => `
        <div class="wx-day">
          <div class="wx-day-label">${dayLabel(d.date, i)}</div>
          <div class="wx-day-icon">${d.icon}</div>
          <div class="wx-day-range"><span class="wx-min">${fmtNum(d.min, "°")}</span> ${fmtNum(d.max, "°")}</div>
        </div>
      `).join("")}
    </div>
  `;
}

export async function refreshWeather() {
  try {
    const data = await fetchJson("/api/weather");
    if (data.error) {
      showError("weather", data.error, ".view-weather");
    } else {
      renderWeather(data);
    }
    setUpdated("weather");
  } catch (e) {
    showError("weather", e.message, ".view-weather");
  }
}

function onWeatherViewShown(active) {
  // The weather "label" (city name) only makes sense on the weather view itself.
  document.getElementById("weather-label").style.display = active === "weather" ? "" : "none";
}

export function initWeatherRotator(weatherViews) {
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
  return weatherRotator;
}
