// Weather panel: weather, calendar, clock and countdown views and their rotation.

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

// Map a WMO weather code + day/night flag to an atmospheric "sky" class. Drives
// the CSS gradient backdrop behind the weather view (pure CSS, no image assets)
// so the panel reflects real conditions the way the mockup's city photo did.
// isDay is Open-Meteo's `is_day` (1 day / 0 night); undefined → assume day.
function wxSkyClass(code, isDay) {
  const night = isDay === 0 ? " wx-night" : "";
  let cond = "wx-sky-clear";
  if (code >= 95) cond = "wx-sky-storm";
  else if (code >= 71 && code <= 77) cond = "wx-sky-snow";
  else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) cond = "wx-sky-rain";
  else if (code === 45 || code === 48) cond = "wx-sky-fog";
  else if (code === 2 || code === 3) cond = "wx-sky-clouds";
  return `${cond}${night}`;
}

const fmtNum = (v, suffix = "") =>
  (v == null || Number.isNaN(v)) ? "—" : `${Math.round(v)}${suffix}`;

// Build a Google search URL for the configured city's hourly forecast. Google's
// hourly-forecast card is more glanceable than a lat/lon map view and works for
// any city name without an API key.
function forecastSearchUrl(label) {
  if (typeof label !== "string" || !label.trim()) return "";

  const params = new URLSearchParams({
    q: `${label.trim()} hourly forecast`,
  });

  return `https://www.google.com/search?${params.toString()}`;
}

function renderWeather(data) {
  const labelEl = document.getElementById("weather-label");
  labelEl.textContent = data.label || "";
  labelEl.classList.toggle("has-label", !!data.label);
  renderWeatherView(document.querySelector("#weather .view-weather"), data);
}

// Build the weather widget into a view element. The weather panel and the NHL
// panel's off-season weather view both render through this.
function renderWeatherView(el, data) {
  el.classList.remove("error");

  const cur = data.current || {};
  // Atmospheric backdrop keyed to the current condition + day/night. Reset the
  // previous sky class first so the panel doesn't accumulate them across refreshes.
  el.classList.remove(
    "wx-sky-clear", "wx-sky-clouds", "wx-sky-fog", "wx-sky-rain",
    "wx-sky-snow", "wx-sky-storm", "wx-night"
  );
  wxSkyClass(cur.weather_code, cur.is_day).split(" ").forEach(c => el.classList.add(c));
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
    // Noon local: a bare "YYYY-MM-DD" parses as UTC midnight, which is the
    // previous evening west of Greenwich.
    const d = new Date(isoDate + "T12:00");
    return d.toLocaleDateString("en-US", { weekday: "short" });
  };

  // Wrap the weather view content in an <a> so the entire view is clickable
  // and right-click-friendly. Only this view (.view-weather) gets the link —
  // the calendar/clock/countdown views in the same panel are left untouched.
  // Build via DOM APIs (createElement / textContent / appendChild) instead of
  // innerHTML — the upstream weather payload comes from a third-party API
  // (Open-Meteo) and should be treated as untrusted input. See PR #13 for the
  // same pattern applied to the NHL details modal.
  const link = safeUrl(forecastSearchUrl(data.label));
  let wrapper;
  if (link) {
    wrapper = document.createElement("a");
    wrapper.className = "wx-link";
    wrapper.href = link;
    wrapper.target = "_blank";
    wrapper.rel = "noopener noreferrer";
    wrapper.title = `Hourly forecast for ${data.label} on Google`;
  } else {
    wrapper = document.createElement("div");
    wrapper.className = "wx-link";
  }

  const hero = document.createElement("div");
  hero.className = "wx-hero";

  const heroIcon = document.createElement("div");
  heroIcon.className = "wx-hero-icon";
  heroIcon.textContent = curIcon;
  hero.appendChild(heroIcon);

  const heroMain = document.createElement("div");
  heroMain.className = "wx-hero-main";

  const tempEl = document.createElement("div");
  tempEl.className = "wx-temp";
  tempEl.textContent = fmtNum(cur.temperature_2m, tempUnit);
  heroMain.appendChild(tempEl);

  const condEl = document.createElement("div");
  condEl.className = "wx-condition";
  condEl.textContent = curDesc;
  heroMain.appendChild(condEl);

  const metaEl = document.createElement("div");
  metaEl.className = "wx-meta";
  const windSpan = document.createElement("span");
  windSpan.textContent = `Wind ${fmtNum(cur.wind_speed_10m)} ${windUnit}`;
  metaEl.appendChild(windSpan);
  const humSpan = document.createElement("span");
  humSpan.textContent = `Humidity ${fmtNum(cur.relative_humidity_2m, "%")}`;
  metaEl.appendChild(humSpan);
  heroMain.appendChild(metaEl);

  hero.appendChild(heroMain);
  wrapper.appendChild(hero);

  const dailyEl = document.createElement("div");
  dailyEl.className = "wx-daily";
  days.forEach((d, i) => {
    const dayEl = document.createElement("div");
    dayEl.className = "wx-day";

    const dayLabelEl = document.createElement("div");
    dayLabelEl.className = "wx-day-label";
    dayLabelEl.textContent = dayLabel(d.date, i);
    dayEl.appendChild(dayLabelEl);

    const dayIconEl = document.createElement("div");
    dayIconEl.className = "wx-day-icon";
    dayIconEl.textContent = d.icon;
    dayEl.appendChild(dayIconEl);

    const rangeEl = document.createElement("div");
    rangeEl.className = "wx-day-range";
    const minSpan = document.createElement("span");
    minSpan.className = "wx-min";
    minSpan.textContent = fmtNum(d.min, "°");
    rangeEl.appendChild(minSpan);
    rangeEl.appendChild(document.createTextNode(" "));
    const maxSpan = document.createElement("span");
    maxSpan.className = "wx-max";
    maxSpan.textContent = fmtNum(d.max, "°");
    rangeEl.appendChild(maxSpan);
    dayEl.appendChild(rangeEl);

    dailyEl.appendChild(dayEl);
  });
  wrapper.appendChild(dailyEl);

  // Pure-CSS atmospheric backdrop rendered behind the content. The sky-* class
  // on `el` (set above) selects the gradient; this element just gives it a
  // layer to paint on plus a soft "sun/moon" glow orb the gradients position.
  const sky = document.createElement("div");
  sky.className = "wx-sky";
  sky.setAttribute("aria-hidden", "true");
  sky.appendChild(document.createElement("span")); // glow orb
  if (fxOn.weather) sky.appendChild(buildWeatherFx(wxSkyClass(cur.weather_code, cur.is_day)));

  el.replaceChildren(sky, wrapper);
}

// Last /api/weather response as JSON. An unchanged response means nothing to
// redraw (and redrawing would re-randomize the weather scene). Cleared on
// error so recovery redraws.
let _lastWeatherPayload = null;

async function refreshWeather() {
  try {
    const data = await fetchJson("/api/weather");
    if (data.error) {
      _lastWeatherPayload = null;
      showError("weather", data.error, ".view-weather");
    } else {
      const payload = JSON.stringify(data);
      if (payload === _lastWeatherPayload) {
        setUpdated("weather");
        return;
      }
      _lastWeatherPayload = payload;
      _lastWeatherData = data;
      renderWeather(data);
      if (nhlDeepOffSeason) renderNhlWeather();
    }
    setUpdated("weather");
  } catch (e) {
    _lastWeatherPayload = null;
    showError("weather", e.message, ".view-weather");
  }
}

// ---------- Calendar ----------

// Pick a contextual emoji from keywords in the event title, so the calendar
// reads at a glance like the other panels' emoji flair. Falls back to a neutral
// marker (📌 for all-day, 📅 for timed).
const CAL_ICONS = [
  [/birthday|b-?day/i, "🎂"],
  [/flight|airport|depart|boarding/i, "✈️"],
  [/doctor|dentist|\bdr\.?\b|appt|appointment|clinic|physio|checkup/i, "🩺"],
  [/meeting|\bcall\b|sync|stand-?up|1:1|interview|zoom|review/i, "👥"],
  [/lunch|dinner|breakfast|brunch|reservation|restaurant/i, "🍽️"],
  [/coffee/i, "☕"],
  [/gym|workout|\brun\b|yoga|climb|swim|training|practice/i, "🏋️"],
  [/\bpay\b|bill|rent|invoice|renew|\bdue\b/i, "💸"],
  [/trash|garbage|recycl|compost|\bbins?\b/i, "🗑️"],
  [/hockey|\bnhl\b|\bgame\b|\bmatch\b/i, "🏒"],
  [/movie|film|cinema|concert|theatre|theater|\bshow\b/i, "🎬"],
  [/party|celebrat|anniversary/i, "🎉"],
  [/holiday|vacation|\btrip\b|travel/i, "🌴"],
  [/deadline|submit|\bdue date\b/i, "⏰"],
  [/school|class|lecture|\bexam\b|homework|lesson/i, "🎓"],
];
function eventIcon(summary, allDay) {
  for (const [re, icon] of CAL_ICONS) if (re.test(summary)) return icon;
  return allDay ? "📌" : "📅";
}

// Colour the card's accent bar by rough time of day (or a blue for all-day),
// echoing the RSS panel's age-hue treatment so the agenda has visual rhythm.
function eventTimeClass(ev, allDay) {
  if (allDay) return "cal-allday";
  const h = new Date(ev.start).getHours();
  if (h < 12) return "cal-morning";
  if (h < 17) return "cal-afternoon";
  return "cal-evening";
}

function renderCalendar(data) {
  const el = document.querySelector("#weather .view-calendar");
  el.classList.remove("error");

  if (data.error) {
    el.innerHTML = `<div class="cal-empty cal-empty-error"><span class="cal-empty-icon">⚠️</span><span>${escapeHtml(data.error)}</span></div>`;
    return;
  }
  if (!data.events || !data.events.length) {
    el.innerHTML = '<div class="cal-empty"><span class="cal-empty-icon">🗓️</span><span>No events today</span></div>';
    return;
  }

  const isDateOnly = ev => typeof ev.start === "string" && ev.start.length === 10;

  el.innerHTML = `<div class="cal-list">${data.events.map(ev => {
    const allDay = ev.allDay || isDateOnly(ev);
    const timeLabel = allDay ? "All day" : formatTime(ev.start);
    return `
    <div class="cal-event ${eventTimeClass(ev, allDay)}">
      <span class="cal-icon" aria-hidden="true">${eventIcon(ev.summary, allDay)}</span>
      <span class="cal-title">${escapeHtml(ev.summary)}</span>
      <span class="cal-time">${escapeHtml(timeLabel)}</span>
    </div>`;
  }).join("")}</div>`;
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

// Render the time into a clock-time element as two spans — the h:mm digits and
// a smaller accent meridiem (AM/PM) — so CSS can style them independently. The
// en-US 12-hour format ("8:03 PM") always splits cleanly on the space; if a
// locale ever omits the meridiem the whole string falls into the digits span.
function renderClockTime(timeEl, now) {
  const [digits, meridiem] = formatTime(now).split(" ");
  const prevHm = timeEl.querySelector(".clk-hm");
  const hm = document.createElement("span");
  hm.className = "clk-hm";
  if (fxOn.clockRoll) {
    hm.dataset.prev = prevHm?.dataset.prev || "";
    renderRollingDigits(hm, digits);
  } else {
    hm.textContent = digits;
  }
  const parts = [hm];
  if (meridiem) {
    const mer = document.createElement("span");
    mer.className = "clk-mer";
    mer.textContent = meridiem;
    parts.push(mer);
  }
  timeEl.replaceChildren(...parts);
}

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

// Render the clock into a view built from the clock template (the weather
// panel's clock view, or the NHL panel's off-season one).
function renderClockView(view) {
  const timeEl = view?.querySelector(".clock-time");
  const dateEl = view?.querySelector(".clock-date");
  if (!timeEl || !dateEl) return;
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const month = now.toLocaleDateString("en-US", { month: "long" });
  const day = now.getDate();
  const year = now.getFullYear();
  renderClockTime(timeEl, now);
  dateEl.textContent = `${weekday}, ${month} ${day}${ordinalSuffix(day)}, ${year}`;
}

function renderClock() {
  renderClockView(document.querySelector("#weather .view-clock"));
  if (nhlDeepOffSeason) renderNhlClock();
}

// Re-armed every tick (rather than setInterval) so it stays on the minute
// boundary instead of whatever second the page loaded, and recovers after sleep.
function scheduleClockTick() {
  setTimeout(() => { renderClock(); scheduleClockTick(); }, 60000 - Date.now() % 60000);
}

// ---------- Countdown ----------

let countdowns = [];

function pickCountdown() {
  if (!countdowns.length) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  // Compare midnight-anchored dates to avoid DST / hour-of-day drift.
  const annotated = countdowns.map(c => {
    const parts = c.date.split("-").map(Number);
    let targetUtc;
    if (parts.length === 2) {
      // Annual event (MM-DD): resolve to next occurrence
      const [m, d] = parts;
      const thisYear = Date.UTC(now.getFullYear(), m - 1, d);
      targetUtc = thisYear >= todayUtc
        ? thisYear
        : Date.UTC(now.getFullYear() + 1, m - 1, d);
    } else {
      const [y, m, d] = parts;
      targetUtc = Date.UTC(y, m - 1, d);
    }
    const days = Math.round((targetUtc - todayUtc) / 86400000);
    return { ...c, days };
  });
  const upcoming = annotated.filter(c => c.days >= 0).sort((a, b) => a.days - b.days);
  if (upcoming.length) return upcoming[0];
  return annotated.sort((a, b) => b.days - a.days)[0];
}

// Render the next countdown into a view built from the countdown template.
function renderCountdownView(view) {
  const numEl = view?.querySelector(".countdown-number");
  const labelEl = view?.querySelector(".countdown-label");
  if (!numEl || !labelEl) return;
  const { numberText, labelText, icon } = formatCountdown(pickCountdown());
  numEl.textContent = numberText;
  labelEl.textContent = labelText;
  const iconEl = view.querySelector(".cd-divider-icon");
  if (iconEl) iconEl.textContent = icon;
}

function renderCountdown() {
  renderCountdownView(document.querySelector("#weather .view-countdown"));
  if (nhlDeepOffSeason) renderNhlCountdown();
}

// ---------- Weather panel rotation ----------

const WEATHER_TITLES = { weather: "Weather", calendar: "Today", clock: "", countdown: "" };
let weatherRotationMs = 15000;
let weatherRotator = null;

function onWeatherViewShown(active) {
  // The weather "label" (city name) only makes sense on the weather view itself.
  document.getElementById("weather-label").style.display = active === "weather" ? "" : "none";
}
