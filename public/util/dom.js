// DOM helpers, fetch wrapper, panel error/updated tracking.

import { formatAgo } from "./time.js";

const _lastUpdated = {};  // { panelName: Date }

export function setUpdated(panel) {
  _lastUpdated[panel] = new Date();
  refreshUpdatedLabels();
}

export function refreshUpdatedLabels() {
  const now = Date.now();
  for (const [panel, when] of Object.entries(_lastUpdated)) {
    const el = document.querySelector(`[data-updated-for="${panel}"]`);
    if (el) el.textContent = formatAgo(now - when.getTime());
  }
}

export function bodyEl(panel) {
  return document.querySelector(`[data-body="${panel}"]`);
}

// Render an error inside a panel without destroying the rotator's .view-*
// structure. `viewSelector` (optional) targets a specific view that owns the
// failing data source — that way the next successful refresh writes over the
// error in the same place. If omitted, the panel body is replaced (for panels
// like RSS that have no .view children).
export function showError(panel, message, viewSelector) {
  const el = bodyEl(panel);
  if (!el) return;
  el.classList.remove("stale");
  const html = `<p class="panel-error">⚠ ${escapeHtml(message)}</p>`;
  const target = viewSelector ? el.querySelector(viewSelector) : null;
  if (target) {
    target.classList.add("error");
    target.innerHTML = html;
    el.classList.remove("error");
  } else {
    el.classList.add("error");
    el.innerHTML = html;
  }
}

export async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function safeUrl(u) {
  try {
    const parsed = new URL(u, location.href);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") ? u : "";
  } catch { return ""; }
}
