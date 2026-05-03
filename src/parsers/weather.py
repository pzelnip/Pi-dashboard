"""Weather parser: fetches Open-Meteo forecast and trims to client shape."""

import json
import urllib.parse

from cache import fetch_cached


def fetch_weather(lat: float, lon: float) -> dict:
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m",
        "daily": "temperature_2m_max,temperature_2m_min,weather_code",
        "forecast_days": 4,
        "timezone": "auto",
    }
    url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params)
    raw = fetch_cached(url, ttl_seconds=600)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("upstream returned non-JSON response (got HTML?)")
    return {
        "current": data.get("current", {}),
        "daily": data.get("daily", {}),
        "units": {
            "current": data.get("current_units", {}),
            "daily": data.get("daily_units", {}),
        },
    }
