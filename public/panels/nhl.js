// NHL panel: today + yesterday rotation. The frontend pins to today only when
// a live game is in progress; otherwise rotates between the two views.

import { createRotator } from "../rotator.js";
import { escapeHtml, fetchJson, safeUrl, setUpdated, showError } from "../util/dom.js";
import { formatTime } from "../util/time.js";

const NHL_TITLES = { today: "NHL Scores", yesterday: "Yesterday" };

let nhlRotationMs = 10000;
let nhlRotator = null;

export function setNhlRotationMs(ms) { nhlRotationMs = ms; }

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

export async function refreshNHL() {
  try {
    const data = await fetchJson("/api/nhl");
    if (data && data.error) {
      showError("nhl", data.error, ".view-nhl-today");
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
    showError("nhl", e.message, ".view-nhl-today");
  }
}

export function initNhlRotator() {
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
  return nhlRotator;
}
