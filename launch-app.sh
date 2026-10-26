#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

show_error() {
  if command -v notify-send >/dev/null 2>&1; then
    notify-send --urgency=critical "Local AI Chat" "$1"
  fi
  printf '%s\n' "$1" >&2
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  show_error "Node.js 18 or newer and npm are required to run Local AI Chat."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  show_error "curl is required to check whether Local AI Chat has started."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  show_error "Dependencies are missing. Open a terminal in the app folder and run: npm install"
  exit 1
fi

PORT="$(node --input-type=module -e "import 'dotenv/config'; console.log(process.env.PORT || '3000')")"
URL="http://127.0.0.1:${PORT}"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/local-ai-chat-app"
LOG_FILE="$LOG_DIR/server.log"
mkdir -p "$LOG_DIR"

if ! curl --silent --fail --max-time 2 "$URL/api/config" >/dev/null; then
  nohup npm start >>"$LOG_FILE" 2>&1 </dev/null &
fi

for _ in {1..30}; do
  if curl --silent --fail --max-time 2 "$URL/api/config" >/dev/null; then
    if ! command -v xdg-open >/dev/null 2>&1; then
      show_error "Local AI Chat is running at $URL, but xdg-open was not found."
      exit 1
    fi
    xdg-open "$URL"
    exit 0
  fi
  sleep 1
done

show_error "Local AI Chat did not start. Check the log at $LOG_FILE."
exit 1
