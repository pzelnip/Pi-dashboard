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


if __name__ == "__main__":
    unittest.main()
