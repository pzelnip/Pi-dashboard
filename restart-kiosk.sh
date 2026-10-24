#!/usr/bin/env bash
# Nightly fresh start for the kiosk: restart the dashboard service and the
# Chromium kiosk. Chromium otherwise runs for weeks between reboots, and a
# long-lived renderer slowly accumulates memory and work on the Pi. Run from
# cron (see docs/deployment.md); output goes to update.log so it shows up in
# the debug panel's "Update log" view.
set -euo pipefail

SERVICE="dashboard.service"
# The login-time launcher (from ~/.config/autostart/dashboard-kiosk.desktop):
# waits for /api/version, then execs chromium --kiosk.
KIOSK_LAUNCHER="${KIOSK_LAUNCHER:-$HOME/temp/sandbox/runKiosk.sh}"

log() { echo "[$(date)] restart-kiosk: $*" >&2; }

# cron runs outside the desktop session, so point Chromium at the kiosk's
# Wayland display ourselves (same lookup as pi-screenshot.sh). Without
# XDG_SESSION_TYPE the chromium wrapper picks X11, finds no display and exits.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XDG_SESSION_TYPE=wayland
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  for s in "$XDG_RUNTIME_DIR"/wayland-*; do
    case "$s" in *.lock|*"*") continue ;; esac
    export WAYLAND_DISPLAY="${s##*/}"; break
  done
fi
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  log "ERROR: no Wayland display in $XDG_RUNTIME_DIR; is the desktop logged in?"
  exit 1
fi
if [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
fi

# Not fatal: a fresh browser is the main point, and the launcher below waits
# for the server either way.
sudo systemctl restart "$SERVICE" || log "WARNING: could not restart $SERVICE"

# SIGTERM lets Chromium shut down cleanly, so it comes back without the
# "Chromium didn't shut down correctly" bubble. Escalate only if it hangs.
if pkill -TERM -x chromium; then
  for _ in $(seq 1 30); do
    pgrep -x chromium >/dev/null || break
    sleep 1
  done
  if pgrep -x chromium >/dev/null; then
    log "chromium still running after 30s; killing"
    pkill -KILL -x chromium || true
    sleep 1
  fi
fi

# Detach so the browser outlives this cron job.
setsid "$KIOSK_LAUNCHER" >/dev/null 2>&1 </dev/null &

# A chromium process alone proves little (it can start and then bail out);
# wait for a page renderer, then make sure it's still there a bit later.
for _ in $(seq 1 90); do
  if pgrep -f -- "chromium.*--type=renderer" >/dev/null; then
    sleep 10
    if pgrep -f -- "chromium.*--type=renderer" >/dev/null; then
      log "kiosk restarted on $WAYLAND_DISPLAY"
      exit 0
    fi
    break
  fi
  sleep 1
done
log "ERROR: kiosk did not come back; launch it by hand with $KIOSK_LAUNCHER"
exit 1
