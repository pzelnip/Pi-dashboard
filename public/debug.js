// Debug overlay + version-watch / auto-reload.
//
// The "d" key (or the corner dot) opens a sheet with cache + commit info,
// log viewers, and a "Force update" action. /api/version is polled every 30s
// and the page reloads when the SHA changes — this is how the kiosk picks
// up a deploy.

import { escapeHtml, fetchJson } from "./util/dom.js";
import { formatAgo, formatUptime } from "./util/time.js";

const GITHUB_REPO_URL = "https://github.com/pzelnip/Pi-dashboard";

// Captured at startup; read by fireUpdate so it can fast-poll for a SHA
// flip without waiting up to 30s for the next watchVersion tick.
let initialVersion = null;

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

function renderDebugFields(data) {
  const now = Date.now();
  const uptime = formatUptime(now - data.serverStartedAt * 1000);
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

  const ghCommitUrl = `${GITHUB_REPO_URL}/commit/${encodeURIComponent(data.version)}`;

  return `<dl>
    <dt>SHA</dt><dd class="mono"><a href="${escapeHtml(ghCommitUrl)}" target="_blank" rel="noopener">${escapeHtml(data.versionShort)}</a> <a href="${escapeHtml(ghCommitUrl)}" target="_blank" rel="noopener" style="color:var(--text-muted)">(${escapeHtml(data.version)})</a></dd>
    <dt>Latest commit</dt><dd>${commit}</dd>
    <dt>Server uptime</dt><dd><span id="debug-uptime">${uptime}</span></dd>
    <dt>Viewport</dt><dd>${window.innerWidth}×${window.innerHeight}</dd>
    <dt>User agent</dt><dd>${escapeHtml(navigator.userAgent)}</dd>
    <dt>Python</dt><dd>${escapeHtml(data.pythonVersion)}</dd>
    <dt>Platform</dt><dd>${escapeHtml(data.platform)}</dd>
    <dt>RSS feeds</dt><dd>${data.rssFeedCount}</dd>
    <dt>Calendar URLs</dt><dd>${data.calendarUrlCount}</dd>
    <dt>Cache (${data.cache.length})</dt><dd>${cache}</dd>
    <dt>Service log</dt><dd><button class="debug-action" data-debug-action="log-service">view ›</button></dd>
    <dt>Update log</dt><dd><button class="debug-action" data-debug-action="log-update">view ›</button></dd>
    <dt>Force update</dt><dd><button class="debug-action danger" data-debug-action="update">run</button></dd>
  </dl>`;
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

export function setupDebugOverlay() {
  const dot = document.getElementById("debug-dot");
  const sheet = document.getElementById("debug-sheet");
  const backdrop = document.getElementById("debug-backdrop");
  const body = document.getElementById("debug-body");
  const close = document.getElementById("debug-close");
  const banner = document.getElementById("update-banner");
  if (!dot || !sheet || !backdrop || !body || !close) return;

  let open = false;
  let mode = "fields";         // "fields" | "log" — controls Escape behavior
  let tickTimer = null;        // 1Hz interval that updates uptime + page-age
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
  }

  async function showFields() {
    mode = "fields";
    body.innerHTML = "Loading…";
    try {
      const data = await fetchJson("/api/debug");
      if (data.error) throw new Error(data.error);
      serverStartedAt = data.serverStartedAt;
      body.innerHTML = renderDebugFields(data);
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
  });

  if (banner) banner.addEventListener("click", cancelUpdateCountdown);

  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.key === "d" || e.key === "D" || e.key === "?") {
      e.preventDefault();
      open ? closeDebug() : openDebug();
    } else if (e.key === "Escape" && open) {
      // Escape from a log view returns to the field list; Escape from
      // the field list closes the panel entirely.
      if (mode === "log") showFields();
      else closeDebug();
    } else if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      body.scrollBy({ top: e.key === "ArrowDown" ? 60 : -60, behavior: "smooth" });
    }
  });
}

export async function watchVersion() {
  try {
    initialVersion = (await fetchJson("/api/version"))?.version;
  } catch { return; }
  if (!initialVersion) return;

  setInterval(async () => {
    try {
      const { version } = await fetchJson("/api/version");
      if (version && version !== initialVersion) location.reload();
    } catch { /* transient — try again next tick */ }
  }, 30 * 1000);
}
