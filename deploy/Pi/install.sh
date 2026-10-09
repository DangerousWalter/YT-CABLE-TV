#!/usr/bin/env bash
# Installs (or updates) Retro-Cable TV as a background service on a Raspberry Pi / any Debian-style Linux.
#   sudo bash deploy/pi/install.sh
# Re-run it with a newer bundle to update: your channels, profiles and settings are kept.
set -euo pipefail

APP_DIR=/opt/retro-cable-tv
DATA_DIR=/var/lib/retro-cable-tv
ENV_FILE=/etc/retro-cable-tv.env
SERVICE=retro-cable-tv
SVC_USER=retrotv
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Please run this with sudo:  sudo bash deploy/pi/install.sh"
[ -f "$SRC_DIR/server.cjs" ] && [ -f "$SRC_DIR/dist/index.html" ] || fail "Run this from inside the extracted retro-cable-tv folder."

# ---- Node.js 22.13 or newer, installed for the whole system ----
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. See PACKAGING.md, section 'Raspberry Pi', step 1."
NODE_BIN="$(command -v node)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Node.js $(node -v) is too old. Retro-Cable TV needs 22.13 or newer. See PACKAGING.md, section 'Raspberry Pi', step 1."
case "$NODE_BIN" in
  /home/*|/root/*) fail "Node.js is installed in a home folder ($NODE_BIN). The service can't use that. Install it system-wide (see PACKAGING.md)." ;;
esac
command -v npm >/dev/null 2>&1 || fail "npm was not found."
echo "Using Node $(node -v) at $NODE_BIN"

# ---- a locked-down user to run the service ----
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  say "Creating the service user '$SVC_USER'"
  useradd --system --no-create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi

# ---- the program files ----
say "Copying the program to $APP_DIR"
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/dist" "$APP_DIR/server" "$APP_DIR/server.cjs"
cp -a "$SRC_DIR/dist" "$SRC_DIR/server" "$SRC_DIR/server.cjs" "$SRC_DIR/package.json" "$APP_DIR/"

say "Installing the few libraries it needs (plain JavaScript, nothing to compile)"
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund )
chown -R root:root "$APP_DIR"

# ---- settings file (only created the first time) ----
if [ ! -f "$ENV_FILE" ]; then
  say "Creating $ENV_FILE"
  cat > "$ENV_FILE" <<'ENVEOF'
# Retro-Cable TV settings. After editing: sudo systemctl restart retro-cable-tv
PORT=3001
# Let TVs, phones and laptops on your network connect (1 = yes, 0 = this Pi only)
RETROTV_LAN=1
# Optional: your YouTube API key (you can also set it from the app's Settings; see PACKAGING.md)
# YOUTUBE_API_KEY=paste-your-key-here
ENVEOF
  chmod 600 "$ENV_FILE"
fi

# ---- the service ----
say "Installing and starting the service"
sed "s#@NODE@#$NODE_BIN#g" "$SRC_DIR/deploy/pi/retro-cable-tv.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 3

if systemctl is-active --quiet "$SERVICE"; then
  PORT_NOW="$(grep -E '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2)"; PORT_NOW="${PORT_NOW:-3001}"
  say "Retro-Cable TV is running"
  echo "Open it from another device on your network:"
  for ip in $(hostname -I 2>/dev/null); do echo "    http://$ip:$PORT_NOW"; done
  echo "    http://$(hostname).local:$PORT_NOW   (on most home networks)"
  echo
  echo "Data folder:   $DATA_DIR"
  echo "Logs:          journalctl -u $SERVICE -f"
  echo "Next:          set your YouTube API key (PACKAGING.md, 'Raspberry Pi', step 4)"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    echo
    echo "NOTE: the ufw firewall is on. Allow your network in with:  sudo ufw allow from 192.168.0.0/16 to any port $PORT_NOW proto tcp"
  fi
else
  echo
  systemctl status "$SERVICE" --no-pager || true
  fail "The service did not start. See the messages above, or run: journalctl -u $SERVICE -e"
fi
