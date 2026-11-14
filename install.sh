#!/usr/bin/env bash
# Clip installer — checks prerequisites, prepares data/, optionally installs a user service.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3001}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "Clip installer"
say "  directory: $DIR"

# --- Node -------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is required (>= 24). Install it, then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || die "Node.js >= 24 required (found $(node -v)); Clip uses the built-in node:sqlite."
say "  node: $(node -v)"

# --- ffmpeg -----------------------------------------------------------------
if ! command -v ffmpeg >/dev/null 2>&1; then
  die "ffmpeg is required. Debian/Ubuntu: sudo apt install ffmpeg — macOS: brew install ffmpeg"
fi
command -v ffprobe >/dev/null 2>&1 || die "ffprobe is required (ships with ffmpeg)."
say "  ffmpeg: $(ffmpeg -version | head -1 | cut -d' ' -f1-3)"

# --- data -------------------------------------------------------------------
mkdir -p "$DIR/data/media" "$DIR/data/brand/music" "$DIR/data/tmp"
say "  data: $DIR/data"

# --- optional user service --------------------------------------------------
if [ "${1:-}" = "--service" ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/clip.service" <<EOF
[Unit]
Description=Clip — self-hosted screen recorder and editor
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
ExecStart=$(command -v node) $DIR/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now clip.service
  say "  service: clip.service enabled (systemctl --user status clip)"
  say "  logs:    journalctl --user -u clip -f"
else
  say ""
  say "Run it:"
  say "  cd $DIR && PORT=$PORT node server.js"
  say ""
  say "Or install as a user service:"
  say "  ./install.sh --service"
fi

say ""
say "Open http://localhost:$PORT"
