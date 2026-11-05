#!/usr/bin/env bash
# Build "Codexhost Hub.app" (shell-wrapper launcher) + .dmg. Local only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VER="${1:-0.11.32}"
OUT="$ROOT/build/macos/$VER"; APP="$OUT/Codexhost Hub.app"
rm -rf "$APP" "$OUT/Codexhost-Hub-$VER-macos-arm64.dmg"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>codexhost-hub</string>
<key>CFBundleIdentifier</key><string>com.rly0.codexhost.hub</string>
<key>CFBundleName</key><string>Codexhost Hub</string>
<key>CFBundleDisplayName</key><string>Codexhost Hub</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VER</string>
<key>CFBundleVersion</key><string>$VER</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PL
cat > "$APP/Contents/MacOS/codexhost-hub" <<'SH'
#!/bin/bash
# Codexhost Hub launcher: open console if Hub running, else start codexhost launch then open.
NODE_DIR="${CODEXHOST_NODE_DIR:-/Volumes/RLY0Dev/Dev/Cache/node-v24/bin}"
NPM_BIN="${CODEXHOST_NPM_BIN:-/Volumes/RLY0Dev/Dev/Cache/npm-global/bin}"
PKG="${CODEXHOST_PKG:-/Volumes/RLY0Dev/Dev/Cache/npm-global/lib/node_modules/@codexhost/cli-darwin-arm64}"
URL="${CODEXHOST_CONSOLE_URL:-http://127.0.0.1:4399}"
LOGDIR="$HOME/Library/Logs/codexhost-hub"; mkdir -p "$LOGDIR"; LOG="$LOGDIR/hub-launcher.log"
export PATH="$NODE_DIR:$NPM_BIN:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
up(){ /usr/bin/curl -s -o /dev/null -m 2 -w '%{http_code}' "$URL" | grep -q '^[23]'; }
say(){ /usr/bin/osascript -e "display alert \"Codexhost Hub\" message \"$1\"" >/dev/null 2>&1; }
if up; then log "hub up -> open console"; [ "${DRY_RUN:-}" = 1 ] || /usr/bin/open "$URL"; exit 0; fi
if [ ! -d /Volumes/RLY0Dev ]; then log "RLY0Dev not mounted"; say "外接盘 RLY0Dev 未挂载"; exit 1; fi
if pgrep -f "$PKG/bin/codexhost launch" >/dev/null; then log "launch process exists, waiting"; else
  CMD=("$PKG/bin/codexhost" launch --node "$NODE_DIR/node" --shim "$PKG/libexec/codexhost-shim" \
    --host-runtime "$PKG/app/host-runtime.mjs" --desktop-controller "$PKG/app/desktop-controller.mjs" \
    --renderer "$PKG/app/renderer-extension.js")
  log "cold start: ${CMD[*]}"
  if [ "${DRY_RUN:-}" = 1 ]; then echo "DRY_RUN would run: ${CMD[*]}"; exit 0; fi
  nohup "${CMD[@]}" >> "$LOGDIR/codexhost-launch.log" 2>&1 < /dev/null &
  disown
fi
for i in $(seq 1 90); do up && { log "hub up after ${i}s"; /usr/bin/open "$URL"; exit 0; }; sleep 1; done
log "timeout waiting for $URL"; say "Hub 90 秒内未就绪，日志：$LOGDIR"; exit 1
SH
chmod 755 "$APP/Contents/MacOS/codexhost-hub"
PNG="$ROOT/crates/launcher/assets/codexhost.png"
if [ -f "$PNG" ]; then IS="$OUT/AppIcon.iconset"; rm -rf "$IS"; mkdir -p "$IS"
  for s in 16 32 128 256 512; do sips -z $s $s "$PNG" --out "$IS/icon_${s}x${s}.png" >/dev/null; d=$((s*2)); sips -z $d $d "$PNG" --out "$IS/icon_${s}x${s}@2x.png" >/dev/null; done
  iconutil -c icns "$IS" -o "$APP/Contents/Resources/AppIcon.icns"; rm -rf "$IS"; fi
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --deep -s - "$APP"; codesign --verify --deep --strict "$APP"
ST="$OUT/dmg-stage"; rm -rf "$ST"; mkdir -p "$ST"; cp -R "$APP" "$ST/"; ln -s /Applications "$ST/Applications"
hdiutil create -volname "Codexhost Hub $VER" -srcfolder "$ST" -ov -format UDZO "$OUT/Codexhost-Hub-$VER-macos-arm64.dmg" >/dev/null
rm -rf "$ST"; echo "app=$APP"; echo "dmg=$OUT/Codexhost-Hub-$VER-macos-arm64.dmg"
