import os from "node:os";
import path from "node:path";

// Cargo gives encoded flags precedence. Keep caller flags and append release-only
// remaps, with broader roots first so rustc's last matching prefix is most specific.
export function rustReleaseEnvironment(
  root,
  environment = process.env,
  platform = process.platform,
) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const home = environment.USERPROFILE || environment.HOME || os.homedir();
  const mappings = [
    [home, "/build/home"],
    [root, "/build/rly0-hub"],
    [environment.CARGO_HOME || paths.join(home, ".cargo"), "/build/cargo"],
    [environment.RUSTUP_HOME || paths.join(home, ".rustup"), "/build/rustup"],
  ]
    .map(([source, destination]) => [paths.resolve(source), destination])
    .sort((a, b) => a[0].length - b[0].length);
  const inherited = environment.CARGO_ENCODED_RUSTFLAGS
    ? environment.CARGO_ENCODED_RUSTFLAGS.split("\x1f")
    : (environment.RUSTFLAGS || "").trim().split(/\s+/u).filter(Boolean);
  const remaps = mappings.flatMap(([source, destination]) =>
    [...new Set([source, source.replaceAll("\\", "/")])].map(
      (prefix) => `--remap-path-prefix=${prefix}=${destination}`,
    ),
  );
  return {
    ...environment,
    CARGO_ENCODED_RUSTFLAGS: [...inherited, ...remaps].join("\x1f"),
    CARGO_PROFILE_RELEASE_DEBUG: "0",
    CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
  };
}
