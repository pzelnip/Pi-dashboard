"""Shared test helpers: import server.py from the worktree root and load fixtures."""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")

if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def fixture_path(name: str) -> str:
    return os.path.join(FIXTURES, name)


def fixture_bytes(name: str) -> bytes:
    with open(fixture_path(name), "rb") as f:
        return f.read()


def fixture_text(name: str) -> str:
    with open(fixture_path(name), encoding="utf-8") as f:
        return f.read()
