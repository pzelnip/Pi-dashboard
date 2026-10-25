# Pi Setup Notes

Scattered notes on setting up the pi so it starts in kiosk mode.
Not complete, and partly from memory

## clone the repo

Put it in `~/temp/sandbox`

## Create runKiosk.sh

put in `~/temp/sandbox/runKiosk.sh`, contents:

```shell
#!/bin/sh

until curl -sf http://localhost:8080/api/version >/dev/null; do
  sleep 1
done

exec chromium --kiosk --password-store=basic 'http://localhost:8080/?fade=150'
```

`?fade=150` shortens the cross-fades between views to 150 ms for the kiosk
only (the default is 400 ms; `?fade=0` turns them off). The Pi draws fades in
software, and short ones cost it far less CPU. Other browsers viewing the
dashboard keep the default.

Make sure to chmod it to make it executable.

## Create an autostart entry

```shell
mkdir -p ~/.config/autostart
vim ~/.config/autostart/dashboard-kiosk.desktop
```

contents:

```ini
[Desktop Entry]
Type=Application
Name=Dashboard Kiosk
Exec=/home/pi/kiosk.sh
X-GNOME-Autostart-enabled=true
```
