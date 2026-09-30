import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { importLegacyCodexHostData } from "../src/legacy-codexhost-import.js";

function makeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "rly0-legacy-import-"));
  const legacy = path.join(home, ".codexhost", "mapping-store");
  mkdirSync(path.join(legacy, "threads"), { recursive: true });
  mkdirSync(path.join(legacy, "backups"), { recursive: true });
  writeFileSync(path.join(legacy, "threads", "a.json"), '{"id":"a"}');
  writeFileSync(path.join(legacy, "threads", "b.json"), '{"id":"b"}');
  writeFileSync(path.join(legacy, "backups", "a.json"), '{"id":"a"}');
  writeFileSync(path.join(legacy, "store.lock"), '{"pid":1}');
  mkdirSync(path.join(home, ".codexhost", "antigravity-history"), { recursive: true });
  writeFileSync(path.join(home, ".codexhost", "antigravity-history", "h.json"), "legacy");
  return home;
}

describe("importLegacyCodexHostData", () => {
  it("copies thread mappings once, leaving the legacy directory untouched", () => {
    const home = makeHome();
    const result = importLegacyCodexHostData({}, { home });
    expect(result).toEqual({ imported: true, reason: "imported", threads: 2 });
    const target = path.join(home, ".rly0-hub", "mapping-store");
    expect(readdirSync(path.join(target, "threads")).sort()).toEqual(["a.json", "b.json"]);
    expect(existsSync(path.join(target, "backups", "a.json"))).toBe(true);
    expect(existsSync(path.join(target, "store.lock"))).toBe(false);
    expect(readdirSync(path.join(home, ".codexhost", "mapping-store", "threads"))).toHaveLength(2);
    expect(importLegacyCodexHostData({}, { home }).reason).toBe("already-imported");
  });

  it("never overwrites files that already exist in the new data directory", () => {
    const home = makeHome();
    const history = path.join(home, ".rly0-hub", "antigravity-history");
    mkdirSync(history, { recursive: true });
    writeFileSync(path.join(history, "h.json"), "mine");
    expect(importLegacyCodexHostData({}, { home }).imported).toBe(true);
    expect(readFileSync(path.join(history, "h.json"), "utf8")).toBe("mine");
  });

  it("skips when the new store already has threads", () => {
    const home = makeHome();
    const threads = path.join(home, ".rly0-hub", "mapping-store", "threads");
    mkdirSync(threads, { recursive: true });
    writeFileSync(path.join(threads, "z.json"), "{}");
    expect(importLegacyCodexHostData({}, { home }).reason).toBe("target-has-threads");
    expect(readdirSync(threads)).toEqual(["z.json"]);
  });

  it("skips for a custom data directory, when disabled, or without legacy data", () => {
    const home = makeHome();
    expect(importLegacyCodexHostData({ CODEXHOST_DATA_DIR: "/x" }, { home }).reason).toBe(
      "custom-data-dir",
    );
    expect(importLegacyCodexHostData({ RLY0_SKIP_LEGACY_IMPORT: "1" }, { home }).reason).toBe(
      "disabled",
    );
    const empty = mkdtempSync(path.join(os.tmpdir(), "rly0-legacy-empty-"));
    expect(importLegacyCodexHostData({}, { home: empty }).reason).toBe("no-legacy-threads");
  });
});
