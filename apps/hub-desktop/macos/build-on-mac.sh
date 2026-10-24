#!/usr/bin/env bash
set -euo pipefail

KIT_ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE_PATH_FOR_BUILD="${1:-}"
APP_PATH="$KIT_ROOT/RLY0 Hub.app"
HOST_ARCH="$(uname -m)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "A macOS host is required for this development build." >&2
  exit 1
fi
case "$HOST_ARCH" in
  arm64) NODE_ARCH=arm64; SWIFT_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64; SWIFT_ARCH=x86_64 ;;
  *) echo "Unsupported macOS architecture." >&2; exit 1 ;;
esac
ZIP_PATH="$KIT_ROOT/RLY0-Hub-macos-$NODE_ARCH-dev.app.zip"
if [[ $# -ne 1 || ! -x "$NODE_PATH_FOR_BUILD" ]]; then
  echo "Usage: bash build-on-mac.sh /absolute/path/to/node" >&2
  exit 2
fi
NODE_IDENTITY="$("$NODE_PATH_FOR_BUILD" -p 'process.platform + "/" + process.arch + "/" + process.versions.node.split(".")[0]')"
case "$NODE_IDENTITY" in
  "darwin/$NODE_ARCH/22"|"darwin/$NODE_ARCH/24") ;;
  *) echo "Use a native macOS Node.js 22 or 24 runtime matching this host." >&2; exit 1 ;;
esac
KIT_TARGET="$("$NODE_PATH_FOR_BUILD" -e 'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).target)' "$KIT_ROOT/kit-manifest.json")"
if [[ "$KIT_TARGET" != "macos-$NODE_ARCH" ]]; then
  echo "Kit architecture does not match this host. Prepare a matching --arch kit." >&2
  exit 1
fi
if [[ -e "$APP_PATH" || -e "$ZIP_PATH" ]]; then
  echo "Build outputs already exist; prepare a new kit directory." >&2
  exit 1
fi
/usr/bin/xcrun --find swiftc >/dev/null
/usr/bin/plutil -lint "$KIT_ROOT/sources/Info.plist" >/dev/null
for required in sources/Rly0Hub.swift sources/bridge.js kit-manifest.json \
  payload/app/hub-service.mjs payload/app/hub-ui/index.html; do
  test -s "$KIT_ROOT/$required" || { echo "Incomplete development kit: $required" >&2; exit 1; }
done
"$NODE_PATH_FOR_BUILD" --check "$KIT_ROOT/payload/app/hub-service.mjs"
while IFS= read -r dependency; do
  case "$dependency" in
    /usr/lib/*|/System/Library/*) ;;
    *) echo "Node requires an unbundled library; use a standalone Node distribution." >&2; exit 1 ;;
  esac
done < <(/usr/bin/otool -L "$NODE_PATH_FOR_BUILD" | /usr/bin/awk 'NR > 1 { print $1 }')

CONTENTS="$APP_PATH/Contents"
RESOURCES="$CONTENTS/Resources"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES/runtime"
cp -R "$KIT_ROOT/payload/app" "$RESOURCES/app"
cp "$KIT_ROOT/sources/bridge.js" "$RESOURCES/mac-bridge.js"
cp "$KIT_ROOT/sources/Info.plist" "$CONTENTS/Info.plist"
cp "$NODE_PATH_FOR_BUILD" "$RESOURCES/runtime/node"
chmod 755 "$RESOURCES/runtime/node"
/usr/bin/xcrun swiftc -swift-version 5 -O -target "$SWIFT_ARCH-apple-macos12.0" \
  -framework AppKit -framework WebKit \
  "$KIT_ROOT/sources/Rly0Hub.swift" -o "$CONTENTS/MacOS/rly0-hub"
/usr/bin/codesign --force --sign - "$RESOURCES/runtime/node"
/usr/bin/codesign --force --sign - "$CONTENTS/MacOS/rly0-hub"
/usr/bin/codesign --force --sign - "$APP_PATH"
/usr/bin/codesign --verify --deep --strict "$APP_PATH"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"
printf '%s\n' '{"nativeBuild":"pass","adHocSignature":"pass","launch":"not_run","realAccount":"not_run","release":"not_run"}' > "$KIT_ROOT/native-build-result.json"
echo "Development app built. Launch and real-account validation have not run."
