import { describe, expect, it } from "vitest";

import { Rly0CodexControl } from "../src/rly0-hub-service/codex-control.js";
import {
  locateOfficialCodex,
  type CodexLocateFileSystem,
} from "../src/rly0-hub-service/codex-locate.js";

const bundle = "/Applications/Codex.app";
const modern = `${bundle}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
const legacy = `${bundle}/Contents/Resources/codex`;

function syntheticFiles(
  files: Record<string, { mode?: number; header?: string; target?: string }>,
): CodexLocateFileSystem {
  const missing = () => Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
  return {
    async readdir() {
      return [];
    },
    async readlink() {
      throw missing();
    },
    async realpath(file) {
      if (files[file]) return files[file].target ?? file;
      if (Object.keys(files).some((candidate) => candidate.startsWith(`${file}/`))) return file;
      throw missing();
    },
    async stat(file) {
      if (!files[file]) throw missing();
      return { isFile: () => true, mtimeMs: 1, mode: files[file].mode ?? 0o755 };
    },
    async readHeader(file) {
      if (!files[file]) throw missing();
      return Buffer.from(files[file].header ?? "cffaedfe", "hex");
    },
  };
}

describe("Mac Codex discovery (synthetic filesystem)", () => {
  it("prefers the nested CLI shipped in current application bundles", async () => {
    expect(
      await locateOfficialCodex({
        environment: {},
        platform: "darwin",
        fileSystem: syntheticFiles({ [modern]: {}, [legacy]: {} }),
      }),
    ).toEqual({ path: modern, source: "macosBundle" });
  });

  it("supports the legacy packaged CLI and universal Mach-O headers", async () => {
    expect(
      await locateOfficialCodex({
        environment: {},
        platform: "darwin",
        fileSystem: syntheticFiles({ [legacy]: { header: "cafebabe" } }),
      }),
    ).toEqual({ path: legacy, source: "macosBundle" });
  });

  it("finds a user-installed application and honors an explicit bundle", async () => {
    const userCli = "/Users/synthetic/Applications/Codex.app/Contents/Resources/codex";
    expect(
      await locateOfficialCodex({
        environment: { HOME: "/Users/synthetic" },
        platform: "darwin",
        fileSystem: syntheticFiles({ [userCli]: {} }),
      }),
    ).toEqual({ path: userCli, source: "macosBundle" });
    const custom = "/Volumes/Dev/Codex.app";
    const customCli = `${custom}/Contents/Resources/codex`;
    expect(
      await locateOfficialCodex({
        environment: { CODEXHOST_INSTALL_ROOT: custom },
        platform: "darwin",
        fileSystem: syntheticFiles({ [customCli]: {} }),
      }),
    ).toEqual({ path: customCli, source: "macosBundle" });
  });

  it("does not silently fall back when the explicit bundle is missing or relative", async () => {
    for (const explicit of ["", "Codex.app", "/missing/Codex.app", "/Applications"]) {
      expect(
        await locateOfficialCodex({
          environment: { CODEXHOST_INSTALL_ROOT: explicit },
          platform: "darwin",
          fileSystem: syntheticFiles({ [modern]: {} }),
        }),
      ).toBeNull();
    }
  });

  it("rejects non-executable scripts, invalid headers and symlinks outside the bundle", async () => {
    for (const file of [
      { mode: 0o644 },
      { header: "23212f62" },
      { header: "cf" },
      { target: "/tmp/codex" },
      { target: `${bundle}-other/codex` },
    ]) {
      expect(
        await locateOfficialCodex({
          environment: {},
          platform: "darwin",
          fileSystem: syntheticFiles({ [modern]: file }),
        }),
      ).toBeNull();
    }
  });

  it("returns unavailable for unsupported platforms", async () => {
    expect(
      await locateOfficialCodex({
        environment: {},
        platform: "linux",
        fileSystem: syntheticFiles({ [modern]: {} }),
      }),
    ).toBeNull();
  });
});

describe("Mac Codex launcher entry (synthetic process)", () => {
  it("opens only the bundled native launcher when installed", async () => {
    const started: string[] = [];
    const control = new Rly0CodexControl({
      environment: {},
      installRoot: "/synthetic/Resources",
      platform: "darwin",
      fileExists: (file) => file === "/synthetic/Resources/bin/codexhost",
      startDetached: (file) => {
        started.push(file);
      },
    });
    expect(await control.status()).toEqual({ running: false, canOpen: true });
    expect(await control.open()).toEqual({ ok: true });
    expect(started).toEqual(["/synthetic/Resources/bin/codexhost"]);
    expect(await control.restart()).toEqual({ ok: false });
    expect(await control.forceQuit()).toEqual({ ok: false });
    expect(started).toHaveLength(1);
  });

  it("keeps a source-only development kit unavailable without a launcher", async () => {
    const control = new Rly0CodexControl({
      environment: {},
      installRoot: "/synthetic/Resources",
      platform: "darwin",
      fileExists: () => false,
      startDetached: () => {
        throw new Error("must not launch");
      },
    });
    expect(await control.status()).toEqual({ running: false, canOpen: false });
    expect(await control.open()).toEqual({ ok: false });
  });
});
