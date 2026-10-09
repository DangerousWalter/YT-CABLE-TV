#!/usr/bin/env bash
# Removes the Retro-Cable TV service.
#   sudo bash deploy/pi/uninstall.sh            keeps your channels and settings
#   sudo bash deploy/pi/uninstall.sh --purge    deletes them too
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo."; exit 1; }

systemctl disable --now retro-cable-tv 2>/dev/null || true
rm -f /etc/systemd/system/retro-cable-tv.service
systemctl daemon-reload
rm -rf /opt/retro-cable-tv
echo "Service and program removed."

if [ "${1:-}" = "--purge" ]; then
  rm -rf /var/lib/retro-cable-tv /etc/retro-cable-tv.env
  id -u retrotv >/dev/null 2>&1 && userdel retrotv || true
  echo "Data, settings and the service user deleted."
else
  echo "Your data is still in /var/lib/retro-cable-tv (add --purge to delete it)."
fi
