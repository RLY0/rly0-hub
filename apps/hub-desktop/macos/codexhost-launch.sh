#!/bin/bash
# bin/codexhost inside RLY0 Hub.app: start the user's installed codexhost (DirectExecutable
# desktop launch) unless one is already running. Never starts a second host.
set -u
PKG="${CODEXHOST_PKG:-/Volumes/RLY0Dev/Dev/Cache/npm-global/lib/node_modules/@codexhost/cli-darwin-arm64}"
NODE_BIN="${CODEXHOST_NODE:-/Volumes/RLY0Dev/Dev/Cache/node-v24/bin/node}"
LOGDIR="$HOME/Library/Logs/rly0-hub"; mkdir -p "$LOGDIR"
if /usr/bin/pgrep -f "$PKG/bin/codexhost launch" >/dev/null 2>&1; then
  echo "$(date '+%F %T') codexhost already running; not starting another" >> "$LOGDIR/codexhost-launch.log"
  exit 0
fi
[ -x "$PKG/bin/codexhost" ] && [ -x "$NODE_BIN" ] || { echo "$(date '+%F %T') codexhost/node missing" >> "$LOGDIR/codexhost-launch.log"; exit 1; }
nohup "$PKG/bin/codexhost" launch --node "$NODE_BIN" --shim "$PKG/libexec/codexhost-shim" \
  --host-runtime "$PKG/app/host-runtime.mjs" --desktop-controller "$PKG/app/desktop-controller.mjs" \
  --renderer "$PKG/app/renderer-extension.js" >> "$LOGDIR/codexhost-launch.log" 2>&1 < /dev/null &
exit 0
