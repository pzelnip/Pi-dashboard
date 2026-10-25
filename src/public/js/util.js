// Dashboard client: polls /api/* on independent schedules and renders into panels.
// Split across classic scripts loaded in order by index.html (see CLAUDE.md);
// they share one global scope. This file: shared state, fit-to-window zoom,
// and the small helpers every panel uses.

const REFRESH_NHL_MS = 30 * 1000;
const REFRESH_WEATHER_MS = 10 * 60 * 1000;

const _lastUpdated = {};  // { panelName: Date }

// ---------- Scale to fit ----------
//
// The layout is designed for the kiosk's 1920x1200 display and sized mostly in
// px, so a smaller window (e.g. a laptop browser) would cram the same 22px text
// into smaller panels. Instead, zoom the whole page so any window shows a
// scaled copy of the kiosk; on the Pi the zoom is exactly 1. The page is laid
// out at window size / zoom, so it still fills a window of another aspect ratio.
//
// Two zoom gotchas: CSS vw/vh still measure the real window, so desktop rules
// use var(--vw)/var(--vh) (1% of the zoomed layout viewport) instead; and
// getBoundingClientRect() returns zoomed px while clientHeight/scrollHeight
// don't, so divide rects by fitZoom before comparing them (see setNhlPages).
const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1200;
// Phone layout is a scrolling single column by design, so it's never zoomed
// (or paged, see setNhlPages).
const PHONE_LAYOUT = window.matchMedia("(max-width: 720px)");
let fitZoom = 1;

function applyFitZoom() {
  const root = document.documentElement.style;
  if (PHONE_LAYOUT.matches) {
    fitZoom = 1;
    for (const prop of ["zoom", "--vw", "--vh"]) root.removeProperty(prop);
    return;
  }
  fitZoom = Math.min(innerWidth / DESIGN_WIDTH, innerHeight / DESIGN_HEIGHT);
  root.zoom = fitZoom;
  root.setProperty("--vw", `${innerWidth / fitZoom / 100}px`);
  root.setProperty("--vh", `${innerHeight / fitZoom / 100}px`);
}
applyFitZoom();
// Registered before the NHL resize handler so re-paging sees the new zoom.
window.addEventListener("resize", applyFitZoom);

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

// Render an error inside a panel without destroying the rotator's .view-*
// structure. `viewSelector` (optional) targets a specific view that owns the
// failing data source — that way the next successful refresh writes over the
// error in the same place. If omitted, the panel body is replaced (for panels
// like RSS that have no .view children).
function showError(panel, message, viewSelector) {
  const el = bodyEl(panel);
  el.classList.remove("stale");
  const html = `<p class="panel-error">⚠ ${escapeHtml(message)}</p>`;
  const target = viewSelector ? el.querySelector(viewSelector) : null;
  if (target) {
    target.classList.remove("nhl-empty");
    target.classList.add("error");
    target.innerHTML = html;
    el.classList.remove("error");
  } else {
    el.classList.add("error");
    el.innerHTML = html;
  }
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

const TIME_FMT = { hour: "numeric", minute: "2-digit", hour12: true };
const formatTime = d => new Date(d).toLocaleTimeString("en-US", TIME_FMT);

// NHL game state predicates. Hoisted to module scope so card render
// (renderNHL) and modal render (renderGameDetails) share one source of truth.
const isLive = g => g.state === "LIVE" || g.state === "CRIT";
const isPregame = g => g.state === "PRE";
const isScheduled = g => g.state === "FUT";
const isFinal = g => !isLive(g) && !isPregame(g) && !isScheduled(g);

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Load a classic script once, on demand, into the shared global scope. Used
// for the parts the kiosk never opens (game details, debug overlay).
const _loadedScripts = {};
function loadScript(src) {
  return _loadedScripts[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => {
      delete _loadedScripts[src];
      reject(new Error(`failed to load ${src}`));
    };
    document.head.appendChild(s);
  });
}

function safeUrl(u) {
  try {
    const parsed = new URL(u, location.href);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") ? u : "";
  } catch { return ""; }
}
