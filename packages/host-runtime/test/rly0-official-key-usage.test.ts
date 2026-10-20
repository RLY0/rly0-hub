import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Rly0Relay } from "@codexhost/shared-contracts";
import { Rly0OfficialKeyUsage } from "../src/rly0-relay/official-key-usage.js";
import type { Rly0CoreBridge } from "../src/rly0-core/index.js";
import { Rly0HubService } from "../src/rly0-hub-service/service.js";
const usage = (fetchedAt = 1000) => ({
  windows: [{ kind: "primary", usedPercent: 40 }],
  fetchedAt,
  source: "live",
});
const relay = (id = "aaaaaaaaaaaa", revision = "a".repeat(64)): Rly0Relay => ({
  id,
  name: "same name",
  protocol: "responses",
  baseUrl: "https://api.anthropic.com",
  models: [],
  enabled: true,
  hasKey: true,
  keyMask: "****same",
  keyRevision: revision,
});

describe("SYNTHETIC persisted official-key quota", () => {
  it("rechecks credential revision after cache IO before returning a live result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-quota-final-revision-"));
    let reads = 0;
    const core = {
      listRelays: async () => ({
        available: true,
        relays: [relay("aaaaaaaaaaaa", ++reads >= 3 ? "b".repeat(64) : "a".repeat(64))],
      }),
      claudeAccounts: async () => ({ kind: "subscription", usage: usage() }),
      dispose: async () => {},
    } as unknown as Rly0CoreBridge;
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      core,
      backendReloadTimeoutMs: 25,
    });
    try {
      await expect(
        service.handle("agents.officialKeys.info", { vendor: "anthropic", id: "aaaaaaaaaaaa" }),
      ).rejects.toThrow("OFFICIAL_KEY_CHANGED");
      expect(reads).toBe(3);
      const store = new Rly0OfficialKeyUsage({ CODEXHOST_DATA_DIR: root });
      expect(
        store.forRelay(relay("aaaaaaaaaaaa", "b".repeat(64)), await store.read()),
      ).toBeUndefined();
    } finally {
      await service.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("attaches a persisted quota to the first list without a live query, and rejects a changed key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-quota-service-"));
    const environment = { CODEXHOST_DATA_DIR: root };
    let current = relay();
    let resolveInfo: (value: Record<string, unknown>) => void = () => {};
    let signalStarted = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const pendingInfo = new Promise<Record<string, unknown>>((resolve) => {
      resolveInfo = resolve;
    });
    let queries = 0;
    const core = {
      listRelays: async () => ({ available: true, relays: [{ ...current }] }),
      claudeAccounts: async () => {
        ++queries;
        signalStarted();
        return pendingInfo;
      },
      dispose: async () => {},
    } as unknown as Rly0CoreBridge;
    const service = new Rly0HubService({
      environment,
      installRoot: root,
      core,
      backendReloadTimeoutMs: 25,
    });
    try {
      await new Rly0OfficialKeyUsage(environment).record(current, {
        kind: "subscription",
        usage: usage(),
      });
      await expect(service.handle("agents.officialKeys.list", {})).resolves.toMatchObject({
        keys: [{ id: current.id, lastUsage: { fetchedAt: 1000, source: "snapshot" } }],
      });
      expect(queries).toBe(0);
      const refresh = service.handle("agents.officialKeys.info", {
        vendor: "anthropic",
        id: current.id,
      });
      const rejected = expect(refresh).rejects.toThrow("OFFICIAL_KEY_CHANGED");
      await started;
      current = { ...current, keyRevision: "b".repeat(64) };
      resolveInfo({ kind: "subscription", usage: usage(2000) });
      await rejected;
      const list = await service.handle("agents.officialKeys.list", {});
      expect(JSON.stringify(list)).not.toContain("lastUsage");
    } finally {
      await service.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not let an older late response replace a newer successful snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-quota-order-"));
    const environment = { CODEXHOST_DATA_DIR: root };
    let resolveOld: (value: Record<string, unknown>) => void = () => {};
    let signalStarted = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const old = new Promise<Record<string, unknown>>((resolve) => {
      resolveOld = resolve;
    });
    let count = 0;
    const core = {
      listRelays: async () => ({ available: true, relays: [relay()] }),
      claudeAccounts: async () => {
        if (++count === 1) {
          signalStarted();
          return old;
        }
        return { kind: "subscription", usage: usage(3000) };
      },
      dispose: async () => {},
    } as unknown as Rly0CoreBridge;
    const service = new Rly0HubService({
      environment,
      installRoot: root,
      core,
      backendReloadTimeoutMs: 25,
    });
    try {
      const first = service.handle("agents.officialKeys.info", {
        vendor: "anthropic",
        id: relay().id,
      });
      await started;
      await service.handle("agents.officialKeys.info", { vendor: "anthropic", id: relay().id });
      resolveOld({ kind: "subscription", usage: usage(1000) });
      await first;
      const store = new Rly0OfficialKeyUsage(environment);
      expect(store.forRelay(relay(), await store.read())?.usage.fetchedAt).toBe(3000);
    } finally {
      await service.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("survives a new store, preserves time, and stores no profile or raw secrets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-quota-cache-"));
    try {
      const env = { CODEXHOST_DATA_DIR: root };
      const store = new Rly0OfficialKeyUsage(env);
      expect(
        await store.record(relay(), {
          kind: "subscription",
          usage: usage(),
          apiKey: "SYNTHETIC_SECRET",
          email: "private@example.test",
          profile: { token: "SYNTHETIC_SECRET" },
        }),
      ).toBe(true);
      const reopened = new Rly0OfficialKeyUsage(env);
      expect(reopened.forRelay(relay(), await reopened.read())?.usage).toEqual({
        ...usage(),
        source: "snapshot",
      });
      const text = await fs.readFile(
        path.join(root, "quota-cache", "official-key-usage.json"),
        "utf8",
      );
      expect(text).not.toMatch(/SYNTHETIC_SECRET|private@example|profile|apiKey/u);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("binds vendor, id and encrypted revision; names and masks never establish identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-quota-cache-"));
    try {
      const store = new Rly0OfficialKeyUsage({ CODEXHOST_DATA_DIR: root });
      await store.record(relay(), { kind: "subscription", usage: usage() });
      const cached = await store.read();
      expect(store.forRelay({ ...relay(), name: "renamed" }, cached)?.usage).toBeDefined();
      for (const changed of [
        relay("bbbbbbbbbbbb"),
        relay("aaaaaaaaaaaa", "b".repeat(64)),
        { ...relay(), hasKey: false },
        { ...relay(), baseUrl: "https://api.x.ai/v1" },
      ])
        expect(store.forRelay(changed, cached)).toBeUndefined();
      const legacy = relay();
      delete legacy.keyRevision;
      expect(store.forRelay(legacy, cached)).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retains parallel credentials, refuses older time, and invalidates only the matching revision", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-quota-cache-"));
    try {
      const store = new Rly0OfficialKeyUsage({ CODEXHOST_DATA_DIR: root });
      await Promise.all([
        store.record(relay(), { kind: "subscription", usage: usage(2000) }),
        store.record(relay("bbbbbbbbbbbb"), { kind: "subscription", usage: usage(3000) }),
      ]);
      await store.record(relay(), { kind: "subscription", usage: usage(1000) });
      expect(store.forRelay(relay(), await store.read())?.usage.fetchedAt).toBe(2000);
      const replacement = relay("aaaaaaaaaaaa", "b".repeat(64));
      await store.record(replacement, { kind: "subscription", usage: usage(4000) });
      await store.record(relay(), { valid: false });
      const cached = await store.read();
      expect(store.forRelay(relay(), cached)).toBeUndefined();
      expect(store.forRelay(replacement, cached)?.usage.fetchedAt).toBe(4000);
      expect(store.forRelay(relay("bbbbbbbbbbbb"), cached)?.usage.fetchedAt).toBe(3000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats corrupt cache as unknown and reports a failed save", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-quota-cache-"));
    try {
      const store = new Rly0OfficialKeyUsage({ CODEXHOST_DATA_DIR: root });
      await fs.mkdir(path.join(root, "quota-cache"));
      await fs.writeFile(path.join(root, "quota-cache", "official-key-usage.json"), "broken");
      expect((await store.read()).size).toBe(0);
      const blocked = path.join(root, "file-not-directory");
      await fs.writeFile(blocked, "");
      expect(
        await new Rly0OfficialKeyUsage({ CODEXHOST_DATA_DIR: blocked }).record(relay(), {
          kind: "subscription",
          usage: usage(),
        }),
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
