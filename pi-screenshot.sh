#!/usr/bin/env bash
# Grab a screenshot of the dashboard as the Pi renders it and copy it back to
# this machine. See docs/pi-screenshots.md for setup and usage.
#
#   ./pi-screenshot.sh        # live: exactly what's on the Pi's screen now
#   ./pi-screenshot.sh mac    # render the *local* server with this Mac's
#                             # Chrome at the Pi's size, for side-by-side
#
# Env:
#   PI_HOST         ssh target           (default: pi@raspberrypi)
#   PI_SIZE         WxH for mac mode     (default: size of the last live
#                                         shot, else 1920x1200)
#   DASHBOARD_PORT  local port for mac mode (default: 8080)
set -euo pipefail

MODE="${1:-live}"
PI_HOST="${PI_HOST:-pi@raspberrypi}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$REPO_DIR/pi-shots"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Virtual time headless Chrome (mac mode) gives the page before capturing.
# Virtual time only advances while the network is idle, so fetches and images
# complete first; it then fast-forwards timers, so keep this under the
# shortest rotation interval (weatherPanelSeconds) or you'll capture a
# rotated view.
SETTLE_MS=3000

mkdir -p "$OUT_DIR"

png_size() {  # prints WxH of a PNG, via macOS sips
  sips -g pixelWidth -g pixelHeight "$1" 2>/dev/null |
    awk '/pixelWidth/ {w=$2} /pixelHeight/ {h=$2} END {if (w) print w "x" h}'
}

default_size() {
  if [ -n "${PI_SIZE:-}" ]; then echo "$PI_SIZE"; return; fi
  if [ -f "$OUT_DIR/latest-live.png" ]; then
    local s; s="$(png_size "$OUT_DIR/latest-live.png")"
    if [ -n "$s" ]; then echo "$s"; return; fi
  fi
  echo "1920x1200"
}

# Runs on the Pi. Writes the PNG to stdout; all diagnostics go to stderr.
# It must run as the user logged in to the kiosk desktop so it can reach the
# display: Wayland via grim (Raspberry Pi OS default), X11 via scrot/import.
REMOTE_SCRIPT='
set -eu
dir=$(mktemp -d)
trap "rm -rf \"$dir\"" EXIT
out="$dir/shot.png"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  for s in "$XDG_RUNTIME_DIR"/wayland-*; do
    case "$s" in *.lock|*"*") continue ;; esac
    export WAYLAND_DISPLAY="${s##*/}"; break
  done
fi
if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v grim >/dev/null; then
  grim "$out"
elif [ -n "${WAYLAND_DISPLAY:-}" ]; then
  echo "Wayland session found but grim is missing: sudo apt install grim" >&2; exit 1
elif command -v scrot >/dev/null; then
  DISPLAY="${DISPLAY:-:0}" scrot "$out"
elif command -v import >/dev/null; then
  DISPLAY="${DISPLAY:-:0}" import -window root "$out"
else
  echo "No screenshot tool found. Wayland: sudo apt install grim; X11: sudo apt install scrot" >&2; exit 1
fi

[ -s "$out" ] || { echo "screenshot came back empty" >&2; exit 1; }
cat "$out"
'

capture_live() {
  local dest="$1" tmp="$1.part"
  if ! ssh -o ConnectTimeout=10 "$PI_HOST" bash -s <<<"$REMOTE_SCRIPT" >"$tmp"; then
    rm -f "$tmp"
    echo "Capture failed (see above). Can you 'ssh $PI_HOST'?" >&2
    exit 1
  fi
  mv "$tmp" "$dest"
}

capture_mac() {
  local size="$1" dest="$2"
  local chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  local url="http://localhost:${DASHBOARD_PORT:-8080}"
  [ -x "$chrome" ] || { echo "Google Chrome not found at $chrome" >&2; exit 1; }
  curl -sf "$url/api/version" >/dev/null ||
    { echo "Local server isn't running at $url (python3 src/server.py)" >&2; exit 1; }
  local p
  for p in nhl weather "rss?feed=0" calendar; do
    curl -s -m 20 "$url/api/$p" >/dev/null || true
  done
  local profile; profile="$(mktemp -d)"
  # --force-device-scale-factor=1 so a Retina Mac renders at the Pi's 1x
  # pixel density instead of producing a 2x image. Headless Chrome on macOS
  # doesn't exit after writing the PNG, so wait for the file and kill it.
  "$chrome" --headless=new --hide-scrollbars --user-data-dir="$profile" \
    --force-device-scale-factor=1 --window-size="${size%x*},${size#*x}" \
    --virtual-time-budget="$SETTLE_MS" --screenshot="$dest" "$url" >/dev/null 2>&1 &
  local pid=$! i=0
  while [ ! -s "$dest" ] && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done
  sleep 1
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  pkill -f -- "--user-data-dir=$profile" 2>/dev/null || true
  rm -rf "$profile"
  [ -s "$dest" ] || { echo "Chrome didn't produce a screenshot" >&2; exit 1; }
}

case "$MODE" in
  live)
    dest="$OUT_DIR/pi-live-$STAMP.png"
    capture_live "$dest"
    ;;
  mac)
    size="$(default_size)"
    dest="$OUT_DIR/mac-$STAMP.png"
    capture_mac "$size" "$dest"
    ;;
  -h|--help|help)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "usage: $0 [live|mac]" >&2
    exit 2
    ;;
esac

cp "$dest" "$OUT_DIR/latest-$MODE.png"
echo "$dest ($(png_size "$dest"))"
echo "also copied to pi-shots/latest-$MODE.png"
