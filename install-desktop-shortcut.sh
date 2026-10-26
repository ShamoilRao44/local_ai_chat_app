#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if command -v xdg-user-dir >/dev/null 2>&1; then
  DESKTOP_DIR="$(xdg-user-dir DESKTOP)"
else
  DESKTOP_DIR="$HOME/Desktop"
fi

if [[ -z "$DESKTOP_DIR" || "$DESKTOP_DIR" == "$HOME" ]]; then
  DESKTOP_DIR="$HOME/Desktop"
fi

APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="local-ai-chat-app.desktop"
ESCAPED_APP_DIR="$(printf '%s' "$APP_DIR" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g')"
mkdir -p "$APPLICATIONS_DIR" "$DESKTOP_DIR"

cat >"$APPLICATIONS_DIR/$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Local AI Chat
Comment=Start Local AI Chat in your browser
Exec="$ESCAPED_APP_DIR/launch-app.sh"
Icon=web-browser
Terminal=false
Categories=Network;
StartupNotify=true
EOF

cp "$APPLICATIONS_DIR/$DESKTOP_FILE" "$DESKTOP_DIR/$DESKTOP_FILE"
chmod +x "$APPLICATIONS_DIR/$DESKTOP_FILE" "$DESKTOP_DIR/$DESKTOP_FILE"
chmod +x "$APP_DIR/launch-app.sh"

if command -v gio >/dev/null 2>&1; then
  gio set "$DESKTOP_DIR/$DESKTOP_FILE" metadata::trusted true 2>/dev/null || true
fi

printf 'Installed the shortcut on your desktop and in the applications menu.\n'
printf 'If Ubuntu asks, choose "Allow Launching" on the desktop icon.\n'
