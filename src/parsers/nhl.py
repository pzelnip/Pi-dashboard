"""NHL schedule parser.

The NHL handler does *not* call /schedule/now upstream. That endpoint lags the
calendar rollover (still returns yesterday's slate hours into the user's
morning), so `fetch_nhl` always anchors on the Pi's local date and hits
/schedule/<YYYY-MM-DD> instead. If you "fix" this to use /schedule/now, you
will reintroduce a real bug.
"""

import datetime as dt
import json

from cache import fetch_cached

PERIOD_ORDINAL = {1: "1st", 2: "2nd", 3: "3rd", 4: "OT", 5: "2OT", 6: "3OT"}

# NHL gameType codes: 1 = preseason, 2 = regular, 3 = playoffs, 4 = all-star.
GAME_TYPE_LABEL = {1: "Preseason", 2: "Regular Season", 3: "Playoffs", 4: "All-Star"}

# NHL upstream returns each team's odds as a list of {providerId, value} entries
# from various sportsbooks. They tend to agree closely; the frontend just needs
# something readable, so we surface a single representative value (American
# moneyline format like "+142" / "-170" preferred when available, decimal
# otherwise). Provider IDs are not stable contracts — keep the parser tolerant.
def _pick_odds_value(odds: list[dict] | None) -> str:
    if not odds:
        return ""
    # Prefer American moneyline (starts with + or -); fall back to first entry.
    for o in odds:
        if (v := str(o.get("value", "")).strip()) and (v.startswith("+") or v.startswith("-")):
            return v
    first = str((odds[0] or {}).get("value", "")).strip()
    return first


def _status_text(game: dict) -> str:
    state = game.get("gameState", "")
    pd = game.get("periodDescriptor") or {}
    period_num = pd.get("number")
    period_type = pd.get("periodType", "REG")
    clock = game.get("clock") or {}
    time_remaining = clock.get("timeRemaining")
    in_intermission = clock.get("inIntermission", False)

    if state in ("OFF", "FINAL"):
        if period_type == "OT":
            return "Final/OT"
        if period_type == "SO":
            return "Final/SO"
        return "Final"

    if state in ("LIVE", "CRIT"):
        if period_num is None:
            return ""  # pre-game LIVE transition: let the frontend show start time
        ord_label = PERIOD_ORDINAL.get(period_num, f"P{period_num}")
        if in_intermission:
            return f"End of {ord_label}"
        if time_remaining:
            return f"{ord_label} · {time_remaining}"
        return ord_label

    return ""  # scheduled / pre-game: frontend will show start time instead


def _team(t: dict, favorites: set[str] | None = None) -> dict:
    abbrev = t.get("abbrev", "")
    common_name = (t.get("commonName") or {}).get("default", "")
    place_name = (t.get("placeName") or {}).get("default", "")
    # Full name for the details panel: "Tampa Bay Lightning" rather than just
    # "Lightning". Falls back gracefully when placeName is missing.
    full_name = f"{place_name} {common_name}".strip() if place_name else common_name
    return {
        "abbrev": abbrev,
        "name": common_name,
        "placeName": place_name,
        "fullName": full_name,
        "score": t.get("score"),
        "logo": t.get("logo", ""),
        "isFavorite": bool(favorites) and abbrev in favorites,
        "odds": _pick_odds_value(t.get("odds")),
    }


def _playoff_round(game: dict) -> int | None:
    # NHL API uses gameType=3 for playoff games (regular season is 2). The
    # round number lives on seriesStatus.round (1-4: R1, R2, Conf Final, Cup
    # Final). Return None for anything that isn't a playoff game so the
    # frontend can omit the badge.
    if game.get("gameType") != 3:
        return None
    if isinstance(series := game.get("seriesStatus"), dict) and isinstance(series.get("round"), int):
        return series["round"]
    return None


def _series_text(s: dict | None) -> str:
    if not s:
        return ""
    top = s.get("topSeedTeamAbbrev")
    top_w = s.get("topSeedWins", 0)
    bot = s.get("bottomSeedTeamAbbrev")
    bot_w = s.get("bottomSeedWins", 0)
    needed = s.get("neededToWin", 4)
    game_num = s.get("gameNumberOfSeries", "?")
    if top_w == 0 and bot_w == 0:
        return f"Game {game_num}"
    if top_w >= needed:
        return f"Game {game_num} ({top} won {top_w}-{bot_w}) ✅"
    if bot_w >= needed:
        return f"Game {game_num} ({bot} won {bot_w}-{top_w}) ✅"
    if top_w > bot_w:
        return f"Game {game_num} ({top} leads {top_w}-{bot_w})"
    if bot_w > top_w:
        return f"Game {game_num} ({bot} leads {bot_w}-{top_w})"
    return f"Game {game_num} (tied {top_w}-{bot_w})"


# Map (network, country) -> homepage URL for the network's hockey coverage.
# Keyed on the tuple (not just network name) so unrelated same-named networks
# in different countries don't collide. Networks not in this map render as
# plain text in the modal (the frontend branches on `url` being None).
_BROADCAST_URLS: dict[tuple[str, str], str] = {
    ("ESPN", "US"): "https://www.espn.com/nhl/",
    ("TNT", "US"): "https://www.tntdrama.com/nhl",
    ("truTV", "US"): "https://www.trutv.com/",
    ("MAX", "US"): "https://www.max.com/",
    ("CBC", "CA"): "https://www.cbc.ca/sports/hockey",
    ("SN", "CA"): "https://www.sportsnet.ca/hockey/nhl/",
    ("TVAS", "CA"): "https://www.tvasports.ca/",
    ("CITY", "CA"): "https://www.citytv.com/",
}


def _broadcasts(game: dict) -> list[dict]:
    """Distill tvBroadcasts to {network, country, market, url} entries.

    The upstream list often contains sequence/id internals that aren't useful
    to the kiosk viewer; we keep only the human-meaningful fields and dedupe
    on (network, country) so the panel doesn't show "TNT" three times. Each
    entry gets a `url` looked up from `_BROADCAST_URLS`; networks we don't
    know about get `None` so the frontend can fall back to plain text.
    """
    raw = game.get("tvBroadcasts") or []
    out = []
    seen = set()
    for b in raw:
        network = (b.get("network") or "").strip()
        if not network:
            continue
        country = (b.get("countryCode") or "").strip()
        key = (network, country)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "network": network,
            "country": country,
            "market": b.get("market", ""),
            "url": _BROADCAST_URLS.get(key),
        })
    return out


def _series_info(s: dict | None) -> dict | None:
    """Shape the seriesStatus block for the details panel.

    Regular-season games have no seriesStatus — return None then. For playoff
    games we surface the round number/title plus the running win counts so
    the frontend can render "1st Round — Game 7, tied 3-3" or similar.
    """
    if not s:
        return None
    return {
        "round": s.get("round"),
        "title": s.get("seriesTitle", ""),
        "abbrev": s.get("seriesAbbrev", ""),
        "letter": s.get("seriesLetter", ""),
        "neededToWin": s.get("neededToWin", 4),
        "topSeedAbbrev": s.get("topSeedTeamAbbrev", ""),
        "topSeedWins": s.get("topSeedWins", 0),
        "bottomSeedAbbrev": s.get("bottomSeedTeamAbbrev", ""),
        "bottomSeedWins": s.get("bottomSeedWins", 0),
    }


def _absolute_nhl_url(path: str) -> str:
    """NHL upstream returns several link fields as site-relative paths
    (e.g. "/gamecenter/...") rather than absolute URLs. Make them clickable
    by rooting them at nhl.com. Already-absolute URLs are passed through.
    """
    if not path:
        return ""
    if path.startswith("http://") or path.startswith("https://"):
        return path
    if path.startswith("/"):
        return f"https://www.nhl.com{path}"
    return path


def fetch_nhl(date: str | None, favorites: list[str]) -> list[dict]:
    # Use the Pi's local date when no explicit date is passed. The NHL API's
    # /schedule/now endpoint lags the calendar rollover, so we anchor on the
    # server clock instead.
    target_date = date or dt.date.today().isoformat()
    url = f"https://api-web.nhle.com/v1/schedule/{target_date}"
    # 20s TTL is shorter than the client's 30s poll so live-game state changes
    # (period clock, score) reach the kiosk on every poll without re-fetching.
    raw = fetch_cached(url, ttl_seconds=20)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("upstream returned non-JSON response (got HTML?)")
    weeks = data.get("gameWeek", [])

    fav_set = set(favorites or [])
    games_out = []
    for week in weeks:
        if week.get("date") != target_date:
            continue
        for game in week.get("games", []):
            home = game.get("homeTeam", {})
            away = game.get("awayTeam", {})
            is_fav = bool(fav_set) and (
                home.get("abbrev") in fav_set or away.get("abbrev") in fav_set
            )
            game_type = game.get("gameType")
            venue = (game.get("venue") or {}).get("default", "")
            games_out.append(
                {
                    "id": game.get("id"),
                    "home": _team(home, fav_set),
                    "away": _team(away, fav_set),
                    "state": game.get("gameState", ""),
                    "startTime": game.get("startTimeUTC", ""),
                    "statusText": _status_text(game),
                    "seriesText": _series_text(game.get("seriesStatus")),
                    "playoffRound": _playoff_round(game),
                    "isFavorite": is_fav,
                    "venue": venue,
                    "venueTimezone": game.get("venueTimezone", ""),
                    "neutralSite": bool(game.get("neutralSite", False)),
                    "gameType": game_type,
                    "gameTypeLabel": GAME_TYPE_LABEL.get(game_type, ""),
                    "broadcasts": _broadcasts(game),
                    "series": _series_info(game.get("seriesStatus")),
                    "seriesUrl": _absolute_nhl_url(game.get("seriesUrl", "")),
                    "gameCenterLink": _absolute_nhl_url(game.get("gameCenterLink", "")),
                }
            )
    return games_out
