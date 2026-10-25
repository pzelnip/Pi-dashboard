"""Tests for NHL parser: status text, team shaping, series text, fetch_nhl envelope."""

import datetime as dt
import json
import unittest
from unittest.mock import patch

from tests.helpers import fixture_bytes

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


class PlayoffRoundTests(unittest.TestCase):
    def test_regular_season_returns_none(self):
        game = {"gameType": 2, "seriesStatus": {"round": 1}}

        result = nhl._playoff_round(game)

        self.assertIsNone(result)

    def test_playoff_returns_round_number(self):
        game = {"gameType": 3, "seriesStatus": {"round": 3}}

        result = nhl._playoff_round(game)

        self.assertEqual(result, 3)

    def test_playoff_missing_series_returns_none(self):
        game = {"gameType": 3}

        result = nhl._playoff_round(game)

        self.assertIsNone(result)

    def test_playoff_missing_round_field_returns_none(self):
        game = {"gameType": 3, "seriesStatus": {"topSeedWins": 1}}

        result = nhl._playoff_round(game)

        self.assertIsNone(result)

    def test_playoff_non_int_round_returns_none(self):
        string_round = {"gameType": 3, "seriesStatus": {"round": "2"}}
        float_round = {"gameType": 3, "seriesStatus": {"round": 2.0}}

        string_result = nhl._playoff_round(string_round)
        float_result = nhl._playoff_round(float_round)

        self.assertIsNone(string_result)
        self.assertIsNone(float_result)

    def test_playoff_non_dict_series_returns_none(self):
        list_series = {"gameType": 3, "seriesStatus": [1, 2]}
        string_series = {"gameType": 3, "seriesStatus": "round 2"}

        list_result = nhl._playoff_round(list_series)
        string_result = nhl._playoff_round(string_series)

        self.assertIsNone(list_result)
        self.assertIsNone(string_result)

    def test_missing_game_type_returns_none(self):
        game = {"seriesStatus": {"round": 2}}

        result = nhl._playoff_round(game)

        self.assertIsNone(result)


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
                {
                    "network": "TNT",
                    "country": "US",
                    "market": "N",
                    "url": "https://www.tntdrama.com/nhl",
                },
                {
                    "network": "CBC",
                    "country": "CA",
                    "market": "N",
                    "url": "https://www.cbc.ca/sports/hockey",
                },
            ],
        )

    def test_known_network_gets_homepage_url(self):
        game = {"tvBroadcasts": [{"network": "ESPN", "countryCode": "US", "market": "N"}]}

        result = nhl._broadcasts(game)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["network"], "ESPN")
        self.assertEqual(result[0]["url"], "https://www.espn.com/nhl/")

    def test_unknown_network_has_none_url(self):
        game = {"tvBroadcasts": [{"network": "OBSCURE", "countryCode": "US", "market": "N"}]}

        result = nhl._broadcasts(game)

        self.assertEqual(len(result), 1)
        self.assertIsNone(result[0]["url"])

    def test_same_name_network_in_unmapped_country_resolves_to_no_url(self):
        # SN is mapped only as ("SN", "CA") (Sportsnet). A US-broadcast "SN"
        # entry must NOT inherit the Canadian URL — verifies tuple-keying.
        game = {"tvBroadcasts": [{"network": "SN", "countryCode": "US", "market": "N"}]}

        result = nhl._broadcasts(game)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["network"], "SN")
        self.assertEqual(result[0]["country"], "US")
        self.assertIsNone(result[0]["url"])

    def test_sn360_resolves_to_sportsnet_url(self):
        # SN360 is a Sportsnet sub-channel; it should link to the same
        # landing page as the parent SN entry.
        game = {"tvBroadcasts": [{"network": "SN360", "countryCode": "CA", "market": "N"}]}

        result = nhl._broadcasts(game)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["network"], "SN360")
        self.assertEqual(result[0]["url"], "https://www.sportsnet.ca/hockey/nhl/")


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
        self.assertEqual(result["gameNumber"], 4)
        self.assertEqual(result["topSeedAbbrev"], "EDM")
        self.assertEqual(result["topSeedWins"], 2)
        self.assertEqual(result["bottomSeedAbbrev"], "VAN")
        self.assertEqual(result["bottomSeedWins"], 1)

    def test_game_number_falls_back_to_none_when_missing(self):
        s = {
            "round": 1,
            "seriesTitle": "1st Round",
            "seriesAbbrev": "R1",
            "seriesLetter": "A",
            "topSeedTeamAbbrev": "EDM",
            "topSeedWins": 0,
            "bottomSeedTeamAbbrev": "VAN",
            "bottomSeedWins": 0,
            "neededToWin": 4,
        }

        result = nhl._series_info(s)

        self.assertIsNone(result["gameNumber"])


class VenueUrlTests(unittest.TestCase):
    def test_known_venue_resolves_to_wikipedia(self):
        venue = "T-Mobile Arena"

        result = nhl._venue_url(venue)

        self.assertEqual(result, "https://en.wikipedia.org/wiki/T-Mobile_Arena")

    def test_renamed_venue_old_name_resolves_to_same_wikipedia_page(self):
        new_name_url = nhl._venue_url("Xfinity Mobile Arena")
        old_name_url = nhl._venue_url("Wells Fargo Center")

        self.assertEqual(new_name_url, old_name_url)
        self.assertEqual(new_name_url, "https://en.wikipedia.org/wiki/Xfinity_Mobile_Arena")

    def test_unknown_venue_falls_back_to_google_search(self):
        venue = "Some Obscure Stadium & Arena"

        result = nhl._venue_url(venue)

        # quote_plus encodes spaces as '+' and special chars as percent-escapes.
        self.assertEqual(
            result,
            "https://www.google.com/search?q=Some+Obscure+Stadium+%26+Arena",
        )

    def test_empty_venue_returns_none(self):
        self.assertIsNone(nhl._venue_url(""))
        self.assertIsNone(nhl._venue_url(None))


class AbsoluteUrlTests(unittest.TestCase):
    def test_passes_through_absolute_url(self):
        self.assertEqual(
            nhl._absolute_nhl_url("https://example.com/x"),
            "https://example.com/x",
        )

    def test_roots_relative_path_at_nhl(self):
        self.assertEqual(
            nhl._absolute_nhl_url("/gamecenter/foo"),
            "https://www.nhl.com/gamecenter/foo",
        )

    def test_empty_in_yields_empty_out(self):
        self.assertEqual(nhl._absolute_nhl_url(""), "")


class OutcomeTests(unittest.TestCase):
    def test_regulation_final(self):
        game = {"gameState": "FINAL", "gameOutcome": {"lastPeriodType": "REG"}}

        result = nhl._outcome(game)

        self.assertEqual(result, "REG")

    def test_overtime_final(self):
        game = {"gameState": "OFF", "gameOutcome": {"lastPeriodType": "OT"}}

        result = nhl._outcome(game)

        self.assertEqual(result, "OT")

    def test_shootout_final(self):
        game = {"gameState": "FINAL", "gameOutcome": {"lastPeriodType": "SO"}}

        result = nhl._outcome(game)

        self.assertEqual(result, "SO")

    def test_live_game_returns_empty(self):
        game = {"gameState": "LIVE", "gameOutcome": {"lastPeriodType": "REG"}}

        result = nhl._outcome(game)

        self.assertEqual(result, "")

    def test_scheduled_game_returns_empty(self):
        game = {"gameState": "FUT"}

        result = nhl._outcome(game)

        self.assertEqual(result, "")

    def test_final_without_outcome_block_returns_empty(self):
        game = {"gameState": "FINAL"}

        result = nhl._outcome(game)

        self.assertEqual(result, "")

    def test_non_dict_outcome_returns_empty(self):
        game = {"gameState": "FINAL", "gameOutcome": "REG"}

        result = nhl._outcome(game)

        self.assertEqual(result, "")

    def test_outcome_block_missing_last_period_type_returns_empty(self):
        game = {"gameState": "FINAL", "gameOutcome": {}}

        result = nhl._outcome(game)

        self.assertEqual(result, "")

    def test_empty_string_last_period_type_returns_empty(self):
        game = {"gameState": "FINAL", "gameOutcome": {"lastPeriodType": ""}}

        result = nhl._outcome(game)

        self.assertEqual(result, "")

    def test_unrecognized_last_period_type_passes_through(self):
        game = {"gameState": "FINAL", "gameOutcome": {"lastPeriodType": "FOO"}}

        result = nhl._outcome(game)

        self.assertEqual(result, "FOO")



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

    def test_fetch_nhl_exposes_playoff_round(self):
        with patch.object(nhl, "fetch_cached", side_effect=self._patched_fetch):
            games = nhl.fetch_nhl("2026-04-21", favorites=[])

        playoff = next(g for g in games if g["home"]["abbrev"] == "EDM")
        regular = next(g for g in games if g["home"]["abbrev"] == "TOR")
        self.assertEqual(playoff["playoffRound"], 2)
        self.assertIsNone(regular["playoffRound"])
        for g in games:
            self.assertIn("playoffRound", g)

    def test_fetch_nhl_exposes_outcome_key(self):
        with patch.object(nhl, "fetch_cached", side_effect=self._patched_fetch):
            games = nhl.fetch_nhl("2026-04-21", favorites=[])

        for g in games:
            self.assertIn("outcome", g)
            self.assertNotIn("winningGoal", g)
        # Fixture has no gameOutcome blocks, so all values
        # should be the documented "no info" defaults.
        for g in games:
            self.assertEqual(g["outcome"], "")

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
        self.assertEqual(edm["venueUrl"], "https://en.wikipedia.org/wiki/Rogers_Place")
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
                {
                    "network": "TNT",
                    "country": "US",
                    "market": "N",
                    "url": "https://www.tntdrama.com/nhl",
                },
                {
                    "network": "CBC",
                    "country": "CA",
                    "market": "N",
                    "url": "https://www.cbc.ca/sports/hockey",
                },
            ],
        )
        self.assertEqual(
            edm["series"],
            {
                "round": 2,
                "title": "2nd Round",
                "abbrev": "R2",
                "letter": "E",
                "gameNumber": 4,
                "neededToWin": 4,
                "topSeedAbbrev": "EDM",
                "topSeedWins": 2,
                "bottomSeedAbbrev": "VAN",
                "bottomSeedWins": 1,
            },
        )
        self.assertEqual(
            edm["seriesUrl"],
            "https://www.nhl.com/schedule/playoff-series/2026/series-e/oilers-vs-canucks",
        )
        self.assertEqual(
            edm["gameCenterLink"],
            "https://www.nhl.com/gamecenter/van-vs-edm/2026/04/21/1",
        )

    def test_fetch_nhl_omits_optional_fields_for_regular_season(self):
        with patch.object(nhl, "fetch_cached", side_effect=self._patched_fetch):
            games = nhl.fetch_nhl("2026-04-21", favorites=[])

        tor = next(g for g in games if g["home"]["abbrev"] == "TOR")
        self.assertEqual(tor["venue"], "")
        self.assertIsNone(tor["venueUrl"])
        self.assertEqual(tor["broadcasts"], [])
        self.assertIsNone(tor["series"])
        self.assertEqual(tor["seriesUrl"], "")
        self.assertEqual(tor["gameCenterLink"], "")
        self.assertEqual(tor["home"]["odds"], "")
        self.assertEqual(tor["home"]["fullName"], "Maple Leafs")
        self.assertEqual(tor["gameType"], 2)
        self.assertEqual(tor["gameTypeLabel"], "Regular Season")

    def test_fetch_nhl_propagates_outcome_for_finished_game(self):
        payload = {
            "gameWeek": [
                {
                    "date": "2026-04-21",
                    "games": [
                        {
                            "id": 99,
                            "gameType": 2,
                            "gameState": "FINAL",
                            "startTimeUTC": "2026-04-21T23:00:00Z",
                            "homeTeam": {
                                "abbrev": "EDM",
                                "commonName": {"default": "Oilers"},
                                "score": 4,
                                "logo": "https://example.com/edm.svg",
                            },
                            "awayTeam": {
                                "abbrev": "VAN",
                                "commonName": {"default": "Canucks"},
                                "score": 3,
                                "logo": "https://example.com/van.svg",
                            },
                            "periodDescriptor": {"number": 4, "periodType": "OT"},
                            "gameOutcome": {"lastPeriodType": "OT"},
                        }
                    ],
                }
            ]
        }
        raw = json.dumps(payload).encode("utf-8")

        with patch.object(nhl, "fetch_cached", return_value=raw):
            games = nhl.fetch_nhl("2026-04-21", favorites=[])

        self.assertEqual(len(games), 1)
        game = games[0]
        self.assertEqual(game["outcome"], "OT")

    def test_fetch_nhl_falls_back_to_google_search_for_unmapped_venue(self):
        unmapped_venue = "Some Obscure Stadium & Arena"
        patched_raw = self._raw.replace(b"Rogers Place", unmapped_venue.encode("utf-8"))

        with patch.object(nhl, "fetch_cached", return_value=patched_raw):
            games = nhl.fetch_nhl("2026-04-21", favorites=[])

        edm = next(g for g in games if g["home"]["abbrev"] == "EDM")
        self.assertEqual(edm["venue"], unmapped_venue)
        self.assertEqual(
            edm["venueUrl"],
            "https://www.google.com/search?q=Some+Obscure+Stadium+%26+Arena",
        )


class ExtractCupWinnerTests(unittest.TestCase):
    """Tests for extract_cup_winner."""

    def test_returns_none_for_regular_season_games(self):
        games = [{"series": None, "home": {"abbrev": "TOR", "fullName": "Toronto Maple Leafs"},
                  "away": {"abbrev": "MTL", "fullName": "Montreal Canadiens"}}]
        self.assertIsNone(nhl.extract_cup_winner(games))

    def test_returns_none_for_incomplete_cup_final(self):
        games = [{"series": {"round": 4, "neededToWin": 4, "topSeedAbbrev": "FLA",
                             "topSeedWins": 2, "bottomSeedAbbrev": "EDM", "bottomSeedWins": 1},
                  "home": {"abbrev": "FLA", "fullName": "Florida Panthers"},
                  "away": {"abbrev": "EDM", "fullName": "Edmonton Oilers"}}]
        self.assertIsNone(nhl.extract_cup_winner(games))

    def test_returns_top_seed_winner(self):
        games = [{"series": {"round": 4, "neededToWin": 4, "topSeedAbbrev": "FLA",
                             "topSeedWins": 4, "bottomSeedAbbrev": "EDM", "bottomSeedWins": 3},
                  "home": {"abbrev": "FLA", "fullName": "Florida Panthers"},
                  "away": {"abbrev": "EDM", "fullName": "Edmonton Oilers"}}]
        result = nhl.extract_cup_winner(games)
        self.assertEqual(result, {"team": "Florida Panthers", "abbrev": "FLA"})

    def test_returns_bottom_seed_winner(self):
        games = [{"series": {"round": 4, "neededToWin": 4, "topSeedAbbrev": "FLA",
                             "topSeedWins": 3, "bottomSeedAbbrev": "EDM", "bottomSeedWins": 4},
                  "home": {"abbrev": "FLA", "fullName": "Florida Panthers"},
                  "away": {"abbrev": "EDM", "fullName": "Edmonton Oilers"}}]
        result = nhl.extract_cup_winner(games)
        self.assertEqual(result, {"team": "Edmonton Oilers", "abbrev": "EDM"})

    def test_returns_none_for_empty_games(self):
        self.assertIsNone(nhl.extract_cup_winner([]))

    def test_ignores_earlier_rounds(self):
        games = [{"series": {"round": 2, "neededToWin": 4, "topSeedAbbrev": "TOR",
                             "topSeedWins": 4, "bottomSeedAbbrev": "BOS", "bottomSeedWins": 3},
                  "home": {"abbrev": "TOR", "fullName": "Toronto Maple Leafs"},
                  "away": {"abbrev": "BOS", "fullName": "Boston Bruins"}}]
        self.assertIsNone(nhl.extract_cup_winner(games))


def _schedule(days: dict) -> "callable":
    """A games_on stand-in serving a fixed {date: games} schedule."""
    return lambda day, favorites, today=None: days.get(day, [])


def _game(state="FINAL", home="EDM"):
    return {"state": state, "home": {"abbrev": home}}


class OffSeasonTests(unittest.TestCase):
    """Tests for find_off_season_games off-season detection."""

    def test_returns_none_when_today_has_games(self):
        result = nhl.find_off_season_games([_game()], [], [])
        self.assertIsNone(result)

    def test_returns_none_when_yesterday_has_games(self):
        result = nhl.find_off_season_games([], [_game()], [])
        self.assertIsNone(result)

    def test_returns_none_when_game_scheduled_tomorrow(self):
        today = dt.date(2026, 4, 10)
        schedule = {
            today + dt.timedelta(days=1): [_game("FUT")],
            today - dt.timedelta(days=3): [_game()],
        }
        with patch.object(nhl, "games_on", side_effect=_schedule(schedule)):
            result = nhl.find_off_season_games([], [], [], today=today)

        self.assertIsNone(result)

    def test_returns_none_when_game_scheduled_later_this_week(self):
        today = dt.date(2026, 4, 10)
        schedule = {today + dt.timedelta(days=7): [_game("FUT", "VAN")]}
        with patch.object(nhl, "games_on", side_effect=_schedule(schedule)):
            result = nhl.find_off_season_games([], [], [], today=today)

        self.assertIsNone(result)

    def test_finds_games_3_days_back(self):
        today = dt.date(2026, 7, 10)
        fake_games = [_game(home="TOR")]
        with patch.object(nhl, "games_on", side_effect=_schedule({dt.date(2026, 7, 7): fake_games})):
            result = nhl.find_off_season_games([], [], [], today=today)

        self.assertEqual(result["date"], "2026-07-07")
        self.assertEqual(result["games"], fake_games)
        self.assertIn("cupWinner", result)

    def test_returns_none_when_no_games_within_7_days(self):
        today = dt.date(2026, 7, 10)
        # Eight days back is past the look-back window.
        schedule = {today - dt.timedelta(days=8): [_game()]}
        with patch.object(nhl, "games_on", side_effect=_schedule(schedule)):
            result = nhl.find_off_season_games([], [], [], today=today)

        self.assertIsNone(result)

    def test_returns_most_recent_day_with_games(self):
        today = dt.date(2026, 7, 10)
        schedule = {
            dt.date(2026, 7, 6): [_game(home="VAN")],
            dt.date(2026, 7, 4): [_game(home="TOR")],
        }
        with patch.object(nhl, "games_on", side_effect=_schedule(schedule)):
            result = nhl.find_off_season_games([], [], [], today=today)

        self.assertEqual(result["date"], "2026-07-06")

    def test_includes_cup_winner_from_final_games(self):
        cup_final_games = [{
            "state": "FINAL",
            "home": {"abbrev": "FLA", "fullName": "Florida Panthers"},
            "away": {"abbrev": "EDM", "fullName": "Edmonton Oilers"},
            "series": {"round": 4, "neededToWin": 4,
                       "topSeedAbbrev": "FLA", "topSeedWins": 4,
                       "bottomSeedAbbrev": "EDM", "bottomSeedWins": 3},
        }]
        today = dt.date(2026, 7, 10)
        schedule = {dt.date(2026, 7, 8): cup_final_games}
        with patch.object(nhl, "games_on", side_effect=_schedule(schedule)):
            result = nhl.find_off_season_games([], [], [], today=today)

        self.assertEqual(result["cupWinner"], {"team": "Florida Panthers", "abbrev": "FLA"})

    def test_day_after_clinch_surfaces_cup_winner_from_yesterday(self):
        cup_final_games = [{
            "state": "FINAL",
            "home": {"abbrev": "CAR", "fullName": "Carolina Hurricanes"},
            "away": {"abbrev": "EDM", "fullName": "Edmonton Oilers"},
            "series": {"round": 4, "neededToWin": 4,
                       "topSeedAbbrev": "CAR", "topSeedWins": 4,
                       "bottomSeedAbbrev": "EDM", "bottomSeedWins": 2},
        }]
        today = dt.date(2026, 6, 15)

        result = nhl.find_off_season_games([], cup_final_games, [], today=today)

        self.assertEqual(result["date"], "2026-06-14")
        self.assertEqual(result["games"], cup_final_games)
        self.assertEqual(result["cupWinner"], {"team": "Carolina Hurricanes", "abbrev": "CAR"})

    def test_day_after_returns_none_when_yesterday_not_cup_final(self):
        today = dt.date(2026, 1, 15)

        result = nhl.find_off_season_games([], [_game()], [], today=today)

        self.assertIsNone(result)


class HasUpcomingGamesTests(unittest.TestCase):
    """Tests for has_upcoming_games look-ahead used to gate off-season modes."""

    def test_true_when_game_tomorrow(self):
        today = dt.date(2026, 4, 10)
        schedule = {dt.date(2026, 4, 11): [_game("FUT")]}
        with patch.object(nhl, "games_on", side_effect=_schedule(schedule)):
            self.assertTrue(nhl.has_upcoming_games([], today=today))

    def test_true_when_game_at_end_of_window(self):
        today = dt.date(2026, 4, 10)
        schedule = {dt.date(2026, 4, 17): [_game("FUT")]}
        with patch.object(nhl, "games_on", side_effect=_schedule(schedule)):
            self.assertTrue(nhl.has_upcoming_games([], today=today))

    def test_false_when_nothing_scheduled_in_window(self):
        today = dt.date(2026, 7, 10)
        schedule = {dt.date(2026, 7, 18): [_game("FUT")]}
        with patch.object(nhl, "games_on", side_effect=_schedule(schedule)):
            self.assertFalse(nhl.has_upcoming_games([], today=today))

    @patch("parsers.nhl.OFF_SEASON_LOOKAHEAD_DAYS", 0)
    def test_lookahead_disabled_when_set_to_zero(self):
        with patch.object(nhl, "games_on") as mock_games_on:
            result = nhl.has_upcoming_games([], today=dt.date(2026, 7, 10))

        self.assertFalse(result)
        mock_games_on.assert_not_called()


class OpeningNightTests(unittest.TestCase):
    """Tests for find_opening_night season-opener preview."""

    def _opener(self):
        return [{"state": "FUT", "home": {"abbrev": "EDM"}, "away": {"abbrev": "CGY"}}]

    def test_returns_none_when_no_season_start(self):
        result = nhl.find_opening_night([], [], None, today=dt.date(2026, 9, 28))
        self.assertIsNone(result)

    def test_returns_none_when_today_has_games(self):
        # Opening day itself: today's games load normally, no preview needed.
        today_games = [{"state": "LIVE", "home": {"abbrev": "EDM"}}]
        with patch.object(nhl, "games_on") as mock_games_on:
            result = nhl.find_opening_night(
                today_games, [], "2026-09-29", today=dt.date(2026, 9, 29)
            )
        self.assertIsNone(result)
        mock_games_on.assert_not_called()

    def test_previews_opener_on_the_eve(self):
        opener = self._opener()
        today = dt.date(2026, 9, 28)
        with patch.object(nhl, "games_on", return_value=opener) as mock_games_on:
            result = nhl.find_opening_night([], [], "2026-09-29", today=today)
        self.assertEqual(result["date"], "2026-09-29")
        self.assertEqual(result["games"], opener)
        self.assertTrue(result["isTomorrow"])
        mock_games_on.assert_called_once_with(dt.date(2026, 9, 29), [], today)

    def test_previews_opener_when_today_is_opening_day_but_empty(self):
        # Opening day with an empty today slate (e.g. schedule not yet loaded):
        # still surface it, flagged as not-tomorrow.
        with patch.object(nhl, "games_on", return_value=self._opener()):
            result = nhl.find_opening_night([], [], "2026-09-29", today=dt.date(2026, 9, 29))
        self.assertIsNotNone(result)
        self.assertFalse(result["isTomorrow"])

    def test_returns_none_when_opener_more_than_a_day_out(self):
        with patch.object(nhl, "games_on") as mock_games_on:
            result = nhl.find_opening_night([], [], "2026-09-29", today=dt.date(2026, 9, 27))
        self.assertIsNone(result)
        mock_games_on.assert_not_called()

    def test_returns_none_when_opener_slate_is_empty(self):
        # Date matches but the upstream slate has no games yet — no preview.
        with patch.object(nhl, "games_on", return_value=[]):
            result = nhl.find_opening_night([], [], "2026-09-29", today=dt.date(2026, 9, 28))
        self.assertIsNone(result)


def _week_page(anchor: dt.date, games_by_day: dict, **meta) -> bytes:
    """A /schedule/<anchor> body: seven gameWeek days starting at *anchor*."""
    days = [anchor + dt.timedelta(days=i) for i in range(7)]
    return json.dumps({
        **meta,
        "gameWeek": [
            {"date": d.isoformat(), "games": [
                {"id": n, "gameState": state,
                 "homeTeam": {"abbrev": "EDM"}, "awayTeam": {"abbrev": "VAN"}}
                for n, state in enumerate(games_by_day.get(d, []))
            ]}
            for d in days
        ],
    }).encode()


class SchedulePagesTests(unittest.TestCase):
    """games_on / nhl_overview: which upstream week pages a poll reads."""

    TODAY = dt.date(2026, 7, 10)

    def setUp(self):
        nhl._pages.clear()
        self.addCleanup(nhl._pages.clear)
        self.games_by_day = {}
        self.meta = {}
        self.fetched = []  # (anchor, ttl) per upstream fetch

    def _fetch(self, url, ttl_seconds, validate=None):
        anchor = dt.date.fromisoformat(url.rsplit("/", 1)[1])
        self.fetched.append((anchor, ttl_seconds))
        return _week_page(anchor, self.games_by_day, **self.meta)

    def _overview(self, **kwargs):
        with patch.object(nhl, "fetch_cached", side_effect=self._fetch):
            return nhl.nhl_overview([], today=self.TODAY, **kwargs)

    def test_in_season_poll_reads_one_page(self):
        self.games_by_day = {self.TODAY: ["LIVE"], self.TODAY - dt.timedelta(days=1): ["OFF"]}

        result = self._overview()

        self.assertEqual(len(result["today"]["games"]), 1)
        self.assertEqual(len(result["yesterday"]["games"]), 1)
        self.assertTrue(result["hasLiveToday"])
        self.assertFalse(result["deepOffSeason"])
        yesterday = self.TODAY - dt.timedelta(days=1)
        self.assertEqual({a for a, _ in self.fetched}, {yesterday})

    def test_deep_off_season_reads_three_pages_with_ttls_by_age(self):
        result = self._overview()

        self.assertTrue(result["deepOffSeason"])
        self.assertIsNone(result["offSeason"])
        yesterday = self.TODAY - dt.timedelta(days=1)
        self.assertEqual(
            {(a, ttl) for a, ttl in self.fetched},
            {
                (yesterday - dt.timedelta(days=7), nhl.SCHEDULE_TTL_PAST),
                (yesterday, nhl.SCHEDULE_TTL_LIVE),
                (yesterday + dt.timedelta(days=7), nhl.SCHEDULE_TTL_FUTURE),
            },
        )

    def test_look_back_finds_last_game_on_previous_page(self):
        self.games_by_day = {self.TODAY - dt.timedelta(days=6): ["OFF"]}

        result = self._overview()

        self.assertEqual(result["offSeason"]["date"], "2026-07-04")
        self.assertFalse(result["deepOffSeason"])

    def test_game_beyond_current_page_counts_as_upcoming(self):
        # today+7 is on the page after the current one.
        self.games_by_day = {self.TODAY + dt.timedelta(days=7): ["FUT"]}

        result = self._overview()

        self.assertFalse(result["deepOffSeason"])
        self.assertIsNone(result["offSeason"])

    def test_season_start_comes_from_schedule(self):
        self.meta = {"regularSeasonStartDate": "2026-10-07"}

        result = self._overview(season_start="2026-09-29")

        self.assertEqual(result["seasonStart"], "2026-10-07")

    def test_season_start_falls_back_to_config(self):
        result = self._overview(season_start="2026-09-29")

        self.assertEqual(result["seasonStart"], "2026-09-29")

    def test_opening_night_eve_previews_tomorrow_from_current_page(self):
        tomorrow = self.TODAY + dt.timedelta(days=1)
        self.games_by_day = {tomorrow: ["FUT", "FUT"]}
        self.meta = {"regularSeasonStartDate": tomorrow.isoformat()}

        result = self._overview()

        self.assertEqual(len(result["openingNight"]["games"]), 2)
        self.assertTrue(result["openingNight"]["isTomorrow"])

    def test_page_is_parsed_once_per_body(self):
        raw = _week_page(self.TODAY, {})
        with patch.object(nhl, "fetch_cached", return_value=raw), \
                patch.object(nhl.json, "loads", wraps=json.loads) as loads:
            nhl.fetch_nhl(self.TODAY.isoformat(), [])
            nhl.fetch_nhl(self.TODAY.isoformat(), [])

        self.assertEqual(loads.call_count, 1)


if __name__ == "__main__":
    unittest.main()
