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
function createRotator({ dotsEl, navEl, viewsContainer, viewClassPrefix, titleEl, titles, views, getRotationMs, onShow, swipeEl }) {
  let currentViews = views.slice();
  let index = 0;
  let timer = null;

  const wrap = i => ((i % currentViews.length) + currentViews.length) % currentViews.length;

  // Touch swipe: left swipe -> next, right swipe -> previous. Mirrors the
  // .rot-nav button behavior so all controls share one code path via jumpTo.
  // Thresholds: X delta must exceed 40px and be at least 1.5x the Y delta
  // (axis-dominance check) to count as a horizontal swipe — otherwise it's
  // treated as a vertical scroll and ignored.
  if (swipeEl) {
    const SWIPE_MIN_X = 40;
    const SWIPE_AXIS_RATIO = 1.5;
    let touchStartX = null;
    let touchStartY = null;
    let touchActive = false;

    swipeEl.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { touchActive = false; return; }
      const t = e.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      touchActive = true;
    }, { passive: true });

    swipeEl.addEventListener("touchmove", (e) => {
      if (!touchActive || touchStartX == null) return;
      const t = e.touches[0];
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;
      // Cancel the gesture once a clear vertical scroll dominates — keeps
      // page scrolling responsive and avoids a swipe firing after a scroll.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SWIPE_MIN_X) {
        touchActive = false;
      }
    }, { passive: true });

    swipeEl.addEventListener("touchend", (e) => {
      const wasActive = touchActive && touchStartX != null;
      const startX = touchStartX;
      const startY = touchStartY;
      touchActive = false;
      touchStartX = null;
      touchStartY = null;
      if (!wasActive) return;
      if (e.changedTouches.length === 0) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) < SWIPE_MIN_X) return;
      if (Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return;
      if (currentViews.length < 2) return;
      // Left swipe (dx < 0) -> next; right swipe (dx > 0) -> previous.
      jumpTo(index + (dx < 0 ? 1 : -1));
    }, { passive: true });

    swipeEl.addEventListener("touchcancel", () => {
      touchActive = false;
      touchStartX = null;
      touchStartY = null;
    }, { passive: true });
  }

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

// Map of bucket name -> sorted games list, populated by renderNHL. The
// click handler reads from this to resolve a clicked DOM node back to the
// rich game payload without stuffing it into data attributes.
const _nhlGamesByBucket = { today: [], yesterday: [] };

function renderNHL(games, containerSelector, emptyMessage = "No games.", bucket = null) {
  const el = document.querySelector(containerSelector);
  if (!el) return;
  el.classList.remove("error");
  if (!games || !games.length) {
    el.innerHTML = `<p style="color: var(--text-muted)">${emptyMessage}</p>`;
    if (bucket) _nhlGamesByBucket[bucket] = [];
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
  if (bucket) _nhlGamesByBucket[bucket] = sorted;

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

  const ROUND_LABELS = {
    1: "Round 1",
    2: "Round 2",
    3: "Conference Final",
    4: "Stanley Cup Final",
  };

  const renderGame = (g, idx) => {
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
    const r = Number(g.playoffRound);
    const hasRound = Number.isInteger(r) && r >= 1 && r <= 4;
    const roundLabel = hasRound ? escapeHtml(ROUND_LABELS[r]) : "";
    const roundAttr = hasRound ? ` data-playoff-round="${r}"` : "";
    const matchupLabel = `${escapeHtml(g.away.fullName || g.away.name || g.away.abbrev || "away")} at ${escapeHtml(g.home.fullName || g.home.name || g.home.abbrev || "home")}`;
    const clickAttrs = bucket
      ? `class="game game-clickable ${stateCls}" tabindex="0" role="button" aria-label="Show details for ${matchupLabel}${hasRound ? `, ${roundLabel}` : ""}" data-nhl-bucket="${escapeHtml(bucket)}" data-nhl-index="${idx}"${hasRound ? ` title="${roundLabel}"` : ""}${roundAttr}`
      : `class="game ${stateCls}"${hasRound ? ` title="${roundLabel}"` : ""}${roundAttr}`;
    return `
    <div ${clickAttrs}>
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

// ---------- NHL game details modal ----------

const COUNTRY_FLAG = { US: "US", CA: "CA" };

const GD_ROUND_LABELS = {
  1: "Round 1",
  2: "Round 2",
  3: "Conference Final",
  4: "Stanley Cup Final",
};

// Team brand-primary colors keyed on NHL `abbrev`. Used to render the thin
// vertical color bar on each team block in the matchup header. Values are
// well-known primary brand colors (not authoritative; close-enough is fine —
// alternates can be tuned in a follow-up). Unknown teams fall back to the
// CSS `--accent` color via `_teamColor()`.
const _TEAM_COLORS = Object.freeze({
  ANA: "#FC4C02", // Anaheim Ducks — orange
  BOS: "#FFB81C", // Boston Bruins — gold
  BUF: "#002654", // Buffalo Sabres — navy
  CGY: "#C8102E", // Calgary Flames — red
  CAR: "#CC0000", // Carolina Hurricanes — red
  CHI: "#CF0A2C", // Chicago Blackhawks — red
  COL: "#6F263D", // Colorado Avalanche — burgundy
  CBJ: "#002654", // Columbus Blue Jackets — navy
  DAL: "#006847", // Dallas Stars — green
  DET: "#CE1126", // Detroit Red Wings — red
  EDM: "#FF4C00", // Edmonton Oilers — orange
  FLA: "#C8102E", // Florida Panthers — red
  LAK: "#111111", // Los Angeles Kings — black
  MIN: "#154734", // Minnesota Wild — green
  MTL: "#AF1E2D", // Montréal Canadiens — red
  NSH: "#FFB81C", // Nashville Predators — gold
  NJD: "#CE1126", // New Jersey Devils — red
  NYI: "#00539B", // New York Islanders — blue
  NYR: "#0038A8", // New York Rangers — blue
  OTT: "#C8102E", // Ottawa Senators — red
  PHI: "#F74902", // Philadelphia Flyers — orange
  PIT: "#FCB514", // Pittsburgh Penguins — gold
  SEA: "#001628", // Seattle Kraken — deep blue
  SJS: "#006D75", // San Jose Sharks — teal
  STL: "#002F87", // St. Louis Blues — blue
  TBL: "#002868", // Tampa Bay Lightning — blue
  TOR: "#00205B", // Toronto Maple Leafs — blue
  UTA: "#71AFE5", // Utah Hockey Club — blue
  VAN: "#00205B", // Vancouver Canucks — blue
  VGK: "#B4975A", // Vegas Golden Knights — gold
  WSH: "#C8102E", // Washington Capitals — red
  WPG: "#041E42", // Winnipeg Jets — navy
});

function _teamColor(abbrev) {
  return (abbrev && _TEAM_COLORS[abbrev]) || "var(--accent)";
}

// Build the modal contents using DOM APIs (textContent + appendChild) rather
// than HTML-string concatenation. Team names, venue, broadcaster strings,
// odds, etc. all originate from a third-party API (proxied through our
// backend) — treat as untrusted and never inject as HTML. Returns a
// DocumentFragment ready to be swapped into #game-body.
//
// Layout (Phase 1 redesign — see GH issue #40):
//   1. Matchup header: away block (color bar + logo + name) | hero score +
//      state pill | home block (color bar + logo + name)
//   2. Series-progress row (playoff games only): label, numbered pills
//      (filled through current game), leader text
//   3. Detail rows (start time when not scheduled, game type, odds — <dl>)
//   4. Venue row: 📍 + clickable venue link (Wikipedia or Google fallback)
//   5. Broadcasts row: 📺 + clickable broadcast network anchors
//   6. Footer action buttons: ▶ Game Center (primary, accent fill) |
//      🏆 Series Page (secondary)
function renderGameDetails(g) {
  const frag = document.createDocumentFragment();

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== "") node.textContent = String(text);
    return node;
  };
  const textNode = s => document.createTextNode(String(s));

  const isLive = g.state === "LIVE" || g.state === "CRIT";
  const isPregame = g.state === "PRE";
  const isScheduled = g.state === "FUT" || isPregame;
  const isFinal = g.state === "OFF" || g.state === "FINAL";
  const startLabel = g.startTime ? formatTime(g.startTime) : "";

  // ---- Matchup header (logos + names + hero score + state pill) ----
  const buildTeamBlock = (t, side) => {
    const wrap = el("div", `gd-team gd-team-${side}`);
    // Thin team-color bar at the side. Pulls from the static _TEAM_COLORS
    // map; falls back to --accent for unknown abbreviations.
    const bar = el("span", "gd-team-bar");
    bar.style.background = _teamColor(t.abbrev);
    bar.setAttribute("aria-hidden", "true");
    wrap.appendChild(bar);

    const inner = el("div", "gd-team-inner");
    const logoUrl = safeUrl(t.logo);
    if (logoUrl) {
      const img = document.createElement("img");
      img.className = "gd-team-logo";
      img.src = logoUrl;
      img.alt = "";
      img.onerror = function () { this.remove(); };
      inner.appendChild(img);
    }
    const name = el("span", "gd-team-name", t.fullName || t.name || t.abbrev || "");
    if (t.isFavorite) {
      name.appendChild(textNode(" "));
      const star = el("span", "fav-star", "★");
      star.setAttribute("aria-label", "Favorite team");
      name.appendChild(star);
    }
    inner.appendChild(name);
    inner.appendChild(el("span", "gd-team-abbrev", t.abbrev || ""));
    wrap.appendChild(inner);
    return wrap;
  };

  const buildScoreStack = () => {
    const stack = el("div", "gd-score-stack");
    const awayScore = g.away.score != null ? String(g.away.score) : "";
    const homeScore = g.home.score != null ? String(g.home.score) : "";
    const showScore = (isLive || isFinal) && (awayScore !== "" || homeScore !== "");

    if (showScore) {
      const scoreRow = el("div", "gd-score");
      scoreRow.appendChild(el("span", "gd-score-num gd-score-away", awayScore || "0"));
      scoreRow.appendChild(el("span", "gd-score-sep", "–"));
      scoreRow.appendChild(el("span", "gd-score-num gd-score-home", homeScore || "0"));
      stack.appendChild(scoreRow);
    } else {
      // Pre-game / scheduled — show "@" as a quiet visual anchor
      stack.appendChild(el("div", "gd-score gd-score-vs", "@"));
    }

    // State pill (live / scheduled / final / pregame). Re-uses existing
    // .status-pill classes from style.css.
    let pill = null;
    if (isLive) {
      pill = el("span", "status-pill live gd-state-pill", g.statusText || "LIVE");
    } else if (isFinal) {
      pill = el("span", "status-pill final gd-state-pill", g.statusText || "Final");
    } else if (isScheduled) {
      pill = el("span", "status-pill scheduled gd-state-pill", startLabel || "Scheduled");
    }
    if (pill) stack.appendChild(pill);
    return stack;
  };

  const matchup = el("div", "gd-matchup");
  // Drive the soft team-color fade in CSS via custom props so each game
  // renders its own palette without inline gradients.
  matchup.style.setProperty("--gd-team-color-away", _teamColor(g.away.abbrev));
  matchup.style.setProperty("--gd-team-color-home", _teamColor(g.home.abbrev));
  matchup.appendChild(buildTeamBlock(g.away, "away"));
  matchup.appendChild(buildScoreStack());
  matchup.appendChild(buildTeamBlock(g.home, "home"));
  frag.appendChild(matchup);

  // ---- Series progress row (playoff only) ----
  if (g.series) {
    const series = g.series;
    const needed = Number(series.neededToWin) || 4;
    const totalDots = needed * 2 - 1; // 7 for best-of-4
    const gameNum = Number(series.gameNumber) || 0;
    const top = series.topSeedAbbrev || "";
    const bot = series.bottomSeedAbbrev || "";
    const topW = Number(series.topSeedWins) || 0;
    const botW = Number(series.bottomSeedWins) || 0;
    const round = Number(series.round);
    const roundLabel = GD_ROUND_LABELS[round] || series.title || "Playoffs";

    const seriesWrap = el("div", "gd-series-row");

    const labelWrap = el("div", "gd-series-label");
    const parts = [roundLabel];
    if (gameNum) parts.push(`Game ${gameNum}`);
    parts.push(`Best of ${totalDots}`);
    labelWrap.appendChild(textNode(parts.join(" · ")));
    seriesWrap.appendChild(labelWrap);

    // Numbered progress pills. "Filled" through the current game (every
     // pill at index <= gameNumber gets the accent fill); pills after the
     // current game stay muted/ring-only. The current pill itself gets a
     // subtle emphasis ring on top of the accent fill so the user can tell
     // where in the series we are at a glance.
    const dotsWrap = el("div", "gd-series-dots", null);
    dotsWrap.setAttribute("role", "img");
    dotsWrap.setAttribute(
      "aria-label",
      gameNum ? `Game ${gameNum} of ${totalDots}` : `Best of ${totalDots}`
    );
    for (let i = 1; i <= totalDots; i++) {
      const isFilled = gameNum > 0 && i <= gameNum;
      const isCurrent = i === gameNum;
      const cls = [
        "gd-series-pill",
        isFilled ? "is-filled" : "",
        isCurrent ? "is-current" : "",
      ].filter(Boolean).join(" ");
      dotsWrap.appendChild(el("span", cls, String(i)));
    }
    seriesWrap.appendChild(dotsWrap);

    let leaderText;
    if (top && bot) {
      if (topW === 0 && botW === 0) {
        leaderText = "Series tied 0–0";
      } else if (topW === botW) {
        leaderText = `Series tied ${topW}–${botW}`;
      } else if (topW > botW) {
        leaderText = topW >= needed
          ? `${top} won ${topW}–${botW}`
          : `${top} leads ${topW}–${botW}`;
      } else {
        leaderText = botW >= needed
          ? `${bot} won ${botW}–${topW}`
          : `${bot} leads ${botW}–${topW}`;
      }
    }
    if (leaderText) {
      seriesWrap.appendChild(el("div", "gd-series-leader", leaderText));
    }

    frag.appendChild(seriesWrap);
  }

  // ---- Start time + game type, combined on a single centered line ----
  // On desktop these sit side-by-side separated by a "·"; on narrow widths the
  // CSS stacks them. Only shows the start time as a dedicated entry when not
  // scheduled (the scheduled pill in the header already shows it).
  const showStart = startLabel && !isScheduled;
  if (showStart || g.gameTypeLabel) {
    const metaRow = el("div", "gd-meta-row");
    if (showStart) {
      const startSpan = el("span", "gd-meta-item");
      startSpan.appendChild(el("span", "gd-meta-label", "Start"));
      startSpan.appendChild(textNode(" "));
      startSpan.appendChild(el("span", "gd-meta-value", startLabel));
      metaRow.appendChild(startSpan);
    }
    if (showStart && g.gameTypeLabel) {
      metaRow.appendChild(el("span", "gd-meta-sep", "·"));
    }
    if (g.gameTypeLabel) {
      const typeSpan = el("span", "gd-meta-item");
      typeSpan.appendChild(el("span", "gd-meta-value", g.gameTypeLabel));
      metaRow.appendChild(typeSpan);
    }
    frag.appendChild(metaRow);
  }

  // ---- Other detail rows preserved as <dl> (odds) ----
  const rows = [];

  if (g.away.odds || g.home.odds) {
    const oddsWrap = el("div", "gd-odds");
    const addOddsTeam = (abbrev, odds) => {
      if (!odds) return;
      const team = el("span", "gd-odds-team");
      team.appendChild(el("span", "gd-odds-abbrev", abbrev || ""));
      team.appendChild(textNode(` ${odds}`));
      oddsWrap.appendChild(team);
    };
    addOddsTeam(g.away.abbrev, g.away.odds);
    addOddsTeam(g.home.abbrev, g.home.odds);
    rows.push(["Odds", oddsWrap]);
  }

  if (rows.length) {
    const dl = document.createElement("dl");
    rows.forEach(([label, valueNode]) => {
      const dt = el("dt", null, label);
      const dd = document.createElement("dd");
      dd.appendChild(valueNode);
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    frag.appendChild(dl);
  }

  // ---- Venue row (with location pin) ----
  // Venue gets its own muted line. When the server provides a URL
  // (`venueUrl` — Wikipedia for known arenas, Google search fallback
  // otherwise), render as an anchor so kiosk viewers can click through.
  let venueRow = null;
  if (g.venue) {
    venueRow = el("div", "gd-venue-row");
    let venueNode;
    if (g.venueUrl) {
      venueNode = document.createElement("a");
      venueNode.className = "gd-venue-link";
      venueNode.href = g.venueUrl;
      venueNode.target = "_blank";
      venueNode.rel = "noopener noreferrer";
      venueNode.setAttribute("aria-label", `Venue: ${g.venue}`);
    } else {
      venueNode = el("span", "gd-venue-link");
    }
    const pin = el("span", "gd-venue-icon", "📍");
    pin.setAttribute("aria-hidden", "true");
    venueNode.appendChild(pin);
    venueNode.appendChild(textNode(" "));
    venueNode.appendChild(textNode(g.venue));
    venueRow.appendChild(venueNode);
    if (g.neutralSite) {
      venueRow.appendChild(textNode(" "));
      venueRow.appendChild(el("span", "gd-venue-neutral", "(neutral site)"));
    }
    frag.appendChild(venueRow);
  }

  // ---- Broadcasts row (with TV icon) ----
  // Pulled out of the old combined venue/broadcasts line so the user can
  // scan "where to watch" at a glance. Each broadcast is still an anchor
  // when the server provides a URL, plain span otherwise.
  let broadcastsRow = null;
  const broadcasts = g.broadcasts || [];
  if (broadcasts.length) {
    broadcastsRow = el("div", "gd-broadcasts-row");
    const tvIcon = el("span", "gd-broadcast-icon", "📺");
    tvIcon.setAttribute("aria-hidden", "true");
    broadcastsRow.appendChild(tvIcon);
    broadcasts.forEach((b, i) => {
      if (i > 0) broadcastsRow.appendChild(el("span", "gd-meta-sep", "·"));
      let node;
      if (b.url) {
        node = document.createElement("a");
        node.className = "gd-broadcast";
        node.href = b.url;
        node.target = "_blank";
        node.rel = "noopener noreferrer";
        node.textContent = b.network || "";
      } else {
        node = el("span", "gd-broadcast", b.network || "");
      }
      const country = COUNTRY_FLAG[b.country] || b.country || "";
      if (country) {
        node.appendChild(textNode(" "));
        node.appendChild(el("span", "gd-country", country));
      }
      broadcastsRow.appendChild(node);
    });
    frag.appendChild(broadcastsRow);
  }

  // ---- Footer action buttons ----
  // Game Center is the primary CTA — accent-filled, with a play icon.
  // Series Page stays in the secondary/muted style with a trophy icon.
  const actionSpecs = [
    [g.gameCenterLink, "Game Center", "▶", "gd-action-primary"],
    [g.seriesUrl, "Series Page", "🏆", "gd-action-secondary"],
  ].filter(([href]) => !!href);
  if (actionSpecs.length) {
    const actions = el("div", "gd-actions");
    if (actionSpecs.length === 1) actions.classList.add("gd-actions-single");
    actionSpecs.forEach(([href, label, icon, variant]) => {
      const a = document.createElement("a");
      a.className = `gd-action ${variant}`;
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const iconSpan = el("span", "gd-action-icon", icon);
      iconSpan.setAttribute("aria-hidden", "true");
      a.appendChild(iconSpan);
      a.appendChild(textNode(" "));
      a.appendChild(textNode(label));
      actions.appendChild(a);
    });
    frag.appendChild(actions);
  }

  // Empty-state fallback. The matchup header is always rendered (away team,
  // score stack, home team) so we can't gate on `matchup.childElementCount`
  // — that check is unreachable. Instead, fall back when the payload has no
  // usable secondary content (no detail rows, no venue, no broadcasts, and
  // no action links). Rare but possible for malformed payloads.
  if (!rows.length && !venueRow && !broadcastsRow && !actionSpecs.length) {
    const empty = el("p", null, "No additional info available.");
    empty.style.color = "var(--text-muted)";
    frag.appendChild(empty);
  }

  return frag;
}

function setupGameDetails() {
  const sheet = document.getElementById("game-sheet");
  const backdrop = document.getElementById("game-backdrop");
  const body = document.getElementById("game-body");
  const titleEl = document.getElementById("game-sheet-title");
  const closeBtn = document.getElementById("game-close");
  if (!sheet || !backdrop || !body || !closeBtn || !titleEl) return;

  let open = false;
  let returnFocusTo = null;

  // Selectors for elements considered focusable for the focus-trap.
  const FOCUSABLE_SEL = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function focusableElements() {
    return Array.from(sheet.querySelectorAll(FOCUSABLE_SEL))
      .filter(el => !el.hasAttribute("disabled") && el.offsetParent !== null);
  }

  function openDetails(game, originEl) {
    if (!game) return;
    open = true;
    returnFocusTo = originEl || null;
    const headline = `${game.away.fullName || game.away.name || game.away.abbrev || "Away"} @ ${game.home.fullName || game.home.name || game.home.abbrev || "Home"}`;
    titleEl.textContent = headline;
    body.replaceChildren(renderGameDetails(game));
    sheet.classList.add("open");
    backdrop.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    sheet.focus();
  }

  function closeDetails() {
    if (!open) return;
    open = false;
    sheet.classList.remove("open");
    backdrop.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
    if (returnFocusTo && typeof returnFocusTo.focus === "function") {
      returnFocusTo.focus();
    }
    returnFocusTo = null;
  }

  // Delegate clicks on rendered game cards (works across re-renders without
  // re-wiring listeners). Cards carry data-nhl-bucket / data-nhl-index that
  // resolve back to the cached payload in _nhlGamesByBucket.
  document.getElementById("nhl").addEventListener("click", (e) => {
    const target = e.target.closest("[data-nhl-bucket][data-nhl-index]");
    if (!target) return;
    const bucket = target.dataset.nhlBucket;
    const idx = Number(target.dataset.nhlIndex);
    const list = _nhlGamesByBucket[bucket];
    const game = list && list[idx];
    if (game) openDetails(game, target);
  });

  // Keyboard activation for the role="button" cards: Enter / Space behave
  // like a click. Space is preventDefault'd so the page doesn't scroll.
  document.getElementById("nhl").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target.closest("[data-nhl-bucket][data-nhl-index]");
    if (!target) return;
    e.preventDefault();
    const bucket = target.dataset.nhlBucket;
    const idx = Number(target.dataset.nhlIndex);
    const list = _nhlGamesByBucket[bucket];
    const game = list && list[idx];
    if (game) openDetails(game, target);
  });

  closeBtn.addEventListener("click", closeDetails);
  backdrop.addEventListener("click", closeDetails);

  document.addEventListener("keydown", (e) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeDetails();
      return;
    }
    // Focus trap: keep Tab / Shift+Tab cycling within the modal's focusable
    // elements while open. The sheet itself is tabindex=-1 (programmatic focus
    // only), so we restrict the cycle to its descendants plus a fallback to
    // the close button.
    if (e.key !== "Tab") return;
    const focusables = focusableElements();
    if (focusables.length === 0) {
      e.preventDefault();
      closeBtn.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    // If focus has somehow escaped the modal (e.g. the sheet itself, or a
    // background element), pull it back to the first focusable.
    if (!sheet.contains(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

const NHL_TITLES = { today: "NHL Scores", yesterday: "Yesterday" };
let nhlRotationMs = 10000;
let nhlRotator = null;

async function refreshNHL() {
  try {
    const data = await fetchJson("/api/nhl");
    if (data && data.error) {
      showError("nhl", data.error, ".view-nhl-today");
      return;
    }
    renderNHL(data.today?.games, "#nhl .view-nhl-today", "No games today.", "today");
    if (data.yesterday) {
      renderNHL(data.yesterday.games, "#nhl .view-nhl-yesterday", "No games yesterday.", "yesterday");
    }
    const canRotate = !!(data.yesterday && !data.hasLiveToday);
    nhlRotator.setViews(canRotate ? ["today", "yesterday"] : ["today"]);
    setUpdated("nhl");
  } catch (e) {
    showError("nhl", e.message, ".view-nhl-today");
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

const fmtNum = (v, suffix = "") =>
  (v == null || Number.isNaN(v)) ? "—" : `${Math.round(v)}${suffix}`;

// Build a Google search URL for the configured city's hourly forecast. Google's
// hourly-forecast card is more glanceable than a lat/lon map view and works for
// any city name without an API key.
function forecastSearchUrl(label) {
  if (typeof label !== "string" || !label.trim()) return "";
  const q = encodeURIComponent(`${label.trim()} hourly forecast`).replace(/%20/g, "+");
  return `https://www.google.com/search?q=${q}`;
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
    rangeEl.appendChild(document.createTextNode(` ${fmtNum(d.max, "°")}`));
    dayEl.appendChild(rangeEl);

    dailyEl.appendChild(dayEl);
  });
  wrapper.appendChild(dailyEl);

  el.replaceChildren(wrapper);
}

async function refreshWeather() {
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

  const isDateOnly = ev => typeof ev.start === "string" && ev.start.length === 10;
  const timeLabel = ev => (ev.allDay || isDateOnly(ev)) ? "All day" : formatTime(ev.start);

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
    swipeEl: bodyEl("nhl"),
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
    swipeEl: bodyEl("weather"),
  });
  weatherRotator.start();

  rssRotator = createRotator({
    dotsEl: document.getElementById("rss-dots"),
    navEl: document.getElementById("rss-nav"),
    views: ["0"],  // renderRSS expands once we know the feed count
    getRotationMs: () => rssRotationMs,
    onShow: onRssViewShown,
    swipeEl: bodyEl("rss"),
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
  setupGameDetails();
  watchVersion();
}

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
  const pyDocsUrl = `https://docs.python.org/release/${encodeURIComponent(data.pythonVersion)}/`;

  return `<dl>
    <dt>SHA</dt><dd class="mono"><a href="${escapeHtml(ghCommitUrl)}" target="_blank" rel="noopener">${escapeHtml(data.versionShort)}</a> <a href="${escapeHtml(ghCommitUrl)}" target="_blank" rel="noopener" style="color:var(--text-muted)">(${escapeHtml(data.version)})</a></dd>
    <dt>Latest commit</dt><dd>${commit}</dd>
    <dt>Server uptime</dt><dd><span id="debug-uptime">${uptime}</span></dd>
    <dt>Viewport</dt><dd>${window.innerWidth}×${window.innerHeight}</dd>
    <dt>User agent</dt><dd id="debug-ua"></dd>
    <dt>Python</dt><dd><a href="${escapeHtml(pyDocsUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.pythonVersion)}</a></dd>
    <dt>Platform</dt><dd>${escapeHtml(data.platform)}</dd>
    <dt>RSS feeds</dt><dd>${data.rssFeedCount}</dd>
    <dt>Calendar URLs</dt><dd>${data.calendarUrlCount}</dd>
    <dt>Cache (${data.cache.length})</dt><dd>${cache}</dd>
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

function setupDebugOverlay() {
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

// Captured at startup; read by fireUpdate so it can fast-poll for a SHA
// flip without waiting up to 30s for the next watchVersion tick.
let initialVersion = null;

async function watchVersion() {
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

start();
