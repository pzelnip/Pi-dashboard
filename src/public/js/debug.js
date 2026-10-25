// Debug overlay. Loaded on first open by the stub in main.js, so the kiosk
// never parses it.

// ---------- Debug overlay ----------

const GITHUB_REPO_URL = "https://github.com/pzelnip/Pi-dashboard";

function formatUptime(ms) {
  // Live-counting friendly: rightmost unit always changes each second so
  // the user can see the panel is alive.
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  const pad = n => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h ${pad(m)}m ${pad(s)}s`;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
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

// Host health rows (load / memory / temperature). Each value is null when the
// server can't read it — memory and temperature are Linux-only, so a Mac dev
// box shows "(unavailable)" for those. Thresholds colour the value amber/red.
const UNAVAILABLE = '<span style="color:var(--text-muted)">(unavailable)</span>';

function levelSpan(text, level) {
  const color = level === "bad" ? "var(--live)" : level === "warn" ? "var(--pregame)" : "";
  return color ? `<span style="color:${color}">${text}</span>` : text;
}

// Amber from 1.0: a whole core busy, which an idle kiosk shouldn't be — and
// Chromium's software compositor pinning one core shows up as ~1.0 on the
// Pi's four, well under the usual "load > cores" rule. Red once every core
// is busy.
function renderLoad(load) {
  if (!load) return UNAVAILABLE;
  const fmt = (v) => levelSpan(v.toFixed(2), v >= load.cpus ? "bad" : v >= 1 ? "warn" : "");
  return `${fmt(load.one)} · ${fmt(load.five)} · ${fmt(load.fifteen)}`
    + ` <span style="color:var(--text-muted)">(1 / 5 / 15 min, ${load.cpus} cores)</span>`;
}

// Coloured on available RAM (top's "avail Mem"), not swap: pages parked in
// swap are normal on a 1 GB Pi; running out of reclaimable memory isn't.
function renderMemory(mem) {
  if (!mem) return UNAVAILABLE;
  const pct = mem.totalMb ? mem.availableMb / mem.totalMb : 1;
  const avail = levelSpan(`${mem.availableMb} MB available`, pct < 0.1 ? "bad" : pct < 0.2 ? "warn" : "");
  const swap = mem.swapTotalMb
    ? `swap ${mem.swapUsedMb} / ${mem.swapTotalMb} MB used`
    : "no swap";
  return `${avail} of ${mem.totalMb} MB <span style="color:var(--text-muted)">· ${swap}</span>`;
}

// The Pi 3B+ drops its clock at 60 °C (soft limit) and throttles hard from
// 80 °C, so those are the amber/red lines.
function renderCpuTemp(tempC) {
  if (tempC == null) return UNAVAILABLE;
  return levelSpan(`${tempC.toFixed(1)} °C`, tempC >= 80 ? "bad" : tempC >= 60 ? "warn" : "");
}

function renderDebugFields(data) {
  const now = Date.now();
  const uptime = formatUptime(now - data.serverStartedAt * 1000);
  const sys = data.system || {};
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

  // Three states worth telling apart: unset, set-but-unusable (bad path or
  // non-image extension), and resolved.
  const background = !data.backgroundConfigured
    ? '<span style="color:var(--text-muted)">(not set)</span>'
    : data.backgroundImage
      ? `<span class="mono">${escapeHtml(data.backgroundImage)}</span>`
      : `<span style="color:var(--live)">not found: ${escapeHtml(data.backgroundConfigured)}</span>`;

  const ghCommitUrl = `${GITHUB_REPO_URL}/commit/${encodeURIComponent(data.version)}`;
  const pyDocsUrl = `https://docs.python.org/release/${encodeURIComponent(data.pythonVersion)}/`;

  return `<dl>
    <dt>SHA</dt><dd class="mono"><a href="${escapeHtml(ghCommitUrl)}" target="_blank" rel="noopener">${escapeHtml(data.versionShort)}</a> <a href="${escapeHtml(ghCommitUrl)}" target="_blank" rel="noopener" style="color:var(--text-muted)">(${escapeHtml(data.version)})</a></dd>
    <dt>Latest commit</dt><dd>${commit}</dd>
    <dt>Server uptime</dt><dd><span id="debug-uptime">${uptime}</span></dd>
    <dt>Load average</dt><dd id="debug-load">${renderLoad(sys.load)}</dd>
    <dt>Memory</dt><dd id="debug-memory">${renderMemory(sys.memory)}</dd>
    <dt>CPU temp</dt><dd id="debug-temp">${renderCpuTemp(sys.cpuTempC)}</dd>
    <dt>Viewport</dt><dd>${window.innerWidth}×${window.innerHeight} (zoom ${fitZoom.toFixed(3)})</dd>
    <dt>User agent</dt><dd id="debug-ua"></dd>
    <dt>Python</dt><dd><a href="${escapeHtml(pyDocsUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.pythonVersion)}</a></dd>
    <dt>Platform</dt><dd>${escapeHtml(data.platform)}</dd>
    <dt>RSS feeds</dt><dd>${data.rssFeedCount}</dd>
    <dt>Calendar URLs</dt><dd>${data.calendarUrlCount}</dd>
    <dt>Background</dt><dd>${background}</dd>
    <dt>Cache (${data.cache.length})</dt><dd>${cache}</dd>
    <dt>Display</dt><dd>${escapeHtml(fxSummary())} <button class="debug-action" data-debug-action="display">settings ›</button></dd>
    <dt>Countdowns</dt><dd><button class="debug-action" data-debug-action="countdowns">manage ›</button></dd>
    <dt>Service log</dt><dd><button class="debug-action" data-debug-action="log-service">view ›</button></dd>
    <dt>Update log</dt><dd><button class="debug-action" data-debug-action="log-update">view ›</button></dd>
    <dt>Force update</dt><dd><button class="debug-action danger" data-debug-action="update">run</button></dd>
  </dl>`;
}

// Populate the User agent <dd> with structured fields (when navigator.userAgentData
// is available) plus the raw UA string as a clickable link to a parsing site.
// Uses DOM APIs (textContent / setAttribute) rather than innerHTML — the UA
// string comes from navigator but is treated as untrusted text.
function populateUserAgent(container) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  const uaData = navigator.userAgentData;
  if (uaData) {
    const parts = [];
    if (Array.isArray(uaData.brands) && uaData.brands.length) {
      const brands = uaData.brands
        .filter(b => b && b.brand && !/Not.?A.?Brand/i.test(b.brand))
        .map(b => b.version ? `${b.brand} ${b.version}` : b.brand);
      if (brands.length) parts.push(brands.join(", "));
    }
    if (uaData.platform) parts.push(uaData.platform);
    parts.push(uaData.mobile ? "mobile" : "desktop");

    if (parts.length) {
      const summary = document.createElement("div");
      summary.textContent = parts.join(" • ");
      container.appendChild(summary);
    }
  }

  const link = document.createElement("a");
  link.textContent = navigator.userAgent;
  link.setAttribute("href", "https://www.whatismybrowser.com/detect/what-is-my-user-agent");
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
  link.setAttribute("title", "Open user-agent parser in a new tab");
  link.className = "mono";
  container.appendChild(link);
}

// "lite preset · fade 150 ms" — the effective settings, for the field list.
function fxSummary() {
  if (!fxState) return "";
  const toggles = Object.entries(FX_SETTINGS).filter(([, def]) => def.input.type === "toggle");
  const on = toggles.filter(([key]) => fxState[key].value).length;
  return [
    `${fxState.preset.value} preset`,
    `${fxState.transition.value} ${fxState.fade.value} ms`,
    `${on} of ${toggles.length} effects on`,
  ].join(" · ");
}

// The form control for one setting; `saved` is this browser's saved value.
// Every control has a blank "not saved" state so a field can defer to the
// URL/config/preset.
function fxControl(key, def, saved) {
  const inp = def.input;
  const id = `fx-${escapeHtml(key)}`;
  const name = escapeHtml(key);
  if (inp.type === "number") {
    const value = saved != null ? ` value="${escapeHtml(String(saved))}"` : "";
    return `<input id="${id}" name="${name}" type="number" min="${inp.min}" max="${inp.max}" step="${inp.step}" placeholder="not saved"${value}>`
      + (def.unit ? ` <span class="debug-fx-unit">${escapeHtml(def.unit)}</span>` : "");
  }
  const options = inp.type === "toggle"
    ? [["on", saved === true], ["off", saved === false]]
    : inp.options.map(o => [o, saved === o]);
  return `<select id="${id}" name="${name}"><option value="">Not saved</option>${
    options.map(([v, sel]) => `<option value="${escapeHtml(v)}"${sel ? " selected" : ""}>${escapeHtml(v)}</option>`).join("")
  }</select>`;
}

// Display text for an effective value (toggles read on/off, not true/false).
function fxValueText(key, value) {
  return FX_SETTINGS[key]?.input.type === "toggle" ? (value ? "on" : "off") : String(value);
}

// Where an effective setting came from, in words.
function fxSourceText(key, entry) {
  switch (entry.source) {
    case "url": return `URL (?${key === "preset" ? "fx" : key}=${new URLSearchParams(location.search).get(key === "preset" ? "fx" : key)})`;
    case "saved": return "saved in this browser";
    case "config": return "server config";
    case "preset": return `${fxState.preset.value} preset`;
    default: return "built-in default";
  }
}

// The Display view: one row per effect plus the preset. Inputs show what's
// saved in this browser (blank = not saved); "Now" shows the effective value
// and its source, since a URL parameter can override the saved one.
function renderDisplaySettings(message, isError) {
  const saved = loadSavedFx();
  const row = (key, label, control, hint) => {
    const entry = fxState[key];
    const urlNote = entry.source === "url"
      ? '<span class="debug-fx-url">The URL sets this, so a saved value won\'t apply here.</span>'
      : "";
    return `<div class="debug-fx-row">
        <label class="debug-fx-label" for="fx-${key}">${escapeHtml(label)}</label>
        ${control}
        <span class="debug-fx-now">Now: <strong>${escapeHtml(fxValueText(key, entry.value))}</strong> — ${escapeHtml(fxSourceText(key, entry))}</span>
        ${hint ? `<span class="debug-fx-hint">${escapeHtml(hint)}</span>` : ""}
        ${urlNote}
      </div>`;
  };
  const presetOptions = ['<option value="">Not saved</option>']
    .concat(Object.keys(FX_PRESETS).map(p =>
      `<option value="${escapeHtml(p)}"${saved.preset === p ? " selected" : ""}>${escapeHtml(p)}</option>`))
    .join("");
  const rows = [
    row("preset", "Preset", `<select id="fx-preset" name="preset">${presetOptions}</select>`,
      "full = every effect; lite = cheaper effects for low-powered devices like the Pi."),
  ];
  for (const [key, def] of Object.entries(FX_SETTINGS)) {
    rows.push(row(key, def.label, fxControl(key, def, saved[key]), def.hint));
  }
  const msg = message
    ? `<span class="debug-fx-msg${isError ? " error" : ""}">${escapeHtml(message)}</span>`
    : "";
  return `
    <div class="debug-log-header">
      <button class="debug-back" data-debug-action="back">‹ Back</button>
      <span class="debug-log-title">Display</span>
    </div>
    <p class="debug-fx-intro">Visual effects for <strong>this browser only</strong>. A saved value overrides the
      server config, and a URL parameter (<code>?fx=lite</code>, <code>?fade=150</code>) overrides both.
      Leave a field blank to not save it.</p>
    <form class="debug-fx-form" data-debug-action="display-form">
      ${rows.join("")}
      <div class="debug-fx-actions">
        <button type="submit" class="debug-action">Save</button>
        <button type="button" class="debug-action" data-debug-action="display-reset">Clear saved</button>
        ${msg}
      </div>
    </form>`;
}

function renderDebugLog(title, data) {
  const lines = (data.lines || []).map(escapeHtml).join("\n") || "(no output)";
  const note = data.note ? `<p style="color:var(--text-muted)">${escapeHtml(data.note)}</p>` : "";
  return `
    <div class="debug-log-header">
      <button class="debug-back" data-debug-action="back">‹ Back</button>
      <span class="debug-log-title">${escapeHtml(title)}</span>
      <button class="debug-action" data-debug-action="${title === "Service log" ? "log-service" : "log-update"}">refresh</button>
    </div>
    <div style="color:var(--text-muted);font-size:0.8em;margin-bottom:8px">${escapeHtml(data.source || "")}</div>
    ${note}
    <pre class="debug-log">${lines}</pre>
  `;
}

// Called once by the stub in main.js after this file loads; openNow opens the
// sheet for the click or key press that triggered the load.
function initDebugOverlay(openNow) {
  const dot = document.getElementById("debug-dot");
  const sheet = document.getElementById("debug-sheet");
  const backdrop = document.getElementById("debug-backdrop");
  const body = document.getElementById("debug-body");
  const close = document.getElementById("debug-close");
  const banner = document.getElementById("update-banner");
  if (!dot || !sheet || !backdrop || !body || !close) return;

  let open = false;
  let mode = "fields";         // "fields" | "log" | "countdowns" | "display" — controls Escape behavior
  let tickTimer = null;        // 1Hz interval that updates uptime + page-age
  let tickCount = 0;           // tickTimer ticks, for the slower system refresh
  const SYSTEM_REFRESH_TICKS = 5;
  let cancelTimer = null;      // 1Hz interval for the 3s force-update countdown
  let firedTimeout = null;     // 30s fallback after firing — swaps banner if no reload
  let fastPollTimer = null;    // 1Hz post-fire SHA poll — beats watchVersion's 30s cadence
  let serverStartedAt = null;  // captured from /api/debug; used by tickTimer

  function clearTimers() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (cancelTimer) { clearInterval(cancelTimer); cancelTimer = null; }
    if (firedTimeout) { clearTimeout(firedTimeout); firedTimeout = null; }
    if (fastPollTimer) { clearInterval(fastPollTimer); fastPollTimer = null; }
    if (banner) banner.classList.remove("active", "firing");
  }

  function tick() {
    if (serverStartedAt == null) return;
    const uptimeEl = document.getElementById("debug-uptime");
    if (uptimeEl) uptimeEl.textContent = formatUptime(Date.now() - serverStartedAt * 1000);
    if (++tickCount % SYSTEM_REFRESH_TICKS === 0) refreshSystem();
  }

  // Load/memory/temperature move while the sheet is open (the point is to
  // watch them), so re-poll /api/debug every few ticks and patch just those
  // rows. Rides tickTimer, so it stops when the sheet closes or leaves the
  // field list.
  async function refreshSystem() {
    try {
      const data = await fetchJson("/api/debug");
      const sys = data.system;
      if (data.error || !sys || mode !== "fields") return;
      const set = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
      };
      set("debug-load", renderLoad(sys.load));
      set("debug-memory", renderMemory(sys.memory));
      set("debug-temp", renderCpuTemp(sys.cpuTempC));
    } catch (e) { /* keep the last reading on screen */ }
  }

  async function showFields() {
    mode = "fields";
    body.innerHTML = "Loading…";
    try {
      const data = await fetchJson("/api/debug");
      if (data.error) throw new Error(data.error);
      serverStartedAt = data.serverStartedAt;
      body.innerHTML = renderDebugFields(data);
      populateUserAgent(document.getElementById("debug-ua"));
      if (!tickTimer) tickTimer = setInterval(tick, 1000);
    } catch (e) {
      body.innerHTML = `<p style="color: var(--live)">Failed to load debug info: ${escapeHtml(e.message)}</p>`;
    }
  }

  async function showLog(which) {
    mode = "log";
    const title = which === "service" ? "Service log" : "Update log";
    body.innerHTML = `<p style="color:var(--text-muted)">Loading ${title.toLowerCase()}…</p>`;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    try {
      const data = await fetchJson(`/api/logs?which=${which}&lines=200`);
      if (data.error) throw new Error(data.error);
      body.innerHTML = renderDebugLog(title, data);
    } catch (e) {
      body.innerHTML = `
        <div class="debug-log-header">
          <button class="debug-back" data-debug-action="back">‹ Back</button>
          <span class="debug-log-title">${escapeHtml(title)}</span>
        </div>
        <p style="color: var(--live)">Failed to load: ${escapeHtml(e.message)}</p>
      `;
    }
  }

  function showDisplay(message, isError) {
    mode = "display";
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    body.innerHTML = renderDisplaySettings(message, isError);
  }

  function saveDisplay(form) {
    const settings = {};
    const preset = form.elements.preset.value;
    if (preset) settings.preset = preset;
    for (const [key, def] of Object.entries(FX_SETTINGS)) {
      const el = form.elements[key];
      // A number input holding junk ("1e") reports value "" — don't let that
      // silently clear the saved setting.
      if (el.validity?.badInput) {
        showDisplay(`${def.label}: that isn't a valid value.`, true);
        return;
      }
      const raw = el.value.trim();
      if (raw === "") continue;
      const value = def.parse(raw);
      if (value == null) {
        showDisplay(`${def.label}: "${raw}" isn't a valid value.`, true);
        return;
      }
      settings[key] = value;
    }
    if (!saveFx(settings)) {
      showDisplay("Couldn't save: this browser isn't allowing local storage.", true);
      return;
    }
    applyEffects();
    showDisplay("Saved.");
  }

  function resetDisplay() {
    if (!saveFx({})) {
      showDisplay("Couldn't clear: this browser isn't allowing local storage.", true);
      return;
    }
    applyEffects();
    showDisplay("Cleared saved settings.");
  }

  async function showCountdowns() {
    mode = "countdowns";
    body.innerHTML = `<p style="color:var(--text-muted)">Loading countdowns…</p>`;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    try {
      const data = await fetchJson("/api/countdowns");
      if (data.error) throw new Error(data.error);

      // Static shell via innerHTML — no user data
      body.innerHTML = `
        <div class="debug-log-header">
          <button class="debug-back" data-debug-action="back">‹ Back</button>
          <span class="debug-log-title">Countdowns</span>
        </div>
        <div class="debug-countdown-list"></div>
        <form class="debug-countdown-form" data-debug-action="add-countdown-form">
          <input type="date" name="date" required>
          <input type="text" name="icon" class="debug-countdown-icon" placeholder="⏳" maxlength="8" title="Optional icon emoji">
          <input type="text" name="title" placeholder="Event title" required maxlength="100">
          <button type="submit" class="debug-action">Add</button>
          <a href="#" class="debug-toggle-annual" data-debug-action="toggle-annual">Annual (MM-DD)</a>
        </form>
      `;

      // Build countdown items with DOM APIs — user data via textContent/dataset
      const listEl = body.querySelector(".debug-countdown-list");
      const cdList = data.countdowns || [];
      if (cdList.length === 0) {
        const empty = document.createElement("p");
        empty.style.color = "var(--text-muted)";
        empty.textContent = "(none)";
        listEl.appendChild(empty);
      } else {
        cdList.forEach(c => {
          const icon = c.icon || "";
          const item = document.createElement("div");
          item.className = "debug-countdown-item";

          const editBtn = document.createElement("button");
          editBtn.className = "debug-action";
          editBtn.dataset.debugAction = "edit-countdown";
          editBtn.dataset.cdDate = c.date;
          editBtn.dataset.cdTitle = c.title;
          editBtn.dataset.cdIcon = icon;
          editBtn.title = "Edit";
          editBtn.textContent = "✎";

          const deleteBtn = document.createElement("button");
          deleteBtn.className = "debug-action danger";
          deleteBtn.dataset.debugAction = "delete-countdown";
          deleteBtn.dataset.cdDate = c.date;
          deleteBtn.dataset.cdTitle = c.title;
          deleteBtn.title = "Delete";
          deleteBtn.textContent = "✕";

          const label = document.createElement("span");
          label.dataset.debugAction = "edit-countdown";
          label.dataset.cdDate = c.date;
          label.dataset.cdTitle = c.title;
          label.dataset.cdIcon = icon;
          label.textContent = `${icon ? icon + " " : ""}${c.date} — ${c.title}`;

          item.append(editBtn, deleteBtn, label);
          listEl.appendChild(item);
        });
      }
    } catch (e) {
      // Static shell via innerHTML; error message via textContent
      body.innerHTML = `
        <div class="debug-log-header">
          <button class="debug-back" data-debug-action="back">‹ Back</button>
          <span class="debug-log-title">Countdowns</span>
        </div>
        <p class="debug-countdown-error" style="color: var(--live)"></p>
      `;
      body.querySelector(".debug-countdown-error").textContent = `Failed to load: ${e.message}`;
    }
  }

  function showEditCountdown(oldDate, oldTitle, oldIcon) {
    mode = "countdowns";
    const isAnnual = /^\d{2}-\d{2}$/.test(oldDate);
    const toggleLabel = isAnnual ? "Full date (YYYY-MM-DD)" : "Annual (MM-DD)";

    // Static shell via innerHTML — no user data
    body.innerHTML = `
      <div class="debug-log-header">
        <button class="debug-back" data-debug-action="countdowns">‹ Back</button>
        <span class="debug-log-title">Edit Countdown</span>
      </div>
    `;

    // Build form with DOM APIs — user data via value/dataset
    const form = document.createElement("form");
    form.className = "debug-countdown-form";
    form.dataset.debugAction = "save-edit-form";
    form.dataset.oldDate = oldDate;
    form.dataset.oldTitle = oldTitle;

    const dateInput = document.createElement("input");
    dateInput.name = "date";
    dateInput.required = true;
    dateInput.value = oldDate;
    if (isAnnual) {
      dateInput.type = "text";
      dateInput.placeholder = "MM-DD";
      dateInput.pattern = "\\d{2}-\\d{2}";
    } else {
      dateInput.type = "date";
    }

    const iconInput = document.createElement("input");
    iconInput.type = "text";
    iconInput.name = "icon";
    iconInput.className = "debug-countdown-icon";
    iconInput.maxLength = 8;
    iconInput.placeholder = "⏳";
    iconInput.title = "Optional icon emoji";
    iconInput.value = oldIcon || "";

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.name = "title";
    titleInput.required = true;
    titleInput.maxLength = 100;
    titleInput.value = oldTitle;

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "debug-action";
    cancelBtn.dataset.debugAction = "countdowns";
    cancelBtn.textContent = "Cancel";

    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "debug-action";
    saveBtn.textContent = "Save";

    const toggleLink = document.createElement("a");
    toggleLink.href = "#";
    toggleLink.className = "debug-toggle-annual";
    toggleLink.dataset.debugAction = "toggle-annual";
    toggleLink.textContent = toggleLabel;

    form.append(dateInput, iconInput, titleInput, cancelBtn, saveBtn, toggleLink);
    body.appendChild(form);
  }

  async function addCountdown(date, title, icon) {
    try {
      const resp = await fetch("/api/countdowns", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({date, title, icon})
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      // Refresh the countdown list and re-render the countdown widget
      countdowns = data.countdowns;
      renderCountdown();
      await showCountdowns();
    } catch (e) {
      alert(`Failed to add countdown: ${e.message}`);
    }
  }

  async function editCountdown(oldDate, oldTitle, newDate, newTitle, newIcon) {
    try {
      const resp = await fetch("/api/countdowns", {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({oldDate, oldTitle, newDate, newTitle, newIcon})
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      countdowns = data.countdowns;
      renderCountdown();
      await showCountdowns();
    } catch (e) {
      alert(`Failed to edit countdown: ${e.message}`);
    }
  }

  async function deleteCountdown(date, title) {
    if (!confirm(`Remove "${title}" (${date})?`)) return;
    try {
      const resp = await fetch("/api/countdowns", {
        method: "DELETE",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({date, title})
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      countdowns = data.countdowns;
      renderCountdown();
      await showCountdowns();
    } catch (e) {
      alert(`Failed to delete countdown: ${e.message}`);
    }
  }

  function startUpdateCountdown() {
    if (!banner || cancelTimer) return;
    let remaining = 3;
    banner.textContent = `Updating in ${remaining}s — click to cancel`;
    banner.classList.add("active");
    banner.classList.remove("firing");
    cancelTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(cancelTimer);
        cancelTimer = null;
        fireUpdate();
      } else {
        banner.textContent = `Updating in ${remaining}s — click to cancel`;
      }
    }, 1000);
  }

  function cancelUpdateCountdown() {
    // Three states the banner can be in:
    //   1. counting down to fire — cancel the countdown, hide banner
    //   2. fired and waiting for reload — ignore (mid-flight, don't let
    //      a click reset state during the 30s window)
    //   3. post-timeout "Update complete" — dismiss
    if (cancelTimer) {
      clearInterval(cancelTimer);
      cancelTimer = null;
      if (banner) banner.classList.remove("active");
      return;
    }
    if (banner && banner.classList.contains("firing") && !firedTimeout) {
      // firedTimeout cleared = post-timeout state
      banner.classList.remove("active", "firing");
    }
  }

  async function fireUpdate() {
    if (!banner) return;
    banner.classList.add("firing");
    banner.textContent = "Update started — page will reload when ready";
    try {
      const resp = await fetch("/api/update", { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (data.error) {
        banner.textContent = `Update failed: ${data.error}`;
        return;  // leave banner up so the user sees the error
      }
    } catch {
      // Server may have already restarted us — that's the success case,
      // not a failure. The page will reload when the new SHA is detected.
    }
    // Fast-poll /api/version once a second for up to 60s. watchVersion's
    // 30s cadence means a fresh deploy could otherwise sit unnoticed for
    // up to 30 seconds; this catches it as soon as the new server is up.
    // Cache-bust the URL so a worker/HTTP layer can't hand us back the
    // old SHA from a stale connection.
    if (fastPollTimer) clearInterval(fastPollTimer);
    let pollsRemaining = 60;
    fastPollTimer = setInterval(async () => {
      pollsRemaining -= 1;
      if (pollsRemaining <= 0) {
        clearInterval(fastPollTimer);
        fastPollTimer = null;
        return;
      }
      try {
        const { version } = await fetchJson(`/api/version?t=${Date.now()}`);
        if (version && initialVersion && version !== initialVersion) {
          location.reload();
        }
      } catch { /* server is mid-restart — try again next tick */ }
    }, 1000);
    // If we're still here 30s later, the SHA didn't flip (likely:
    // --force restart against unchanged code). Swap to a "completed"
    // banner so the user knows it's done and can dismiss.
    firedTimeout = setTimeout(() => {
      firedTimeout = null;
      banner.textContent = "Update complete — click to dismiss";
    }, 30 * 1000);
  }

  async function openDebug() {
    if (open) return;
    open = true;
    sheet.classList.add("open");
    backdrop.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    await showFields();
  }

  function closeDebug() {
    if (!open) return;
    open = false;
    mode = "fields";
    sheet.classList.remove("open");
    backdrop.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
    clearTimers();
    serverStartedAt = null;
  }

  dot.addEventListener("click", openDebug);
  close.addEventListener("click", closeDebug);
  backdrop.addEventListener("click", closeDebug);

  // Single delegated click handler for all in-sheet buttons. Cheaper and
  // simpler than re-wiring listeners every time body.innerHTML is rewritten.
  body.addEventListener("click", (e) => {
    const target = e.target.closest("[data-debug-action]");
    if (!target) return;
    const action = target.dataset.debugAction;
    if (action === "back") showFields();
    else if (action === "log-service") showLog("service");
    else if (action === "log-update") showLog("update");
    else if (action === "update") startUpdateCountdown();
    else if (action === "countdowns") showCountdowns();
    else if (action === "display") showDisplay();
    else if (action === "display-reset") resetDisplay();
    else if (action === "edit-countdown") {
      const d = target.dataset.cdDate;
      const t = target.dataset.cdTitle;
      const i = target.dataset.cdIcon;
      if (d && t) showEditCountdown(d, t, i);
    }
    else if (action === "delete-countdown") {
      const d = target.dataset.cdDate;
      const t = target.dataset.cdTitle;
      if (d && t) deleteCountdown(d, t);
    }
    else if (action === "toggle-annual") {
      e.preventDefault();
      const form = target.closest("form");
      if (!form) return;
      const dateField = form.elements.date;
      if (dateField.type === "date") {
        // Switch to annual MM-DD text input
        dateField.type = "text";
        dateField.removeAttribute("value");
        dateField.value = "";
        dateField.placeholder = "MM-DD";
        dateField.pattern = "\\d{2}-\\d{2}";
        target.textContent = "Full date (YYYY-MM-DD)";
      } else {
        // Switch to full date picker
        dateField.type = "date";
        dateField.value = "";
        dateField.removeAttribute("placeholder");
        dateField.removeAttribute("pattern");
        target.textContent = "Annual (MM-DD)";
      }
    }
  });

  // Handle the countdown add/edit form submission
  body.addEventListener("submit", (e) => {
    const form = e.target;
    if (form.matches("[data-debug-action='display-form']")) {
      e.preventDefault();
      saveDisplay(form);
    } else if (form.matches("[data-debug-action='add-countdown-form']")) {
      e.preventDefault();
      const date = form.elements.date.value;
      const title = form.elements.title.value.trim();
      const icon = form.elements.icon.value.trim();
      if (date && title) addCountdown(date, title, icon);
    } else if (form.matches("[data-debug-action='save-edit-form']")) {
      e.preventDefault();
      const oldDate = form.dataset.oldDate;
      const oldTitle = form.dataset.oldTitle;
      const newDate = form.elements.date.value;
      const newTitle = form.elements.title.value.trim();
      const newIcon = form.elements.icon.value.trim();
      if (oldDate && oldTitle && newDate && newTitle) {
        editCountdown(oldDate, oldTitle, newDate, newTitle, newIcon);
      }
    }
  });

  if (banner) banner.addEventListener("click", cancelUpdateCountdown);

  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.key === "d" || e.key === "D" || e.key === "?") {
      e.preventDefault();
      open ? closeDebug() : openDebug();
    } else if (e.key === "Escape" && open) {
      // Escape from a log/countdowns/display view returns to the field list;
      // Escape from the field list closes the panel entirely.
      if (mode === "log" || mode === "countdowns" || mode === "display") showFields();
      else closeDebug();
    } else if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      body.scrollBy({ top: e.key === "ArrowDown" ? 60 : -60, behavior: "smooth" });
    }
  });

  if (openNow) openDebug();
}
