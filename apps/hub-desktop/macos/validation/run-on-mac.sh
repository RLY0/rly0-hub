#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "A macOS host is required. No native checks ran." >&2
  exit 1
fi
if [[ $# -ne 1 || "$1" != /* || ! -x "$1" ]]; then
  echo "Usage: bash run-on-mac.sh /absolute/path/to/standalone-node" >&2
  exit 2
fi
KIT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
NODE_FOR_VALIDATION="$1"
case "$(uname -m)" in
  arm64) VALIDATION_ARCH=arm64 ;;
  x86_64) VALIDATION_ARCH=x64 ;;
  *) echo "Unsupported host architecture." >&2; exit 1 ;;
esac
NODE_IDENTITY="$("$NODE_FOR_VALIDATION" -p 'process.platform + "/" + process.arch + "/" + process.versions.node.split(".")[0]')"
case "$NODE_IDENTITY" in
  "darwin/$VALIDATION_ARCH/22"|"darwin/$VALIDATION_ARCH/24") ;;
  *) echo "Use Node.js 22 or 24 matching the native macOS architecture." >&2; exit 1 ;;
esac
"$NODE_FOR_VALIDATION" "$KIT_ROOT/verify-kit.mjs"
TARGET="$("$NODE_FOR_VALIDATION" -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).target)' "$KIT_ROOT/validation-manifest.json")"
[[ "$TARGET" == "macos-$VALIDATION_ARCH" ]] || { echo "Kit/host architecture mismatch." >&2; exit 1; }
command -v cargo >/dev/null
command -v rustc >/dev/null
/usr/bin/xcrun --find swiftc >/dev/null
RUST_HOST="$(rustc -vV | /usr/bin/awk '/^host:/ { print $2 }')"
case "$VALIDATION_ARCH/$RUST_HOST" in
  arm64/aarch64-apple-darwin|x64/x86_64-apple-darwin) ;;
  *) echo "Rust toolchain must match the native macOS host." >&2; exit 1 ;;
esac
if [[ -e "$KIT_ROOT/results" || -L "$KIT_ROOT/results" ]]; then
  echo "Results already exist. Extract a fresh kit for another attempt." >&2
  exit 1
fi
mkdir -m 700 "$KIT_ROOT/results"
unset NODE_OPTIONS NODE_PATH CARGO_BUILD_TARGET RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
unset RLY0_MACOS_SECURE_STORE_PREVIEW

bash "$KIT_ROOT/core/scripts/validate-macos.sh" "$KIT_ROOT/results/core" \
  2>&1 | /usr/bin/tee "$KIT_ROOT/results/core-validation.log"
bash "$KIT_ROOT/hub/build-on-mac.sh" "$NODE_FOR_VALIDATION" \
  2>&1 | /usr/bin/tee "$KIT_ROOT/results/hub-build.log"
"$NODE_FOR_VALIDATION" "$KIT_ROOT/verify-kit.mjs" > "$KIT_ROOT/results/source-verification.json"
"$NODE_FOR_VALIDATION" -e '
const fs = require("node:fs"), path = require("node:path");
const root = process.argv[1];
const core = JSON.parse(fs.readFileSync(path.join(root, "results/core/result.json"), "utf8"));
const hub = JSON.parse(fs.readFileSync(path.join(root, "hub/native-build-result.json"), "utf8"));
if (core.nativeCompilation !== "pass" || hub.nativeBuild !== "pass") process.exit(1);
const summary = { schemaVersion: 1, core, hub, launch: "not_run", persistentKeychain: "not_run", realAccount: "not_run", independentReview: "not_run" };
fs.writeFileSync(path.join(root, "results/summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
' "$KIT_ROOT"
echo "Compilation/tests finished; inspect results/summary.json. Hub was not launched."
