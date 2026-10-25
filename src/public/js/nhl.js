// NHL panel: game cards and paging, game-details wiring, refresh, off-season views.

// ---------- NHL ----------

// Map of bucket name -> sorted games list, populated by renderNHL. The
// click handler reads from this to resolve a clicked DOM node back to the
// rich game payload without stuffing it into data attributes.
const _nhlGamesByBucket = { today: [], yesterday: [] };

function renderNHL(games, containerSelector, emptyMessage = "No games.", bucket = null) {
  const el = document.querySelector(containerSelector);
  if (!el) return;
  const hadError = el.classList.contains("error");
  el.classList.remove("error");
  el.classList.toggle("nhl-empty", !games || !games.length);
  if (!games || !games.length) {
    // Arena hero in the style of the "Puck Drop" season view, so an empty
    // slate reads from across the room instead of as a tiny muted line.
    const day = new Date();
    if (bucket === "yesterday") day.setDate(day.getDate() - 1);
    const dateText = day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    el.innerHTML = `
      <div class="puck-scene" aria-hidden="true"></div>
      <div class="puck-countdown">
        <div class="puck-title">
          <span class="puck-title-sm">${escapeHtml(dateText)}</span>
          <span class="puck-title-lg">${escapeHtml(emptyMessage.replace(/\.$/, ""))}</span>
        </div>
        <div class="puck-divider" aria-hidden="true"><span></span>🏒<span></span></div>
      </div>`;
    if (bucket) {
      _nhlGamesByBucket[bucket] = [];
      setNhlPages(el, bucket, []);
    }
    return;
  }

  // Sort: live → pre-game → scheduled → final, with favorites bubbled to the top of each group.
  const statusRank = g => (isLive(g) ? 0 : isPregame(g) ? 1 : isScheduled(g) ? 2 : 3);
  const sorted = [...games].sort((a, b) => {
    const s = statusRank(a) - statusRank(b);
    if (s !== 0) return s;
    return (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0);
  });
  if (bucket) _nhlGamesByBucket[bucket] = sorted;

  // Map raw period info to a short uppercase chip label for live games.
  // Regulation periods come from periodDescriptor.number (1=1ST, 2=2ND,
  // 3=3RD); OT/SO use the periodType. Returns "" when we can't infer one.
  const livePeriodLabel = g => {
    const pd = g.periodDescriptor || {};
    const pt = (pd.periodType || "").toUpperCase();
    if (pt === "OT") return "OT";
    if (pt === "SO") return "SO";
    const n = Number(pd.number);
    if (n === 1) return "1ST";
    if (n === 2) return "2ND";
    if (n === 3) return "3RD";
    if (Number.isInteger(n) && n >= 4) return "OT";
    // Fall back to splitting the legacy statusText ("2nd · 08:32" → "2ND").
    if (g.statusText) {
      const m = String(g.statusText).match(/^([^·]+)/);
      if (m) return m[1].trim().toUpperCase();
    }
    return "";
  };

  // Live games render two pills: a loud red "● LIVE" plus a quieter period
  // chip ("2ND" / "OT" / etc.). Final pills get an OT/SO suffix when the
  // upstream outcome warrants it. Pre-game shows the amber pill + start time.
  const pillFor = g => {
    if (isLive(g)) {
      const period = livePeriodLabel(g);
      const periodChip = period
        ? `<span class="period-chip">${escapeHtml(period)}</span>`
        : "";
      return `<span class="status-pill live">LIVE</span>${periodChip}`;
    }
    if (isPregame(g)) return `<span class="status-pill pregame">${escapeHtml("Pre-game")}</span> <span class="status-pill scheduled">${escapeHtml(formatTime(g.startTime))}</span>`;
    if (isScheduled(g)) return `<span class="status-pill scheduled">${escapeHtml(formatTime(g.startTime))}</span>`;
    // Final: keep the existing Final/OT and Final/SO suffix from statusText.
    return `<span class="status-pill final">${escapeHtml(g.statusText || "Final")}</span>`;
  };

  const row = (t, outcome, isFav, venue, showGlyph) => {
    const logoUrl = safeUrl(t.logo);
    // Per-team color bar on the side. Inline style keeps the static team
    // map as the single source of truth (shared with the modal redesign).
    const barColor = _teamColor(t.abbrev);
    // Winner / leader glyph (◀) sits to the right of the score on the
    // winning/leading side, pointing back at the team. aria-hidden="true" —
    // the .winner / .leading class on the row already conveys the state to AT.
    const glyph = showGlyph
      ? `<span class="game-team-glyph" aria-hidden="true">◀</span>`
      : `<span class="game-team-glyph game-team-glyph-empty" aria-hidden="true"></span>`;
    return `
    <div class="game-team ${outcome} ${venue}" style="--team-color: ${escapeHtml(barColor)}">
      ${logoUrl ? `<img class="team-logo" src="${escapeHtml(logoUrl)}" alt="" onerror="this.remove()">` : ""}
      <span class="team-name">${escapeHtml(t.name || t.abbrev || "")}${isFav ? ' <span class="fav-star" aria-label="Favorite team">★</span>' : ""}</span>
      <span class="team-score">${escapeHtml(String(t.score ?? ""))}</span>
      ${glyph}
    </div>`;
  };

  const ROUND_LABELS = {
    1: "Round 1",
    2: "Round 2",
    3: "Conference Final",
    4: "Stanley Cup Final",
  };
  const ROMAN_NUMERALS = { 1: "I", 2: "II", 3: "III", 4: "IV" };

  // Ambient round-indicator watermark for playoff games: a single large,
  // low-opacity Roman numeral filling the card behind the foreground content.
  // Foreground sits on top via the .game's stacking context (isolation:
  // isolate). See style.css for sizing/typography.
  const renderRoundWatermark = round => {
    const numeral = ROMAN_NUMERALS[round] || "";
    return `
      <div class="round-bg" aria-hidden="true">
        <span class="round-roman">${numeral}</span>
      </div>`;
  };

  const renderGame = (g, idx) => {
    let awayCls = "", homeCls = "";
    let awayGlyph = false, homeGlyph = false;
    const bothScores = g.away.score != null && g.home.score != null;
    const tied = bothScores && g.away.score === g.home.score;
    if (isFinal(g) && bothScores) {
      if (g.away.score > g.home.score) { awayCls = "winner"; homeCls = "loser"; awayGlyph = true; }
      else if (g.home.score > g.away.score) { homeCls = "winner"; awayCls = "loser"; homeGlyph = true; }
    } else if (isLive(g) && bothScores) {
      if (g.away.score > g.home.score) { awayCls = "leading"; awayGlyph = true; }
      else if (g.home.score > g.away.score) { homeCls = "leading"; homeGlyph = true; }
    }
    // Tied class only on live games — a final regulation tie isn't a thing
    // in modern NHL (every final has a winner via OT/SO).
    const tiedCls = isLive(g) && tied ? " is-tied" : "";
    const events = bucket === "today" ? scoreEventsFor(g, isLive(g), isFinal(g)) : {};
    const goalSide = events.goal;
    const stateCls = (isLive(g) ? "is-live" : isFinal(g) ? "is-final" : "")
      + (goalSide ? ` fx-goal fx-goal-${goalSide}` : "")
      + (events.justFinal ? " fx-final-settle" : "");
    const r = Number(g.playoffRound);
    const hasRound = Number.isInteger(r) && r >= 1 && r <= 4;
    const roundLabel = hasRound ? escapeHtml(ROUND_LABELS[r]) : "";
    const roundAttr = hasRound ? ` data-playoff-round="${r}"` : "";
    const watermark = hasRound ? renderRoundWatermark(r) : "";
    const matchupLabel = `${escapeHtml(g.away.fullName || g.away.name || g.away.abbrev || "away")} at ${escapeHtml(g.home.fullName || g.home.name || g.home.abbrev || "home")}`;
    const clickAttrs = bucket
      ? `class="game game-clickable ${stateCls}${tiedCls}" tabindex="0" role="button" aria-label="Show details for ${matchupLabel}${hasRound ? `, ${roundLabel}` : ""}" data-nhl-bucket="${escapeHtml(bucket)}" data-nhl-index="${idx}"${hasRound ? ` title="${roundLabel}"` : ""}${roundAttr}`
      : `class="game ${stateCls}${tiedCls}"${hasRound ? ` title="${roundLabel}"` : ""}${roundAttr}`;
    return `
    <div ${clickAttrs}>
      <div class="game-meta">
        ${pillFor(g)}
        ${g.seriesText ? `<span class="series-tag">${escapeHtml(g.seriesText)}</span>` : ""}
      </div>
      <div class="game-body">
        ${watermark}
        <div class="game-teams">
          ${row(g.away, awayCls, g.away.isFavorite, "away", awayGlyph)}
          ${row(g.home, homeCls, g.home.isFavorite, "home", homeGlyph)}
        </div>
      </div>
      ${goalSide ? `<span class="fx-goal-badge" aria-hidden="true">GOAL!</span>` : ""}
    </div>`;
  };

  const cards = sorted.map(renderGame);
  // Same cards as on screen: skip the render-measure-render paging pass.
  if (bucket && !hadError && sameList(cards, _nhlPageCards[bucket])) return;
  if (bucket) setNhlPages(el, bucket, cards);
  else el.innerHTML = `<div class="games-grid">${cards.join("")}</div>`;
}

// Busy nights don't fit one screen of full-size cards, so a bucket's games are
// split into pages of whole rows (always two games wide), each its own rotator
// view: the first page renders into the bucket's own .view-nhl-<bucket>
// element, the rest into generated .view-nhl-<bucket>-2, -3, ... siblings.
// Phone layout is a scrolling single column by design, so it's never paged.
const _nhlPageCount = { today: 1, yesterday: 1 };
const _nhlPageCards = { today: [], yesterday: [] };

function setNhlPages(el, bucket, cards) {
  _nhlPageCards[bucket] = cards;
  el.parentElement.querySelectorAll(`[data-nhl-page-of="${bucket}"]`).forEach(p => p.remove());
  _nhlPageCount[bucket] = 1;
  if (!cards.length) return;

  // Render everything into the first page, measure each row (two cards) of
  // the full grid, then fill pages row by row until the next row wouldn't
  // fit the view's height.
  el.innerHTML = `<div class="games-grid">${cards.join("")}</div>`;
  if (PHONE_LAYOUT.matches || el.scrollHeight <= el.clientHeight) return;
  // Rects are in on-screen px but clientHeight isn't; convert to layout px.
  // The view's own rect/offsetHeight ratio covers both the page fit zoom and
  // any transform on the view itself (e.g. the "zoom" view transition, which
  // scales views that aren't showing).
  const viewRect = el.getBoundingClientRect();
  const scale = (el.offsetHeight && viewRect.height / el.offsetHeight) || fitZoom;
  const viewTop = viewRect.top / scale;
  const rects = [...el.querySelectorAll(".game")].map(c => {
    const r = c.getBoundingClientRect();
    return { top: r.top / scale, bottom: r.bottom / scale };
  });
  const pages = [];
  let pageTop = viewTop;
  for (let i = 0; i < cards.length; i += 2) {
    const rowTop = Math.min(...rects.slice(i, i + 2).map(r => r.top));
    const rowBottom = Math.max(...rects.slice(i, i + 2).map(r => r.bottom));
    const current = pages[pages.length - 1];
    if (!current || rowBottom - pageTop > el.clientHeight + 0.5) {
      pages.push(cards.slice(i, i + 2));
      pageTop = rowTop - (rects[0].top - viewTop);
    } else {
      current.push(...cards.slice(i, i + 2));
    }
  }
  el.innerHTML = `<div class="games-grid">${pages[0].join("")}</div>`;
  let prev = el;
  pages.slice(1).forEach((page, i) => {
    const name = `${bucket}-${i + 2}`;
    const pageEl = document.createElement("div");
    pageEl.className = `view view-nhl-${name}`;
    pageEl.dataset.nhlPageOf = bucket;
    pageEl.innerHTML = `<div class="games-grid">${page.join("")}</div>`;
    prev.after(pageEl);
    prev = pageEl;
    NHL_TITLES[name] = NHL_TITLES[bucket];
  });
  _nhlPageCount[bucket] = pages.length;
}

// Rotator views for the NHL panel, with today/yesterday expanded into their
// pages. Remembers the base list so a resize can re-page and re-apply it.
let _nhlBaseViews = ["today"];

function setNhlViews(baseViews) {
  _nhlBaseViews = baseViews;
  nhlRotator.setViews(baseViews.flatMap(v => {
    const n = _nhlPageCount[v] || 1;
    return [v, ...Array.from({ length: n - 1 }, (_, i) => `${v}-${i + 2}`)];
  }));
}

function repageNhl() {
  for (const bucket of ["today", "yesterday"]) {
    const el = document.querySelector(`#nhl .view-nhl-${bucket}`);
    if (el && _nhlPageCards[bucket].length) setNhlPages(el, bucket, _nhlPageCards[bucket]);
  }
  if (nhlRotator) setNhlViews(_nhlBaseViews);
}

let _nhlResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_nhlResizeTimer);
  _nhlResizeTimer = setTimeout(repageNhl, 200);
});

// Paging measures rendered card heights, so if the first NHL render beat the
// bundled Inter font it measured the fallback font. Re-page once Inter lands.
document.fonts.load('600 1em "Inter"').then(repageNhl, () => {});


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

  // renderGameDetails lives in game-details.js, loaded on the first open.
  function openDetails(game, originEl) {
    if (!game) return;
    loadScript("js/game-details.js").then(
      () => showDetails(game, originEl),
      e => console.error(e),
    );
  }

  function showDetails(game, originEl) {
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

const NHL_TITLES = { today: "NHL Scores", yesterday: "Yesterday", offseason: "Off-Season", weather: "Weather", clock: "", countdown: "", season: "Next Season" };
let nhlRotationMs = 10000;
let nhlRotator = null;
let nhlDeepOffSeason = false;
let nhlSeasonStart = null; // ISO "YYYY-MM-DD" of next season's first game, or null if unknown
// Last /api/nhl response as JSON; most polls return it unchanged, and then
// there's nothing to re-render. Cleared on error so recovery re-renders.
let _lastNhlPayload = null;

async function refreshNHL() {
  try {
    const data = await fetchJson("/api/nhl");
    if (data && data.error) {
      _lastNhlPayload = null;
      showError("nhl", data.error, ".view-nhl-today");
      return;
    }
    const payload = JSON.stringify(data);
    if (payload === _lastNhlPayload) {
      setUpdated("nhl");
      return;
    }
    _lastNhlPayload = payload;
    nhlSeasonStart = data.seasonStart || null;
    renderNHL(data.today?.games, "#nhl .view-nhl-today", "No games today.", "today");
    if (data.yesterday) {
      renderNHL(data.yesterday.games, "#nhl .view-nhl-yesterday", "No games yesterday.", "yesterday");
    }

    // Opening night: the season opener is today or tomorrow. Drop the
    // off-season countdown and show the real slate. On the eve `today` is
    // still empty, so the server hands us tomorrow's opening games to preview
    // here rather than sitting on "No games today".
    if (data.openingNight) {
      nhlDeepOffSeason = false;
      renderNHL(data.openingNight.games, "#nhl .view-nhl-today", "No games today.", "today");
      setNhlViews(["today"]);
      const t = document.getElementById("nhl-title-text");
      if (t) t.textContent = data.openingNight.isTomorrow ? "Opening Night — Tomorrow 🏒" : "Opening Night 🏒";
      setUpdated("nhl");
      return;
    }

    // Deep off-season: >7 days with no games — cycle weather/clock/countdown
    // in the NHL panel to keep the display useful.
    if (data.deepOffSeason) {
      nhlDeepOffSeason = true;
      const seasonKnown = daysUntilSeasonStart() !== null;
      const deepViews = [
        "weather",
        "clock",
        ...(countdowns.length ? ["countdown"] : []),
        ...(seasonKnown ? ["season"] : []),
      ];
      setNhlViews(deepViews);
      renderNhlWeather();
      renderNhlClock();
      renderNhlCountdown();
      renderNhlSeason();
      setUpdated("nhl");
      return;
    }
    nhlDeepOffSeason = false;

    // Off-season: when the server found recent games within the past 7 days
    // but today and yesterday are empty, alternate between the last game
    // scores and a Stanley Cup winner message (or generic off-season note).
    if (data.offSeason) {
      const offEl = document.querySelector("#nhl .view-nhl-offseason");
      if (offEl) {
        const cw = data.offSeason.cupWinner;
        const msg = cw
          ? `🏆 ${cw.team} win the Stanley Cup!`
          : "🏒 See you next season!";
        offEl.textContent = "";
        const p = document.createElement("p");
        p.className = "nhl-offseason-msg";
        p.textContent = msg;
        offEl.appendChild(p);
      }
      renderNHL(data.offSeason.games, "#nhl .view-nhl-today", "No games today.", "today");
      setNhlViews(["today", "offseason"]);
      setUpdated("nhl");
      return;
    }

    const yesterdayHasGames = Array.isArray(data.yesterday?.games) && data.yesterday.games.length > 0;
    const canRotate = !data.hasLiveToday && yesterdayHasGames;
    setNhlViews(canRotate ? ["today", "yesterday"] : ["today"]);
    setUpdated("nhl");
  } catch (e) {
    _lastNhlPayload = null;
    showError("nhl", e.message, ".view-nhl-today");
  }
}

// ---------- NHL deep off-season helpers ----------
// When the NHL has been idle for >7 days, the NHL panel cycles through
// weather / clock / countdown views using data from the same sources.

let _lastWeatherData = null; // cached by refreshWeather for NHL reuse

function renderNhlWeather() {
  const el = document.querySelector("#nhl .view-nhl-weather");
  if (!el) return;
  if (_lastWeatherData) renderWeatherView(el, _lastWeatherData);
  else el.textContent = "Weather loading…";
}

function renderNhlClock() {
  renderClockView(document.querySelector("#nhl .view-nhl-clock"));
}

// Default divider glyph when a countdown event has no icon of its own.
const COUNTDOWN_DEFAULT_ICON = "⏳";

function formatCountdown(c) {
  const icon = (c && c.icon) || COUNTDOWN_DEFAULT_ICON;
  if (!c) return { numberText: "", labelText: "No countdowns configured", icon };
  if (c.days === 0) return { numberText: "Today", labelText: `is ${c.title}`, icon };
  if (c.days > 0) return { numberText: `${c.days} ${c.days === 1 ? "day" : "days"}`, labelText: `until ${c.title}`, icon };
  return { numberText: c.title, labelText: "is past, what's next?", icon };
}

function renderNhlCountdown() {
  renderCountdownView(document.querySelector("#nhl .view-nhl-countdown"));
}

// Days from local today to the configured next-season start date. Returns null
// when no valid start date is configured or it's already in the past — in
// either case the "season" view is dropped from the rotation entirely.
function daysUntilSeasonStart() {
  if (!nhlSeasonStart) return null;
  const parts = nhlSeasonStart.split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [y, m, d] = parts;
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const targetUtc = Date.UTC(y, m - 1, d);
  const days = Math.round((targetUtc - todayUtc) / 86400000);
  return days >= 0 ? days : null;
}

// Live "Puck Drop" countdown: whole calendar days until the opener, plus the
// hours/mins/secs remaining in the current day (so the seconds tick and the
// day count rolls at local midnight). Returns false when there's no valid,
// future start date so callers can skip work.
function renderNhlSeason() {
  const view = document.querySelector("#nhl .view-nhl-season");
  if (!view) return false;
  const days = daysUntilSeasonStart();
  if (days === null) return false; // view isn't in the rotation; nothing to render

  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let rem = Math.max(0, Math.floor((nextMidnight - now) / 1000));
  const hrs = Math.floor(rem / 3600); rem -= hrs * 3600;
  const mins = Math.floor(rem / 60); const secs = rem - mins * 60;

  const set = (unit, val) => {
    const el = view.querySelector(`[data-unit="${unit}"]`);
    if (el) el.textContent = String(val).padStart(2, "0");
  };
  set("days", days);
  set("hrs", hrs);
  set("mins", mins);
  set("secs", secs);

  const seasonEl = view.querySelector(".puck-season");
  const startYear = parseInt(nhlSeasonStart.slice(0, 4), 10);
  if (seasonEl && !Number.isNaN(startYear)) {
    seasonEl.textContent = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  }
  return true;
}

// Drive the seconds display, but only while the season view is actually
// on-screen — no work during the rest of the rotation or in-season.
function tickNhlSeason() {
  if (!nhlSeasonStart) return;
  const view = document.querySelector("#nhl .view-nhl-season.active");
  if (view) renderNhlSeason();
}
