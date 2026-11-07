#!/bin/bash
# bin/codexhost of a development-kit RLY0 Hub.app that has no codexhost payload of its own (the
# release app ships the real Launcher there instead): opens Codex through the codexhost install in
# CODEXHOST_PKG (a folder with bin/codexhost, libexec/ and app/) and CODEXHOST_NODE, unless a
# codexhost host is already running, whichever install started it. Never starts a second host.
set -u
RESOURCES="$(cd "$(dirname "$0")/.." && pwd -P)"
PKG="${CODEXHOST_PKG:-$RESOURCES/codexhost}"
NODE_BIN="${CODEXHOST_NODE:-$RESOURCES/runtime/node}"
LOGDIR="$HOME/Library/Logs/rly0-hub"
mkdir -p "$LOGDIR"
log() { echo "$(date '+%F %T') $*" >> "$LOGDIR/codexhost-launch.log"; }
# A subcommand (the Hub service runs `inspect --json` for its compatibility check) goes to the
# Launcher as is; only a bare call opens Codex.
if [ "$#" -gt 0 ]; then
  exec "$PKG/bin/codexhost" "$@"
fi
if /usr/bin/pgrep -f "/bin/codexhost launch( |$)" >/dev/null 2>&1; then
  log "codexhost already running; not starting another"
  exit 0
fi
if [ ! -x "$PKG/bin/codexhost" ] || [ ! -x "$NODE_BIN" ]; then
  log "codexhost or node missing under $PKG"
  exit 1
fi
log "starting codexhost from $PKG"
nohup "$PKG/bin/codexhost" launch --node "$NODE_BIN" --shim "$PKG/libexec/codexhost-shim" \
  --host-runtime "$PKG/app/host-runtime.mjs" --desktop-controller "$PKG/app/desktop-controller.mjs" \
  --renderer "$PKG/app/renderer-extension.js" >> "$LOGDIR/codexhost-launch.log" 2>&1 < /dev/null &
exit 0
