#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/pi/temp/sandbox/Pi-dashboard"
BRANCH="main"
SERVICE="dashboard.service"

cd "$REPO_DIR"

git fetch origin "$BRANCH"

LOCAL_REV="$(git rev-parse HEAD)"
REMOTE_REV="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL_REV" != "$REMOTE_REV" ]; then
  git pull --ff-only origin "$BRANCH"
  sudo systemctl restart "$SERVICE"
fi
