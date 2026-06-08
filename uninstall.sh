#!/usr/bin/env bash
# Connection Watchman - remove the background services (Linux systemd, macOS launchd).
# Your data (uptime.db) is left in place.
set -e
OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  for svc in monitor dashboard; do
    plist="/Library/LaunchDaemons/co.connectionwatchman.$svc.plist"
    sudo launchctl bootout system "$plist" 2>/dev/null || true
    sudo rm -f "$plist"
  done
  echo "Removed launchd services. Your data (uptime.db) was left in place."
else
  for svc in monitor dashboard; do
    sudo systemctl disable --now uptime-$svc.service 2>/dev/null || true
    sudo rm -f /etc/systemd/system/uptime-$svc.service
  done
  sudo systemctl daemon-reload
  echo "Removed systemd services. Your data (uptime.db) was left in place."
fi
