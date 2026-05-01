#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/pi/temp/sandbox/Pi-dashboard"
BRANCH="main"
SERVICE="dashboard.service"

# --force restarts the service even when the remote is already merged
# locally. Used by the dashboard's "Force update" button so a click
# always produces a visible action; cron runs without --force and only
# restarts when there's actually new code.
FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

cd "$REPO_DIR"

git fetch origin "$BRANCH"

LOCAL_REV="$(git rev-parse HEAD)"
REMOTE_REV="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL_REV" != "$REMOTE_REV" ] || [ "$FORCE" = "1" ]; then
  if [ "$LOCAL_REV" != "$REMOTE_REV" ]; then
    git pull --ff-only origin "$BRANCH"
  fi
  sudo systemctl restart "$SERVICE"

  for i in $(seq 1 10); do
    if curl -fsS http://localhost:8080/api/version > /dev/null 2>&1; then
      echo "[$(date)] dashboard restarted (force=$FORCE), /api/version OK" >&2
      exit 0
    fi
    sleep 1
  done

  echo "[$(date)] ERROR: dashboard /api/version unreachable after restart" >&2
  systemctl status "$SERVICE" --no-pager >&2
  exit 1
fi
