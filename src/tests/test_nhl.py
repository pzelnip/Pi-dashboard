"""Tests for NHL parser: status text, team shaping, series text, fetch_nhl envelope."""

import unittest
from unittest.mock import patch

from tests._helpers import fixture_bytes

from parsers import nhl


class StatusTextTests(unittest.TestCase):
    def test_final_regulation(self):
        game = {"gameState": "FINAL", "periodDescriptor": {"number": 3, "periodType": "REG"}}

        result = nhl._status_text(game)

        self.assertEqual(result, "Final")

    def test_final_overtime(self):
        game = {"gameState": "OFF", "periodDescriptor": {"number": 4, "periodType": "OT"}}

        result = nhl._status_text(game)

        self.assertEqual(result, "Final/OT")

    def test_final_shootout(self):
        game = {"gameState": "FINAL", "periodDescriptor": {"number": 5, "periodType": "SO"}}

        result = nhl._status_text(game)

        self.assertEqual(result, "Final/SO")

    def test_live_with_clock(self):
        game = {
            "gameState": "LIVE",
            "periodDescriptor": {"number": 2, "periodType": "REG"},
            "clock": {"timeRemaining": "08:32", "inIntermission": False},
        }

        result = nhl._status_text(game)

        self.assertEqual(result, "2nd · 08:32")

    def test_live_in_intermission(self):
        game = {
            "gameState": "LIVE",
            "periodDescriptor": {"number": 1, "periodType": "REG"},
            "clock": {"inIntermission": True},
        }

        result = nhl._status_text(game)

        self.assertEqual(result, "End of 1st")

    def test_live_overtime_period_label(self):
        game = {
            "gameState": "CRIT",
            "periodDescriptor": {"number": 4, "periodType": "OT"},
            "clock": {"timeRemaining": "03:11", "inIntermission": False},
        }

        result = nhl._status_text(game)

        self.assertEqual(result, "OT · 03:11")

    def test_live_unknown_period_falls_back(self):
        game = {
            "gameState": "LIVE",
            "periodDescriptor": {"number": 9, "periodType": "REG"},
            "clock": {"timeRemaining": "10:00", "inIntermission": False},
        }

        result = nhl._status_text(game)

        self.assertEqual(result, "P9 · 10:00")

    def test_live_without_period_returns_empty(self):
        game = {"gameState": "LIVE", "periodDescriptor": {}}

        result = nhl._status_text(game)

        self.assertEqual(result, "")

    def test_scheduled_returns_empty(self):
        game = {"gameState": "FUT", "periodDescriptor": {}}

        result = nhl._status_text(game)

        self.assertEqual(result, "")


class TeamShapingTests(unittest.TestCase):
    def test_team_marks_favorite(self):
        team = {
            "abbrev": "EDM",
            "commonName": {"default": "Oilers"},
            "score": 3,
            "logo": "https://example.com/edm.svg",
        }

        result = nhl._team(team, favorites={"EDM", "VAN"})

        self.assertEqual(result["abbrev"], "EDM")
        self.assertEqual(result["name"], "Oilers")
        self.assertEqual(result["score"], 3)
        self.assertEqual(result["logo"], "https://example.com/edm.svg")
        self.assertTrue(result["isFavorite"])

    def test_team_no_favorites(self):
        team = {"abbrev": "BOS", "commonName": {"default": "Bruins"}, "score": 1}

        result = nhl._team(team, favorites=None)

        self.assertFalse(result["isFavorite"])

    def test_team_empty_favorites_set(self):
        team = {"abbrev": "BOS", "commonName": {"default": "Bruins"}, "score": 1}

        result = nhl._team(team, favorites=set())

        self.assertFalse(result["isFavorite"])

    def test_team_missing_logo_defaults_to_empty(self):
        team = {"abbrev": "BOS", "commonName": {"default": "Bruins"}, "score": 0}

        result = nhl._team(team, favorites=set())

        self.assertEqual(result["logo"], "")

    def test_team_full_name_combines_place_and_common(self):
        team = {
            "abbrev": "TBL",
            "commonName": {"default": "Lightning"},
            "placeName": {"default": "Tampa Bay"},
            "score": 2,
        }

        result = nhl._team(team, favorites=set())

        self.assertEqual(result["fullName"], "Tampa Bay Lightning")
        self.assertEqual(result["placeName"], "Tampa Bay")

    def test_team_full_name_falls_back_to_common_when_no_place(self):
        team = {"abbrev": "BOS", "commonName": {"default": "Bruins"}, "score": 0}

        result = nhl._team(team, favorites=set())

        self.assertEqual(result["fullName"], "Bruins")
        self.assertEqual(result["placeName"], "")

    def test_team_picks_american_moneyline_odds(self):
        team = {
            "abbrev": "EDM",
            "commonName": {"default": "Oilers"},
            "score": 0,
            "odds": [
                {"providerId": 6, "value": "1.67"},
                {"providerId": 8, "value": "-170"},
            ],
        }

        result = nhl._team(team, favorites=set())

        self.assertEqual(result["odds"], "-170")

    def test_team_falls_back_to_first_odds_when_no_moneyline(self):
        team = {
            "abbrev": "EDM",
            "commonName": {"default": "Oilers"},
            "score": 0,
            "odds": [{"providerId": 6, "value": "1.67"}],
        }

        result = nhl._team(team, favorites=set())

        self.assertEqual(result["odds"], "1.67")

    def test_team_missing_odds_yields_empty_string(self):
        team = {"abbrev": "BOS", "commonName": {"default": "Bruins"}, "score": 0}

        result = nhl._team(team, favorites=set())

        self.assertEqual(result["odds"], "")


class SeriesTextTests(unittest.TestCase):
    def test_no_series(self):
        self.assertEqual(nhl._series_text(None), "")
        self.assertEqual(nhl._series_text({}), "")

    def test_series_first_game(self):
        s = {
            "topSeedTeamAbbrev": "EDM",
            "topSeedWins": 0,
            "bottomSeedTeamAbbrev": "VAN",
            "bottomSeedWins": 0,
            "neededToWin": 4,
            "gameNumberOfSeries": 1,
        }

        self.assertEqual(nhl._series_text(s), "Game 1")

    def test_series_top_leads(self):
        s = {
            "topSeedTeamAbbrev": "EDM",
            "topSeedWins": 2,
            "bottomSeedTeamAbbrev": "VAN",
            "bottomSeedWins": 1,
            "neededToWin": 4,
            "gameNumberOfSeries": 4,
        }

        self.assertEqual(nhl._series_text(s), "Game 4 (EDM leads 2-1)")

    def test_series_bottom_leads(self):
        s = {
            "topSeedTeamAbbrev": "EDM",
            "topSeedWins": 1,
            "bottomSeedTeamAbbrev": "VAN",
            "bottomSeedWins": 3,
            "neededToWin": 4,
            "gameNumberOfSeries": 5,
        }

        self.assertEqual(nhl._series_text(s), "Game 5 (VAN leads 3-1)")

    def test_series_tied(self):
        s = {
            "topSeedTeamAbbrev": "EDM",
            "topSeedWins": 2,
            "bottomSeedTeamAbbrev": "VAN",
            "bottomSeedWins": 2,
            "neededToWin": 4,
            "gameNumberOfSeries": 5,
        }

        self.assertEqual(nhl._series_text(s), "Game 5 (tied 2-2)")

    def test_series_top_won(self):
        s = {
            "topSeedTeamAbbrev": "EDM",
            "topSeedWins": 4,
            "bottomSeedTeamAbbrev": "VAN",
            "bottomSeedWins": 1,
            "neededToWin": 4,
            "gameNumberOfSeries": 5,
        }

        result = nhl._series_text(s)

        self.assertIn("EDM won 4-1", result)
        self.assertTrue(result.startswith("Game 5"))

    def test_series_bottom_won(self):
        s = {
            "topSeedTeamAbbrev": "EDM",
            "topSeedWins": 2,
            "bottomSeedTeamAbbrev": "VAN",
            "bottomSeedWins": 4,
            "neededToWin": 4,
            "gameNumberOfSeries": 6,
        }

        result = nhl._series_text(s)

        self.assertIn("VAN won 4-2", result)


class BroadcastsTests(unittest.TestCase):
    def test_empty_when_missing(self):
        result = nhl._broadcasts({})

        self.assertEqual(result, [])

    def test_filters_blank_networks_and_dedupes(self):
        game = {
            "tvBroadcasts": [
                {"network": "TNT", "countryCode": "US", "market": "N", "sequenceNumber": 1},
                {"network": "", "countryCode": "US", "market": "N"},
                {"network": "CBC", "countryCode": "CA", "market": "N", "sequenceNumber": 2},
                {"network": "CBC", "countryCode": "CA", "market": "N", "sequenceNumber": 3},
            ],
        }

        result = nhl._broadcasts(game)

        self.assertEqual(
            result,
            [
                {"network": "TNT", "country": "US", "market": "N"},
                {"network": "CBC", "country": "CA", "market": "N"},
            ],
        )


class SeriesInfoTests(unittest.TestCase):
    def test_returns_none_when_no_series(self):
        self.assertIsNone(nhl._series_info(None))
        self.assertIsNone(nhl._series_info({}))

    def test_shapes_playoff_series(self):
        s = {
            "round": 2,
            "seriesTitle": "2nd Round",
            "seriesAbbrev": "R2",
            "seriesLetter": "E",
            "topSeedTeamAbbrev": "EDM",
            "topSeedWins": 2,
            "bottomSeedTeamAbbrev": "VAN",
            "bottomSeedWins": 1,
            "neededToWin": 4,
            "gameNumberOfSeries": 4,
        }

        result = nhl._series_info(s)

        self.assertEqual(result["round"], 2)
        self.assertEqual(result["title"], "2nd Round")
        self.assertEqual(result["topSeedAbbrev"], "EDM")
        self.assertEqual(result["topSeedWins"], 2)
        self.assertEqual(result["bottomSeedAbbrev"], "VAN")
        self.assertEqual(result["bottomSeedWins"], 1)
        self.assertEqual(result["gameNumber"], 4)


class AbsoluteUrlTests(unittest.TestCase):
    def test_passes_through_absolute_url(self):
        self.assertEqual(
            nhl._absolute_nhl_url("https://example.com/x"),
            "https://example.com/x",
        )

    def test_roots_relative_path_at_nhle(self):
        self.assertEqual(
            nhl._absolute_nhl_url("/gamecenter/foo"),
            "https://www.nhle.com/gamecenter/foo",
        )

    def test_empty_in_yields_empty_out(self):
        self.assertEqual(nhl._absolute_nhl_url(""), "")


class FetchNhlTests(unittest.TestCase):
    def setUp(self):
        self._raw = fixture_bytes("nhl_schedule.json")

    def _patched_fetch(self, *args, **kwargs):
        return self._raw

    def test_fetch_nhl_returns_only_target_date(self):
        with patch.object(nhl, "fetch_cached", side_effect=self._patched_fetch):
            games = nhl.fetch_nhl("2026-04-21", favorites=["EDM"])

        # Fixture has 3 games on 2026-04-21 and 1 on 2026-04-22.
        self.assertEqual(len(games), 3)
        self.assertEqual({g["away"]["abbrev"] for g in games}, {"VAN", "MTL", "SJS"})

    def test_fetch_nhl_marks_favorite_at_game_level(self):
        with patch.object(nhl, "fetch_cached", side_effect=self._patched_fetch):
            games = nhl.fetch_nhl("2026-04-21", favorites=["EDM"])

        edm_game = next(g for g in games if g["home"]["abbrev"] == "EDM")
        non_fav_game = next(g for g in games if g["home"]["abbrev"] == "LAK")
        self.assertTrue(edm_game["isFavorite"])
        self.assertTrue(edm_game["home"]["isFavorite"])
        self.assertFalse(edm_game["away"]["isFavorite"])
        self.assertFalse(non_fav_game["isFavorite"])

    def test_fetch_nhl_includes_status_and_series_text(self):
        with patch.object(nhl, "fetch_cached", side_effect=self._patched_fetch):
            games = nhl.fetch_nhl("2026-04-21", favorites=[])

        live = next(g for g in games if g["state"] == "LIVE")
        final_ot = next(g for g in games if g["state"] == "FINAL")
        self.assertEqual(live["statusText"], "2nd · 08:32")
        self.assertEqual(live["seriesText"], "Game 4 (EDM leads 2-1)")
        self.assertEqual(final_ot["statusText"], "Final/OT")
        self.assertEqual(final_ot["seriesText"], "")

    def test_fetch_nhl_empty_when_no_matching_date(self):
        with patch.object(nhl, "fetch_cached", side_effect=self._patched_fetch):
            games = nhl.fetch_nhl("2025-01-01", favorites=[])

        self.assertEqual(games, [])

    def test_fetch_nhl_raises_on_html_response(self):
        with patch.object(nhl, "fetch_cached", return_value=b"<html>oops</html>"):
            with self.assertRaises(ValueError):
                nhl.fetch_nhl("2026-04-21", favorites=[])

    def test_fetch_nhl_exposes_details_for_playoff_game(self):
        with patch.object(nhl, "fetch_cached", side_effect=self._patched_fetch):
            games = nhl.fetch_nhl("2026-04-21", favorites=[])

        edm = next(g for g in games if g["home"]["abbrev"] == "EDM")
        self.assertEqual(edm["id"], 1)
        self.assertEqual(edm["venue"], "Rogers Place")
        self.assertEqual(edm["venueTimezone"], "America/Edmonton")
        self.assertFalse(edm["neutralSite"])
        self.assertEqual(edm["gameType"], 3)
        self.assertEqual(edm["gameTypeLabel"], "Playoffs")
        self.assertEqual(edm["home"]["fullName"], "Edmonton Oilers")
        self.assertEqual(edm["away"]["fullName"], "Vancouver Canucks")
        self.assertEqual(edm["home"]["odds"], "-170")
        self.assertEqual(edm["away"]["odds"], "+142")
        self.assertEqual(
            edm["broadcasts"],
            [
                {"network": "TNT", "country": "US", "market": "N"},
                {"network": "CBC", "country": "CA", "market": "N"},
            ],
        )
        self.assertEqual(edm["series"]["round"], 2)
        self.assertEqual(edm["series"]["title"], "2nd Round")
        self.assertEqual(edm["series"]["gameNumber"], 4)
        self.assertEqual(
            edm["seriesUrl"],
            "https://www.nhle.com/schedule/playoff-series/2026/series-e/oilers-vs-canucks",
        )
        self.assertEqual(
            edm["gameCenterLink"],
            "https://www.nhle.com/gamecenter/van-vs-edm/2026/04/21/1",
        )
        self.assertEqual(edm["ticketsLink"], "https://www.ticketmaster.com/event/1")

    def test_fetch_nhl_omits_optional_fields_for_regular_season(self):
        with patch.object(nhl, "fetch_cached", side_effect=self._patched_fetch):
            games = nhl.fetch_nhl("2026-04-21", favorites=[])

        tor = next(g for g in games if g["home"]["abbrev"] == "TOR")
        self.assertEqual(tor["venue"], "")
        self.assertEqual(tor["broadcasts"], [])
        self.assertIsNone(tor["series"])
        self.assertEqual(tor["seriesUrl"], "")
        self.assertEqual(tor["gameCenterLink"], "")
        self.assertEqual(tor["ticketsLink"], "")
        self.assertEqual(tor["home"]["odds"], "")
        self.assertEqual(tor["home"]["fullName"], "Maple Leafs")
        self.assertEqual(tor["gameType"], 2)
        self.assertEqual(tor["gameTypeLabel"], "Regular Season")


if __name__ == "__main__":
    unittest.main()
