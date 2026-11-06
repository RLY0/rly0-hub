import { describe, expect, it } from "vitest";
import { releaseBuildCommands } from "../../scripts/release/prepare-payload.mjs";
import { releaseTarget } from "../../scripts/release/targets.mjs";

function commands(environment) {
  return releaseBuildCommands(
    releaseTarget("windows-x64"),
    "win32",
    {
      npm_execpath: "C:\\node\\npm-cli.js",
      ...environment,
    },
    "C:\\node\\node.exe",
    "E:\\work tree\\hub",
  );
}
function rustEnvironment(environment) {
  const result = commands(environment).at(-1).env;
  expect(result).toBeDefined();
  return result;
}
describe("release Rust path privacy", () => {
  it("remaps all private roots for only the Rust release subprocess", () => {
    const environment = {
      USERPROFILE: "C:\\Users\\fixture",
      CARGO_HOME: "D:\\cargo cache",
      RUSTUP_HOME: "D:\\rust toolchains",
    };
    const result = rustEnvironment(environment);
    const flags = result.CARGO_ENCODED_RUSTFLAGS.split("\x1f");
    for (const mapping of [
      "C:\\Users\\fixture=/build/home",
      "D:\\cargo cache=/build/cargo",
      "D:\\rust toolchains=/build/rustup",
      "E:\\work tree\\hub=/build/rly0-hub",
      "C:/Users/fixture=/build/home",
      "E:/work tree/hub=/build/rly0-hub",
    ])
      expect(flags).toContain(`--remap-path-prefix=${mapping}`);
    expect(
      commands(environment)
        .slice(0, 2)
        .every((command) => command.env === undefined),
    ).toBe(true);
    expect(environment.CARGO_ENCODED_RUSTFLAGS).toBeUndefined();
    expect(result.CARGO_PROFILE_RELEASE_DEBUG).toBe("0");
    expect(result.CARGO_PROFILE_RELEASE_STRIP).toBe("debuginfo");
  });
  it("derives default Cargo and rustup homes without hard-coded usernames", () => {
    const flags = rustEnvironment({
      USERPROFILE: "C:\\Users\\fixture",
    }).CARGO_ENCODED_RUSTFLAGS.split("\x1f");
    expect(flags).toContain("--remap-path-prefix=C:\\Users\\fixture\\.cargo=/build/cargo");
    expect(flags).toContain("--remap-path-prefix=C:\\Users\\fixture\\.rustup=/build/rustup");
    const broad = flags.indexOf("--remap-path-prefix=C:\\Users\\fixture=/build/home");
    const specific = flags.indexOf("--remap-path-prefix=C:\\Users\\fixture\\.cargo=/build/cargo");
    expect(specific).toBeGreaterThan(broad);
  });
  it("preserves existing encoded flags instead of silently using lower-priority RUSTFLAGS", () => {
    const result = rustEnvironment({
      USERPROFILE: "C:\\Users\\fixture",
      CARGO_ENCODED_RUSTFLAGS: "-C\x1ftarget-feature=+crt-static",
      RUSTFLAGS: "--cfg ignored_flag",
    });
    expect(result.CARGO_ENCODED_RUSTFLAGS.split("\x1f").slice(0, 2)).toEqual([
      "-C",
      "target-feature=+crt-static",
    ]);
    expect(result.CARGO_ENCODED_RUSTFLAGS).not.toContain("ignored_flag");
  });
  it("preserves ordinary RUSTFLAGS when encoded flags are absent", () => {
    const result = rustEnvironment({
      USERPROFILE: "C:\\Users\\fixture",
      RUSTFLAGS: "--cfg release_fixture",
    });
    expect(result.CARGO_ENCODED_RUSTFLAGS.split("\x1f").slice(0, 2)).toEqual([
      "--cfg",
      "release_fixture",
    ]);
  });
});
