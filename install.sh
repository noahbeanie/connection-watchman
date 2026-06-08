#!/usr/bin/env bash
# Connection Watchman - one-command installer for Linux and macOS.
#
#   From a clone:   bash install.sh
#   Remotely:       curl -fsSL https://raw.githubusercontent.com/noahbeanie/connection-watchman/main/install.sh | bash
#
# Sets up the monitor + dashboard as always-on background services (systemd on
# Linux, launchd on macOS) that start on boot. Pure Python 3 stdlib, no pip.
set -e

REPO="https://github.com/noahbeanie/connection-watchman.git"
APP_NAME="connection-watchman"

# Use this folder if it's a clone (monitor.py beside the script); otherwise fetch it.
SCRIPT_DIR="$( (cd "$(dirname "$0")" 2>/dev/null && pwd) || true )"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/monitor.py" ]; then
  DIR="$SCRIPT_DIR"
else
  DIR="$HOME/.local/share/$APP_NAME"
  if ! command -v git >/dev/null 2>&1; then
    echo "git not found. Install git, or download the repo and run bash install.sh from inside it."
    exit 1
  fi
  echo "Fetching Connection Watchman into $DIR ..."
  if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else mkdir -p "$(dirname "$DIR")" && git clone --depth 1 "$REPO" "$DIR"; fi
fi

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "python3 not found."
  echo "  Debian/Ubuntu/Pi: sudo apt-get install -y python3"
  echo "  macOS:            xcode-select --install   (or install from python.org)"
  exit 1
fi

OS="$(uname -s)"
USER_NAME="$(whoami)"
HOST="$(hostname -s 2>/dev/null || hostname 2>/dev/null | cut -d. -f1)"

# Port: reuse a prior install's port so upgrades never move it; otherwise prefer 8080 and
# fall back to the next free port. Chosen once, then baked in so restarts never change it.
PORT=""
if [ "$OS" = "Darwin" ]; then
  PLIST="/Library/LaunchDaemons/co.connectionwatchman.dashboard.plist"
  if [ -f "$PLIST" ]; then
    PORT="$(sed -n 's@.*UPTIME_PORT</key><string>\([0-9]*\).*@\1@p' "$PLIST")"
    [ -z "$PORT" ] && PORT=8080
  fi
elif [ -f /etc/systemd/system/uptime-dashboard.service ]; then
  PORT="$(sed -n 's/.*UPTIME_PORT=\([0-9]*\).*/\1/p' /etc/systemd/system/uptime-dashboard.service)"
  [ -z "$PORT" ] && PORT=8080
fi
if [ -z "$PORT" ]; then
  PORT="$("$PY" -c '
import socket
for p in range(8080, 8090):
    s = socket.socket()
    try:
        s.bind(("", p)); s.close(); print(p); break
    except OSError:
        pass
else:
    print(8080)
')"
fi
ENV_LINE=""
[ "$PORT" != "8080" ] && ENV_LINE="Environment=UPTIME_PORT=$PORT"

echo "Installing from: $DIR"
echo "Python:          $PY"
echo "OS:              $OS"
echo "Port:            $PORT"

# The dashboard URLs - printed at the end so you see exactly where to go.
print_urls() {
  ip="$1"
  echo
  echo "Connection Watchman is running. Open the dashboard at:"
  echo "  On this device:     http://localhost:$PORT"
  echo "  From other devices: http://$HOST.local:$PORT   <-- bookmark this one"
  [ -n "$ip" ] && echo "  Or by IP:           http://$ip:$PORT"
  echo
  echo "Tip: bookmark the .local address - it keeps working even if the device's IP changes."
}

if [ "$OS" = "Darwin" ]; then
  # ---- macOS: launchd LaunchDaemons (start at boot, run as you) ----
  ENV_PLIST=""
  [ "$PORT" != "8080" ] && ENV_PLIST="  <key>EnvironmentVariables</key><dict><key>UPTIME_PORT</key><string>$PORT</string></dict>"
  for svc in monitor dashboard; do
    label="co.connectionwatchman.$svc"
    plist="/Library/LaunchDaemons/$label.plist"
    sudo tee "$plist" >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>UserName</key><string>$USER_NAME</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$DIR/$svc.py</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
$ENV_PLIST
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/connection-watchman-$svc.log</string>
  <key>StandardErrorPath</key><string>/tmp/connection-watchman-$svc.log</string>
</dict>
</plist>
EOF
    sudo launchctl bootout system "$plist" 2>/dev/null || true
    sudo launchctl bootstrap system "$plist"
  done
  IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  print_urls "$IP"
  echo "Logs:    /tmp/connection-watchman-monitor.log   /tmp/connection-watchman-dashboard.log"
  echo "Remove:  bash uninstall.sh"
else
  # ---- Linux: systemd ----
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemd not found. This installer supports systemd Linux, macOS, and Windows (install.ps1)."
    exit 1
  fi
  for svc in monitor dashboard; do
    case $svc in
      monitor)   DESC="Connection Watchman internet monitor (logging daemon)" ;;
      dashboard) DESC="Connection Watchman dashboard (web UI)" ;;
    esac
    sudo tee /etc/systemd/system/uptime-$svc.service >/dev/null <<EOF
[Unit]
Description=$DESC
After=network.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$DIR
ExecStart=$PY $DIR/$svc.py
$ENV_LINE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  done
  sudo systemctl daemon-reload
  sudo systemctl enable --now uptime-monitor.service
  sudo systemctl enable --now uptime-dashboard.service
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  print_urls "$IP"
  echo "Status:  systemctl status uptime-monitor"
  echo "Logs:    journalctl -u uptime-monitor -f"
  echo "Remove:  bash uninstall.sh"
fi
