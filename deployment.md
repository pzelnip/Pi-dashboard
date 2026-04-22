# Raspberry Pi Dashboard Deployment

## Overview
This Pi runs a Python HTTP server (`server.py`) serving:
http://localhost:8080

Chromium runs in kiosk mode:
chromium --kiosk http://localhost:8080

Updates flow:
- Push to GitHub
- Pi polls every minute
- If changes found → pulls + restarts service

---

## Directory
/home/pi/temp/sandbox/Pi-dashboard

Key files:
- server.py
- update-dashboard.sh
- update.log

---

## Systemd Service
/etc/systemd/system/dashboard.service

[Unit]
Description=Pi Dashboard server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/temp/sandbox/Pi-dashboard
ExecStart=/usr/bin/python3 /home/pi/temp/sandbox/Pi-dashboard/server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target

Commands:
systemctl status dashboard.service
sudo systemctl restart dashboard.service
journalctl -u dashboard.service -f

---

## Update Script
/home/pi/temp/sandbox/Pi-dashboard/update-dashboard.sh

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

---

## Cron Job
crontab -e

* * * * * /home/pi/temp/sandbox/Pi-dashboard/update-dashboard.sh >> /home/pi/temp/sandbox/Pi-dashboard/update.log 2>&1

---

## Sudo Config
sudo visudo

pi ALL=NOPASSWD: /bin/systemctl restart dashboard.service

---

## Troubleshooting

Check updates:
tail -f update.log

Check service:
systemctl status dashboard.service

Logs:
journalctl -u dashboard.service -f

Test server:
curl http://localhost:8080

Force update:
./update-dashboard.sh
