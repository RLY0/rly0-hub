import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAntigravityExecutable } from "../src/command.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolving agy", () => {
  it.runIf(process.platform === "win32")(
    "finds the official installer's agy.exe without it being on PATH (installed after Codex started)",
    () => {
      const local = mkdtempSync(path.join(os.tmpdir(), "codexhost-agy-local-"));
      roots.push(local);
      const home = mkdtempSync(path.join(os.tmpdir(), "codexhost-agy-home-"));
      roots.push(home);
      const environment = {
        PATH: "",
        PATHEXT: ".EXE;.CMD",
        LOCALAPPDATA: local,
        USERPROFILE: home,
      };
      expect(resolveAntigravityExecutable({ environment, homeDirectory: home })).toBeUndefined();
      mkdirSync(path.join(local, "agy", "bin"), { recursive: true });
      writeFileSync(path.join(local, "agy", "bin", "agy.exe"), "");
      // Resolved on every call, so a fresh install is found without restarting.
      expect(
        resolveAntigravityExecutable({ environment, homeDirectory: home })?.toLowerCase(),
      ).toBe(path.join(local, "agy", "bin", "agy.exe").toLowerCase());
    },
  );
});
