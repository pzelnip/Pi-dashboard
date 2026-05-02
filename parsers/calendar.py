"""iCalendar (.ics) parser. Implements a minimal subset of RFC 5545."""

import datetime as dt
import hashlib
import sys

from cache import fetch_cached


def _ics_unfold(text: str) -> list[str]:
    # RFC 5545: lines that start with a space or tab are continuations.
    out: list[str] = []
    for raw_line in text.splitlines():
        if raw_line.startswith((" ", "\t")) and out:
            out[-1] += raw_line[1:]
        else:
            out.append(raw_line)
    return out


def _ics_parse_dt(value: str, params: dict[str, str]) -> tuple[object, bool]:
    """Return (datetime-or-date, is_all_day)."""
    is_date = params.get("VALUE") == "DATE" or (len(value) == 8 and "T" not in value)
    if is_date:
        return dt.date(int(value[0:4]), int(value[4:6]), int(value[6:8])), True
    # Timed value: 20260421T140000 or 20260421T140000Z
    is_utc = value.endswith("Z")
    if is_utc:
        value = value[:-1]
    naive = dt.datetime.strptime(value, "%Y%m%dT%H%M%S")
    if is_utc:
        naive = naive.replace(tzinfo=dt.timezone.utc).astimezone().replace(tzinfo=None)
    return naive, False


def _ics_unescape(text: str) -> str:
    return (
        text.replace("\\n", " ")
        .replace("\\N", " ")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
    )


def parse_ics(text: str) -> list[dict]:
    """Parse a minimal subset of RFC 5545. Skips events with RRULE."""
    lines = _ics_unfold(text)
    events: list[dict] = []
    current: dict | None = None
    skipped_recurring = 0

    for line in lines:
        if line == "BEGIN:VEVENT":
            current = {}
            continue
        if line == "END:VEVENT":
            if current is not None and "start" in current and "summary" in current:
                if current.pop("_recurring", False):
                    skipped_recurring += 1
                else:
                    events.append(current)
            current = None
            continue
        if current is None:
            continue

        # Property line: NAME[;PARAM=VAL;...]:VALUE
        if ":" not in line:
            continue
        try:
            head, _, value = line.partition(":")
            parts = head.split(";")
            name = parts[0].upper()
            params = {}
            for p in parts[1:]:
                if "=" in p:
                    k, _, v = p.partition("=")
                    params[k.upper()] = v

            if name == "SUMMARY":
                current["summary"] = _ics_unescape(value)
            elif name == "DTSTART":
                current["start"], current["allDay"] = _ics_parse_dt(value, params)
            elif name == "DTEND":
                current["end"], _ = _ics_parse_dt(value, params)
            elif name == "RRULE":
                current["_recurring"] = True
        except Exception as e:
            sys.stderr.write(f"[calendar] skipping event due to parse error: {e}\n")
            current = None  # discard this event entirely; END:VEVENT won't append it

    if skipped_recurring:
        sys.stderr.write(f"[calendar] skipped {skipped_recurring} recurring event(s)\n")
    return events


def _event_occurs_today(ev: dict, today: dt.date) -> bool:
    start = ev["start"]
    end = ev.get("end", start)
    # All-day events: iCal DTEND is exclusive (next day). Treat missing end as same day.
    start_d = (
        start
        if isinstance(start, dt.date) and not isinstance(start, dt.datetime)
        else start.date()
    )
    end_d = (
        end
        if isinstance(end, dt.date) and not isinstance(end, dt.datetime)
        else end.date()
    )
    if ev.get("allDay"):
        # DTEND is exclusive for all-day per RFC 5545
        return start_d <= today < end_d if end_d > start_d else start_d == today
    return start_d <= today <= end_d


def _redact_url(url: str) -> str:
    h = hashlib.sha256(url.encode()).hexdigest()[:8]
    return f"<sha256:{h}>"


def fetch_calendar(urls: list[str]) -> list[dict]:
    today = dt.date.today()
    all_events: list[dict] = []
    for idx, url in enumerate(urls):
        try:
            raw = fetch_cached(url, ttl_seconds=300)
        except Exception as e:
            sys.stderr.write(f"[calendar] fetch failed for url #{idx} ({_redact_url(url)}): {e}\n")
            continue
        text = raw.decode("utf-8", errors="replace")
        for ev in parse_ics(text):
            if not _event_occurs_today(ev, today):
                continue
            start = ev["start"]
            end = ev.get("end", start)
            all_events.append(
                {
                    "summary": ev["summary"],
                    "start": start.isoformat(),
                    "end": end.isoformat() if hasattr(end, "isoformat") else str(end),
                    "allDay": bool(ev.get("allDay")),
                    "source": idx,
                }
            )

    # All-day first, then by start time.
    all_events.sort(key=lambda e: (not e["allDay"], e["start"]))
    return all_events
