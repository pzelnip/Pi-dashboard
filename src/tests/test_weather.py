"""Tests for weather fetch shaping."""

import unittest
from unittest.mock import patch

from tests._helpers import fixture_bytes

from parsers import weather


class FetchWeatherTests(unittest.TestCase):
    def test_fetch_weather_shape(self):
        raw = fixture_bytes("weather.json")

        with patch.object(weather, "fetch_cached", return_value=raw):
            result = weather.fetch_weather(48.4284, -123.3656)

        self.assertIn("current", result)
        self.assertIn("daily", result)
        self.assertIn("units", result)
        self.assertEqual(result["current"]["temperature_2m"], 14.2)
        self.assertEqual(result["daily"]["temperature_2m_max"][0], 16.0)
        self.assertEqual(result["units"]["current"]["temperature_2m"], "°C")
        self.assertEqual(result["units"]["daily"]["temperature_2m_max"], "°C")

    def test_fetch_weather_passes_lat_lon_to_url(self):
        raw = fixture_bytes("weather.json")
        captured = {}

        def fake_cache(url, ttl_seconds):
            captured["url"] = url
            captured["ttl"] = ttl_seconds
            return raw

        with patch.object(weather, "fetch_cached", side_effect=fake_cache):
            weather.fetch_weather(48.4284, -123.3656)

        self.assertIn("latitude=48.4284", captured["url"])
        self.assertIn("longitude=-123.3656", captured["url"])
        self.assertEqual(captured["ttl"], 600)

    def test_fetch_weather_raises_on_html_response(self):
        with patch.object(weather, "fetch_cached", return_value=b"<html>oops</html>"):
            with self.assertRaises(ValueError):
                weather.fetch_weather(0.0, 0.0)


if __name__ == "__main__":
    unittest.main()
