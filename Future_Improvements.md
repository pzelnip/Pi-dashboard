# Future Improvements

## Tests

There's no tests for anything.  Add them

## Restructure the Code

Both the Python and the JS are big blobs.  Break them up.

## Mobile View Swiping

When viewing mobile make left/right swipe on a panel do the prev/next button action

## Deploy Hardening

Codex flagged things like a bad config change could break the server.

## Calendar correctness

TZID handling: still broken. server.py:399-411 checks only endswith("Z");
non-UTC timed events with TZID=America/... are parsed as naive local time.

TZID parsing is a localized fix — stdlib zoneinfo can resolve the TZID and
convert.
