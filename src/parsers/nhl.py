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
    return {
        "abbrev": abbrev,
        "name": (t.get("commonName") or {}).get("default", ""),
        "score": t.get("score"),
        "logo": t.get("logo", ""),
        "isFavorite": bool(favorites) and abbrev in favorites,
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
            games_out.append(
                {
                    "home": _team(home, fav_set),
                    "away": _team(away, fav_set),
                    "state": game.get("gameState", ""),
                    "startTime": game.get("startTimeUTC", ""),
                    "statusText": _status_text(game),
                    "seriesText": _series_text(game.get("seriesStatus")),
                    "playoffRound": _playoff_round(game),
                    "isFavorite": is_fav,
                }
            )
    return games_out
