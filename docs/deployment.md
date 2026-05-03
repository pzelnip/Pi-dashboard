# Raspberry Pi Dashboard Deployment

## Overview

The Pi runs a Python HTTP server ([src/server.py](../src/server.py)) on port
8080, displayed via Chromium in kiosk mode. All Pi-runtime code (server,
parsers, config, static frontend) lives under [`src/`](../src/); deployment
tooling (`update-dashboard.sh`) stays at the repo root, and docs (this file
included) live in [`docs/`](.).

- **URL:** <http://localhost:8080>
- **Kiosk command:** `chromium --kiosk http://localhost:8080`

### Update flow

1. Push to GitHub.
2. A cron job on the Pi polls `origin/main` every minute.
3. If the remote is ahead, the Pi pulls and restarts the systemd service.

---

## Paths

**Repo directory:** `/home/pi/temp/sandbox/Pi-dashboard`

| File                  | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `src/server.py`       | HTTP server serving the dashboard                        |
| `src/public/`         | Static frontend (HTML/CSS/JS) served by the kiosk        |
| `src/config.json`     | Dashboard config (rotation, weather, NHL, RSS, calendar) |
| `update-dashboard.sh` | Poll + pull + restart script (run by cron)               |
| `update.log`          | Output of the cron-driven update script                  |

---

## Systemd Service

**File:** `/etc/systemd/system/dashboard.service`

```ini
[Unit]
Description=Pi Dashboard server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/temp/sandbox/Pi-dashboard
ExecStart=/usr/bin/python3 /home/pi/temp/sandbox/Pi-dashboard/src/server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Common commands

```bash
systemctl status dashboard.service
sudo systemctl restart dashboard.service
journalctl -u dashboard.service -f
```

---

## Update Script

**File:** `/home/pi/temp/sandbox/Pi-dashboard/update-dashboard.sh`

```bash
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
```

---

## Cron Job

Edit with `crontab -e`:

```cron
* * * * * /home/pi/temp/sandbox/Pi-dashboard/update-dashboard.sh >> /home/pi/temp/sandbox/Pi-dashboard/update.log 2>&1
```

---

## Sudo Config

The `pi` user needs passwordless permission to restart the service, so the
cron-driven update script can call `sudo systemctl restart`.

Edit with `sudo visudo` and add:

```text
pi ALL=NOPASSWD: /bin/systemctl restart dashboard.service
```

---

## Troubleshooting

**Tail the update script log** (shows cron runs, pulls, failures):

```bash
tail -f /home/pi/temp/sandbox/Pi-dashboard/update.log
```

**Check the service status:**

```bash
systemctl status dashboard.service
```

**Follow service logs live:**

```bash
journalctl -u dashboard.service -f
```

**Confirm the server is responding:**

```bash
curl http://localhost:8080
```

**Force an update run manually** (bypasses cron timing):

```bash
/home/pi/temp/sandbox/Pi-dashboard/update-dashboard.sh
```

---

## Migrating an existing Pi to the `src/` layout

The code now lives under `src/`. After pulling the move-to-`src/` change on an
existing Pi, the systemd service file points at the wrong path and must be
updated before the service can come back up:

1. Pull the change (cron will do this on its next tick, or run
   `update-dashboard.sh` manually):

   ```bash
   /home/pi/temp/sandbox/Pi-dashboard/update-dashboard.sh
   ```

   The first restart attempt against the new tree will fail because
   `ExecStart` still points at the old path.

2. Update `/etc/systemd/system/dashboard.service`. Change:

   ```ini
   ExecStart=/usr/bin/python3 /home/pi/temp/sandbox/Pi-dashboard/server.py
   ```

   to:

   ```ini
   ExecStart=/usr/bin/python3 /home/pi/temp/sandbox/Pi-dashboard/src/server.py
   ```

   `WorkingDirectory` stays the repo root (so `git rev-parse HEAD` and
   `update-dashboard.sh` keep working).

3. Reload systemd and restart:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart dashboard.service
   systemctl status dashboard.service
   ```

4. If you have a `config.local.json`, move it from the repo root into `src/`:

   ```bash
   mv /home/pi/temp/sandbox/Pi-dashboard/config.local.json \
      /home/pi/temp/sandbox/Pi-dashboard/src/config.local.json
   ```

5. Cron entry, sudo config, kiosk autostart command, and `update-dashboard.sh`
   itself need no changes — `update.log` and `update-dashboard.sh` still live
   at the repo root.
