# Screenshots from the Pi

The dashboard is developed on a Mac but runs on a Raspberry Pi. The two render
differently (fonts, emoji, screen size, GPU effects), so a change that looks
right locally can overflow or misalign on the kiosk. `pi-screenshot.sh` pulls a
real screenshot off the Pi so you can check without walking over to it, and can
render your local working copy at the same size for a side-by-side.

Screenshots land in `pi-shots/` (gitignored), timestamped, with the newest of
each kind also copied to `pi-shots/latest-<mode>.png`.

## Modes

- **live**: `./pi-screenshot.sh` or `make pi-shot`. Exactly what's on the
  Pi's screen right now, as the kiosk shows it. Ground truth.
- **mac**: `./pi-screenshot.sh mac` or `make mac-shot`. Your *local* server
  (uncommitted changes included) rendered by this Mac's Chrome at the Pi's
  size, at 1x.

`live` shows whatever view the rotators happen to be on; run it again to catch
a different one. `mac` always captures the first view of each panel.

`mac` renders at the size of the most recent live shot, so it matches the Pi's
display (1920x1200) automatically. Before any live shot exists it falls back to
1920x1200; override with `PI_SIZE`.

### Comparing a change before and after deploy

```bash
python3 src/server.py &          # local server with your changes
./pi-screenshot.sh live          # what the Pi shows now (also records its size)
./pi-screenshot.sh mac           # your change, at the Pi's size
open pi-shots/latest-live.png pi-shots/latest-mac.png
# ...push to main, wait for the Pi to update (~1 min)...
./pi-screenshot.sh live          # confirm it looks right on the real thing
```

Remaining differences between `latest-mac.png` and `latest-live.png` are the
Mac-vs-Pi rendering gap itself: fonts, emoji, and GPU effects like
`backdrop-filter`.

## Configuration

Environment variables, all optional:

| Variable         | Default               | Purpose                                  |
| ---------------- | --------------------- | ---------------------------------------- |
| `PI_HOST`        | `pi@raspberrypi`      | ssh target for the Pi                    |
| `PI_SIZE`        | last live shot's size | `WxH` for `mac` mode, e.g. `1280x720`    |
| `DASHBOARD_PORT` | `8080`                | local server port for `mac` mode         |

## Setup

Usually none. You need:

- **ssh access to the Pi.** If you can already `ssh` in, you're set. Just make
  sure `PI_HOST` is the target you normally use (an IP such as
  `pi@192.168.86.222` works too). Password logins work, but you'll be prompted
  on every run; `ssh-copy-id <PI_HOST>` avoids that.
- **A screenshot tool on the Pi.** Raspberry Pi OS runs Wayland and ships
  `grim`, a small command-line tool that writes the current screen to a PNG
  and exits. There's no daemon or config. Check with `which grim`. If it's
  missing, run `sudo apt install grim`, or `scrot` on an older X11 setup.
- **Google Chrome** in `/Applications` on the Mac, for `mac` mode only.

## How it works

- **live**: one ssh connection runs a short script on the Pi. It finds the
  desktop session (`XDG_RUNTIME_DIR` plus the `wayland-*` socket, or
  `DISPLAY=:0` on X11), runs `grim` (or `scrot`), and streams the PNG back over
  the same connection. Nothing is left on the Pi. It must run as the user
  logged in to the kiosk desktop (`pi`).
- **mac**: curl the local `/api/*` endpoints so the server's cache is warm,
  then run Chrome with `--headless=new --screenshot --virtual-time-budget=3000`.
  Virtual time only advances while the network is idle, so data, logos and the
  wallpaper load before the capture. The budget stays under the 6s weather
  rotation, so the first view is captured. `--force-device-scale-factor=1`
  makes a Retina Mac render at the Pi's pixel density rather than 2x. Headless
  Chrome on macOS doesn't exit after writing the PNG, so the script waits for
  the file and then kills it.

There is deliberately no mode that runs headless Chromium on the Pi itself.
Without a display it can't initialize the GPU, and `--virtual-time-budget`
never settles there, so it either hangs or captures a half-loaded page. A
fresh Chromium profile without `--password-store=basic` also starts the
desktop keyring and pops an "Authentication required" password dialog on the
kiosk screen.

## Troubleshooting

- **`Host key verification failed`**: `PI_HOST` isn't a name you've connected
  with before (e.g. `raspberrypi.local` vs `raspberrypi`), or the Pi was
  reflashed. Use your usual target, or connect once by hand to accept the key.
- **`Wayland session found but grim is missing`**: `sudo apt install grim` on the Pi.
- **`screenshot came back empty`**: the ssh user isn't the one logged in to the
  desktop, or the compositor doesn't support screen capture.
- **All-black shot**: the display is asleep or blanked.
- **`Local server isn't running`** in mac mode: start it with
  `python3 src/server.py`, or set `DASHBOARD_PORT` if it's on another port.
