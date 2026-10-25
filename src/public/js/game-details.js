// NHL game details modal contents. Loaded on first open by setupGameDetails
// (nhl.js), so the kiosk never parses it.

// ---------- NHL game details modal ----------

// Convert a 2-letter ISO country code to a flag emoji using Unicode regional
// indicator symbols. Each ASCII A-Z maps to U+1F1E6..U+1F1FF; a 2-char code
// "XY" becomes the two regional-indicator codepoints, which most platforms
// render as a single flag glyph. Pure function, no static map needed.
function countryFlag(code) {
  if (typeof code !== "string" || code.length !== 2) return "";
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return "";
  const A = 0x1F1E6;
  return String.fromCodePoint(A + upper.charCodeAt(0) - 65, A + upper.charCodeAt(1) - 65);
}

const GD_ROUND_LABELS = {
  1: "Round 1",
  2: "Round 2",
  3: "Conference Final",
  4: "Stanley Cup Final",
};

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
  const isScheduled = g.state === "FUT";
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
    const name = el("span", "gd-team-name");
    if (t.isFavorite) {
      const star = el("span", "fav-star", "★");
      star.setAttribute("aria-label", "Favorite team");
      name.appendChild(star);
      name.appendChild(textNode(" "));
    }
    name.appendChild(textNode(t.fullName || t.name || t.abbrev || ""));
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
    // .status-pill classes from style.css. Pre-game gets its own amber
    // pill plus the start time so puck-drop is still visible alongside
    // the pre-game label.
    if (isLive) {
      stack.appendChild(el("span", "status-pill live gd-state-pill", g.statusText || "LIVE"));
    } else if (isFinal) {
      stack.appendChild(el("span", "status-pill final gd-state-pill", g.statusText || "Final"));
    } else if (isPregame) {
      stack.appendChild(el("span", "status-pill pregame gd-state-pill", "Pre-game"));
      if (startLabel) {
        stack.appendChild(el("span", "status-pill scheduled gd-state-pill", startLabel));
      }
    } else if (isScheduled) {
      stack.appendChild(el("span", "status-pill scheduled gd-state-pill", startLabel || "Scheduled"));
    }
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

    // Leader text first (most prominent — who's winning the series)
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

    // Context line (round · game · best of)
    const labelWrap = el("div", "gd-series-label");
    const parts = [roundLabel];
    if (gameNum) parts.push(`Game ${gameNum}`);
    parts.push(`Best of ${totalDots}`);
    labelWrap.appendChild(textNode(parts.join(" · ")));
    seriesWrap.appendChild(labelWrap);

    // Numbered progress pills with four states:
    // - Filled: completed games (index < current game number)
    // - Current: the current game (outlined highlight)
    // - Current (live): current game while in progress (pulsing glow)
    // - Future: games not yet played (faint outline)
    const dotsWrap = el("div", "gd-series-dots", null);
    dotsWrap.setAttribute("role", "img");
    dotsWrap.setAttribute(
      "aria-label",
      gameNum ? `Game ${gameNum} of ${totalDots}` : `Best of ${totalDots}`
    );
    for (let i = 1; i <= totalDots; i++) {
      const isFilled = gameNum > 0 && i < gameNum;
      const isCurrent = i === gameNum;
      const cls = [
        "gd-series-pill",
        isFilled ? "is-filled" : "",
        isCurrent ? "is-current" : "",
        isCurrent && isLive ? "is-live" : "",
      ].filter(Boolean).join(" ");
      dotsWrap.appendChild(el("span", cls, String(i)));
    }
    seriesWrap.appendChild(dotsWrap);

    frag.appendChild(seriesWrap);
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

  // ---- Venue row (with map marker) ----
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
  // when the server provides a URL, plain span otherwise. Country is
  // rendered as a flag emoji (via `countryFlag`) when the code is a
  // recognizable ISO alpha-2; falls back to the raw country text otherwise.
  // The original country code is preserved on each broadcast's `aria-label`
  // since flag-emoji accessibility varies between AT/platforms.
  let broadcastsRow = null;
  const broadcasts = g.broadcasts || [];
  if (broadcasts.length) {
    broadcastsRow = el("div", "gd-broadcasts-row");
    const tvIcon = el("span", "gd-broadcast-icon", "📺");
    tvIcon.setAttribute("aria-hidden", "true");
    broadcastsRow.appendChild(tvIcon);
    broadcasts.forEach((b, i) => {
      if (i > 0) broadcastsRow.appendChild(el("span", "gd-meta-sep", "·"));
      const network = b.network || "";
      let node;
      if (b.url) {
        node = document.createElement("a");
        node.className = "gd-broadcast";
        node.href = b.url;
        node.target = "_blank";
        node.rel = "noopener noreferrer";
        node.textContent = network;
      } else {
        node = el("span", "gd-broadcast", network);
      }
      const country = b.country || "";
      const flag = countryFlag(country);
      if (flag) {
        node.appendChild(textNode(" "));
        node.appendChild(el("span", "gd-country", flag));
      } else if (country) {
        // Unknown / non-ISO code — fall back to the raw text so info isn't lost.
        node.appendChild(textNode(" "));
        node.appendChild(el("span", "gd-country", country));
      }
      // Preserve the country code for screen readers since flag-emoji a11y
      // varies between AT/platforms. Sighted users see network + flag.
      if (country) {
        const label = network ? `${network}, ${country}` : country;
        node.setAttribute("aria-label", label);
      }
      broadcastsRow.appendChild(node);
    });
    frag.appendChild(broadcastsRow);
  }

  // ---- Start time + game type, combined on a single centered line ----
  // Placed after venue + broadcasts so the flow matches the mockup:
  // series → venue → broadcasts → start/type → CTAs.
  // Only shows the start time as a dedicated entry when not scheduled or
  // pre-game (the scheduled / pre-game pill in the header already shows it).
  const showStart = startLabel && !isScheduled && !isPregame;
  if (showStart || g.gameTypeLabel) {
    const metaRow = el("div", "gd-meta-row");
    if (showStart) {
      const startSpan = el("span", "gd-meta-item");
      const clockIcon = el("span", "gd-meta-icon", "⏱");
      clockIcon.setAttribute("aria-hidden", "true");
      startSpan.appendChild(clockIcon);
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
