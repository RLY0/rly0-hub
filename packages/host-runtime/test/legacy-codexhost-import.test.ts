import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  harnessModelRefIdSchema,
  harnessThinkingOptionIdSchema,
  harnessPermissionModeIdSchema,
  encodeHarnessPluginRoute,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  importLegacyCodexHostData,
  NATIVE_ROUTE_HARNESS_IDS,
  planLegacyCodexHostSync,
} from "../src/legacy-codexhost-import.js";
import { ChatRepair } from "../src/rly0-maintenance/chat-repair.js";
import { canonicalTransportModelId as canonicalize } from "../src/legacy-transport-canonical.js";
import { EXTERNAL_HARNESS_IDS } from "@codexhost/protocol-core";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

const record = (id: string, updatedAt: string, title = id) =>
  JSON.stringify({
    hostThreadId: id,
    updatedAt,
    title,
    harnessId: harnessIdSchema.parse("claude-code"),
  });

function makeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "rly0-legacy-import-"));
  const legacy = path.join(home, ".codexhost", "mapping-store");
  mkdirSync(path.join(legacy, "threads"), { recursive: true });
  mkdirSync(path.join(legacy, "backups"), { recursive: true });
  writeFileSync(path.join(legacy, "threads", `${A}.json`), record(A, "2026-10-01T00:00:00.000Z"));
  writeFileSync(path.join(legacy, "threads", `${B}.json`), record(B, "2026-10-02T00:00:00.000Z"));
  writeFileSync(path.join(legacy, "backups", `${A}.json`), record(A, "2026-10-01T00:00:00.000Z"));
  writeFileSync(path.join(legacy, "store.lock"), '{"pid":1}');
  mkdirSync(path.join(home, ".codexhost", "antigravity-history"), { recursive: true });
  writeFileSync(path.join(home, ".codexhost", "antigravity-history", "h.json"), "legacy");
  return home;
}

const target = (home: string, ...parts: string[]) =>
  path.join(home, ".rly0-hub", "mapping-store", ...parts);
const legacyThread = (home: string, id: string) =>
  path.join(home, ".codexhost", "mapping-store", "threads", `${id}.json`);

describe("importLegacyCodexHostData", () => {
  it("preserves a modern selection when native repair cannot represent its thinking option", () => {
    const modern = encodeHarnessPluginRoute({
      harnessId: harnessIdSchema.parse("deepseek-harness"),
      model: { id: harnessModelRefIdSchema.parse("synthetic-model") },
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("medium"),
    });
    expect(canonicalize("deepseek-harness", modern)).toBeNull();
    expect(canonicalize("claude-code", modern)).toBeNull();
  });
  it("copies thread mappings, leaving the legacy directory untouched", () => {
    const home = makeHome();
    expect(importLegacyCodexHostData({}, { home })).toEqual({
      imported: true,
      reason: "imported",
      threads: 2,
    });
    expect(readdirSync(target(home, "threads")).sort()).toEqual([`${A}.json`, `${B}.json`]);
    expect(existsSync(target(home, "backups", `${A}.json`))).toBe(true);
    expect(existsSync(target(home, "store.lock"))).toBe(false);
    expect(readdirSync(path.join(home, ".codexhost", "mapping-store", "threads"))).toHaveLength(2);
    expect(importLegacyCodexHostData({}, { home }).reason).toBe("up-to-date");
  });

  it("brings over chats started under CodexHost after an earlier import", () => {
    const home = makeHome();
    // The 0.11.x one-time import already ran and left its v1 marker; ours has A only.
    mkdirSync(target(home, "threads"), { recursive: true });
    writeFileSync(target(home, "threads", `${A}.json`), record(A, "2026-10-01T00:00:00.000Z"));
    writeFileSync(target(home, ".legacy-codexhost-import.json"), '{"importedAt":"x","threads":1}');
    expect(planLegacyCodexHostSync({}, { home }).candidates.map((c) => [c.id, c.issue])).toEqual([
      [B, "missing"],
    ]);
    expect(importLegacyCodexHostData({}, { home })).toMatchObject({ imported: true, threads: 1 });
    expect(existsSync(target(home, "threads", `${B}.json`))).toBe(true);
    expect(planLegacyCodexHostSync({}, { home }).candidates).toEqual([]);
  });

  it("takes a newer legacy copy and keeps the replaced one", () => {
    const home = makeHome();
    importLegacyCodexHostData({}, { home });
    writeFileSync(legacyThread(home, A), record(A, "2026-10-05T00:00:00.000Z", "continued"));
    expect(planLegacyCodexHostSync({}, { home }).candidates[0]).toMatchObject({
      id: A,
      issue: "outdated",
      title: "continued",
    });
    importLegacyCodexHostData({}, { home, now: () => new Date(1000) });
    expect(JSON.parse(readFileSync(target(home, "threads", `${A}.json`), "utf8")).title).toBe(
      "continued",
    );
    expect(readdirSync(target(home, "legacy-superseded"))).toEqual([`${A}.1000.json`]);
  });

  it("never replaces a thread the Hub has newer", () => {
    const home = makeHome();
    mkdirSync(target(home, "threads"), { recursive: true });
    const ours = record(A, "2026-10-09T00:00:00.000Z", "mine");
    writeFileSync(target(home, "threads", `${A}.json`), ours);
    importLegacyCodexHostData({}, { home });
    expect(readFileSync(target(home, "threads", `${A}.json`), "utf8")).toBe(ours);
  });

  it("keeps a thread deleted in the Hub deleted unless asked", () => {
    const home = makeHome();
    importLegacyCodexHostData({}, { home });
    rmSync(target(home, "threads", `${A}.json`));
    expect(importLegacyCodexHostData({}, { home }).reason).toBe("up-to-date");
    expect(planLegacyCodexHostSync({}, { home }).candidates).toMatchObject([
      { id: A, issue: "deleted" },
    ]);
    expect(importLegacyCodexHostData({}, { home, includeDeleted: true }).threads).toBe(1);
    expect(existsSync(target(home, "threads", `${A}.json`))).toBe(true);
  });

  it("re-encodes upstream's generic model route so the chat can be continued", () => {
    const home = makeHome();
    const upstream = encodeHarnessPluginRoute({
      harnessId: harnessIdSchema.parse("claude-code"),
      model: { id: harnessModelRefIdSchema.parse("claude-model-v1.b3B1cw") },
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("medium"),
      permissionModeId: harnessPermissionModeIdSchema.parse("bypassPermissions"),
    });
    const withRoute = (id: string, updatedAt: string) =>
      JSON.stringify({ ...JSON.parse(record(id, updatedAt)), transportModelId: upstream });
    writeFileSync(legacyThread(home, A), withRoute(A, "2026-10-01T00:00:00.000Z"));
    writeFileSync(
      path.join(home, ".codexhost", "mapping-store", "backups", `${A}.json`),
      withRoute(A, "2026-10-01T00:00:00.000Z"),
    );
    // B was imported by an older Hub as-is.
    mkdirSync(target(home, "threads"), { recursive: true });
    writeFileSync(target(home, "threads", `${B}.json`), withRoute(B, "2026-10-02T00:00:00.000Z"));
    expect(planLegacyCodexHostSync({}, { home }).candidates.map((c) => [c.id, c.issue])).toEqual([
      [B, "format"],
      [A, "missing"],
    ]);

    // The Hub window's service has no encoders: it brings A over and leaves both for Codex.
    expect(importLegacyCodexHostData({}, { home }).threads).toBe(1);
    expect(planLegacyCodexHostSync({}, { home }).candidates.map((c) => c.issue)).toEqual([
      "format",
      "format",
    ]);
    // Codex's backend opens the store with them.
    expect(importLegacyCodexHostData({}, { home, canonicalize }).threads).toBe(2);
    const native = "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@medium";
    for (const file of [
      target(home, "threads", `${A}.json`),
      target(home, "backups", `${A}.json`),
      target(home, "threads", `${B}.json`),
    ]) {
      const value = JSON.parse(readFileSync(file, "utf8"));
      expect(value.transportModelId).toBe(native);
      expect(value.title).toBeTruthy(); // nothing else is lost
    }
    expect(planLegacyCodexHostSync({}, { home }).candidates).toEqual([]);
    // The legacy directory is still only read.
    expect(JSON.parse(readFileSync(legacyThread(home, A), "utf8")).transportModelId).toBe(upstream);
  });

  it("leaves plugin agents' routes alone (that is their canonical form)", () => {
    const home = makeHome();
    const hermes = encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("hermes") });
    writeFileSync(
      legacyThread(home, A),
      JSON.stringify({
        ...JSON.parse(record(A, "2026-10-01T00:00:00.000Z")),
        harnessId: harnessIdSchema.parse("hermes"),
        transportModelId: hermes,
      }),
    );
    importLegacyCodexHostData({}, { home, canonicalize });
    expect(
      JSON.parse(readFileSync(target(home, "threads", `${A}.json`), "utf8")).transportModelId,
    ).toBe(hermes);
    expect(planLegacyCodexHostSync({}, { home }).candidates).toEqual([]);
  });

  it("knows the same agents with their own model-route form as protocol-core", () => {
    expect([...NATIVE_ROUTE_HARNESS_IDS].sort()).toEqual([...EXTERNAL_HARNESS_IDS].sort());
  });

  it("still fixes chats brought over earlier once the old CodexHost is gone", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "rly0-legacy-gone-"));
    mkdirSync(target(home, "threads"), { recursive: true });
    const upstream = encodeHarnessPluginRoute({
      harnessId: harnessIdSchema.parse("claude-code"),
      model: { id: harnessModelRefIdSchema.parse("claude-model-v1.b3B1cw") },
    });
    writeFileSync(
      target(home, "threads", `${A}.json`),
      JSON.stringify({
        ...JSON.parse(record(A, "2026-10-01T00:00:00.000Z")),
        transportModelId: upstream,
      }),
    );
    expect(planLegacyCodexHostSync({}, { home }).candidates).toMatchObject([
      { id: A, issue: "format" },
    ]);
    expect(importLegacyCodexHostData({}, { home, canonicalize }).threads).toBe(1);
    expect(
      JSON.parse(readFileSync(target(home, "threads", `${A}.json`), "utf8")).transportModelId,
    ).toBe("codexhost/claude-code-native@claude-model-v1.b3B1cw");
  });

  it("never overwrites files that already exist in the new data directory", () => {
    const home = makeHome();
    const history = path.join(home, ".rly0-hub", "antigravity-history");
    mkdirSync(history, { recursive: true });
    writeFileSync(path.join(history, "h.json"), "mine");
    expect(importLegacyCodexHostData({}, { home }).imported).toBe(true);
    expect(readFileSync(path.join(history, "h.json"), "utf8")).toBe("mine");
  });

  it("ignores legacy files that are not thread records", () => {
    const home = makeHome();
    writeFileSync(legacyThread(home, "cccccccc"), '{"id":"c"}');
    expect(importLegacyCodexHostData({}, { home }).threads).toBe(2);
    expect(existsSync(target(home, "threads", "cccccccc.json"))).toBe(false);
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
    expect(planLegacyCodexHostSync({}, { home: empty }).available).toBe(false);
  });
});

describe("ChatRepair", () => {
  function codex(runningChecks: number) {
    const calls: string[] = [];
    let left = runningChecks;
    return {
      calls,
      control: {
        status: async () => ({ running: left-- > 0 }),
        forceQuit: async () => {
          calls.push("quit");
          return { ok: true };
        },
        open: async () => {
          calls.push("open");
          return { ok: true };
        },
      },
    };
  }

  it("scans without writing anything", async () => {
    const home = makeHome();
    const repair = new ChatRepair({ environment: {}, home, codex: codex(0).control });
    expect(await repair.scan()).toMatchObject({ available: true, broken: 2, deleted: 0 });
    expect(existsSync(target(home, "threads"))).toBe(false);
  });

  it("closes Codex, merges, then opens it again", async () => {
    const home = makeHome();
    const c = codex(2); // running at first, still closing once, then gone
    const repair = new ChatRepair({
      environment: {},
      home,
      codex: c.control,
      sleep: async () => undefined,
    });
    const result = await repair.repair();
    expect(result).toMatchObject({
      ok: true,
      repaired: 2,
      codexRestarted: true,
      reopenFailed: false,
      fixedOnCodexStart: 0,
    });
    expect(c.calls).toEqual(["quit", "open"]);
    expect((await repair.scan()).broken).toBe(0);
  });

  it("does not touch Codex when it is closed", async () => {
    const home = makeHome();
    const c = codex(0);
    const repair = new ChatRepair({ environment: {}, home, codex: c.control });
    expect((await repair.repair()).repaired).toBe(2);
    expect(c.calls).toEqual([]);
  });

  it("writes nothing while Codex refuses to close", async () => {
    const home = makeHome();
    const c = codex(Number.POSITIVE_INFINITY);
    const repair = new ChatRepair({
      environment: {},
      home,
      codex: c.control,
      sleep: async () => undefined,
      quitTimeoutMs: 0,
    });
    expect(await repair.repair()).toMatchObject({ ok: false, reason: "CODEX_STILL_RUNNING" });
    expect(existsSync(target(home, "threads"))).toBe(false);
  });
});
