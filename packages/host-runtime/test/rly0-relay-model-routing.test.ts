import { describe, expect, it } from "vitest";

import type { Rly0ProxyStatusResult, Rly0RelayListResult } from "@codexhost/shared-contracts";

import { Rly0RelayModelRouter } from "../src/rly0-relay/model-routing.js";

function fakeCore(options: { running?: boolean } = {}) {
  const calls: string[] = [];
  let running = options.running ?? false;
  const runningStatus = (): Rly0ProxyStatusResult => ({
    available: true,
    running: true,
    port: 25817,
    baseUrl: "http://127.0.0.1:25817/v1",
    requests: 0,
    routed: 0,
    unrouted: 0,
    failed: 0,
    recent: [],
  });
  return {
    calls,
    core: {
      async listRelays(): Promise<Rly0RelayListResult> {
        calls.push("list");
        return {
          available: true,
          relays: [
            {
              id: "r1",
              name: "My relay",
              baseUrl: "https://relay.example/v1",
              protocol: "responses",
              models: ["gpt-relay-1", "gpt-5.5", "o9-*", "claude-opus-5", "deepseek-*"],
              enabled: true,
              hasKey: true,
            },
            {
              id: "r2",
              name: "Off",
              baseUrl: "https://off.example/v1",
              protocol: "responses",
              models: ["hidden-model"],
              enabled: false,
              hasKey: true,
            },
          ],
        };
      },
      async proxyStatus(): Promise<Rly0ProxyStatusResult> {
        calls.push("status");
        return running ? runningStatus() : { available: true, running: false, defaultPort: 25817 };
      },
      async proxyStart(): Promise<Rly0ProxyStatusResult> {
        calls.push("start");
        running = true;
        return runningStatus();
      },
    },
  };
}

const officialList = {
  id: 7,
  result: {
    data: [
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Official",
        hidden: false,
        isDefault: true,
        upgrade: "gpt-6",
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
        defaultReasoningEffort: "medium",
      },
    ],
    nextCursor: null,
  },
};

describe("RLY/0 relay model routing", () => {
  it("routes explicit same-name choices while retaining the official model", async () => {
    const { core } = fakeCore();
    const router = new Rly0RelayModelRouter(core);
    await router.prepareModelList();
    router.rewriteModelListResponse(officialList);
    expect(await router.rewriteThreadParams({ model: "rly0/r1/gpt-5.5" })).toMatchObject({
      model: "rly0/r1/gpt-5.5",
      modelProvider: "rly0",
    });
    expect(await router.rewriteThreadParams({ model: "gpt-5.5" })).toBeNull();
    await expect(router.isRelayModel("rly0/missing/gpt-5.5")).rejects.toThrow(
      "RELAY_MODEL_NOT_AVAILABLE",
    );
    await expect(router.isRelayModel("rly0/r1/claude-opus-5")).rejects.toThrow(
      "RELAY_MODEL_NOT_AVAILABLE",
    );
    expect(await router.isOfficialModel("gpt-5.5")).toBe(true);
  });
  it("adds enabled relay models to model/list without shadowing official ones", async () => {
    const { core } = fakeCore();
    const router = new Rly0RelayModelRouter(core);
    await router.prepareModelList();
    const rewritten = router.rewriteModelListResponse(officialList) as typeof officialList;
    const models = rewritten.result.data.map((entry) => entry.model);
    expect(models).toEqual(["gpt-5.5", "rly0/r1/gpt-relay-1", "rly0/r1/gpt-5.5"]);
    const added = rewritten.result.data[1] as Record<string, unknown>;
    expect(added).toMatchObject({
      id: "rly0/r1/gpt-relay-1",
      displayName: "My relay · gpt-relay-1",
      description: "My relay · RLY/0",
      isDefault: false,
      hidden: false,
      defaultReasoningEffort: "medium",
    });
    expect(added.upgrade).toBeUndefined();
    // Official names stay official even though the relay lists them too.
    expect(await router.isRelayModel("gpt-5.5")).toBe(false);
    expect(await router.isRelayModel("o9-mini")).toBe(false);
    // Other model families never run in Codex, even when a relay offers them.
    expect(await router.isRelayModel("deepseek-v4")).toBe(false);
    expect(await router.isRelayModel("claude-opus-5")).toBe(false);
    expect(await router.isRelayModel("hidden-model")).toBe(false);
  });

  it("moves relay-model threads onto the local proxy and starts it when needed", async () => {
    const { core, calls } = fakeCore();
    const router = new Rly0RelayModelRouter(core);
    const next = await router.rewriteThreadParams({ model: "rly0/r1/gpt-relay-1", cwd: "x" });
    expect(calls).toContain("start");
    expect(next).toMatchObject({
      model: "rly0/r1/gpt-relay-1",
      cwd: "x",
      modelProvider: "rly0",
      config: {
        "model_providers.rly0": {
          base_url: "http://127.0.0.1:25817/v1",
          wire_api: "responses",
          requires_openai_auth: true,
        },
      },
    });
    router.rewriteModelListResponse(officialList);
    expect(await router.rewriteThreadParams({ model: "gpt-5.5" })).toBeNull();
  });

  it("matches no-account mode: the per-thread provider then asks for no login", async () => {
    const { core } = fakeCore();
    const router = new Rly0RelayModelRouter(core, {
      providerRequiresOpenaiAuth: async () => false,
    });
    const next = await router.rewriteThreadParams({ model: "rly0/r1/gpt-relay-1" });
    expect(next).toMatchObject({
      config: { "model_providers.rly0": { requires_openai_auth: false } },
    });
    const failing = new Rly0RelayModelRouter(core, {
      providerRequiresOpenaiAuth: async () => {
        throw new Error("unreadable");
      },
    });
    // When the mode cannot be read, keep the normal (login) definition.
    expect(await failing.rewriteThreadParams({ model: "rly0/r1/gpt-relay-1" })).toMatchObject({
      config: { "model_providers.rly0": { requires_openai_auth: true } },
    });
  });

  it("defines the provider on model-less resumes and tracks thread providers", async () => {
    const { core, calls } = fakeCore();
    const router = new Rly0RelayModelRouter(core);
    const resumed = await router.rewriteThreadParams({ threadId: "t1" });
    expect(resumed).not.toHaveProperty("modelProvider");
    expect(resumed).toHaveProperty(["config", "model_providers.rly0"]);
    // The provider always points at RLY/0 Hub's own proxy, started if needed, never a guessed port.
    expect(calls).toContain("start");
    router.observeResponse({ id: 1, result: { thread: { id: "t1" }, modelProvider: "rly0" } });
    expect(router.threadProvider("t1")).toBe("rly0");
  });

  it("forwards every official entry unchanged and only appends relay models", async () => {
    const { core } = fakeCore();
    const router = new Rly0RelayModelRouter(core);
    await router.prepareModelList();
    const official = {
      id: 9,
      result: {
        data: [
          { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "Luna", isDefault: true, extra: 1 },
          { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", hidden: true },
          { id: "gpt-relay-1", model: "gpt-relay-1", displayName: "Official Opus" },
        ],
        nextCursor: null,
      },
    };
    const snapshot = structuredClone(official);
    // Official rows are unchanged; each relay has its own independent selector.
    const rewritten = router.rewriteModelListResponse(official) as typeof official;
    expect(rewritten.result.data.slice(0, 3)).toEqual(snapshot.result.data);
    expect(rewritten.result.data.slice(3).map((row) => row.model)).toEqual([
      "rly0/r1/gpt-relay-1",
      "rly0/r1/gpt-5.5",
    ]);
    expect(official).toEqual(snapshot);
    expect(await router.isRelayModel("gpt-relay-1")).toBe(false);
  });

  it("forwards an official model/list error untouched instead of a substitute catalog", async () => {
    const { core } = fakeCore();
    const router = new Rly0RelayModelRouter(core);
    await router.prepareModelList();
    const failed = { id: 3, error: { code: -32000, message: "upstream unavailable" } };
    expect(router.rewriteModelListResponse(failed)).toBeNull();
  });

  it("only appends on the last page and keeps earlier pages' official names", async () => {
    const { core } = fakeCore();
    const router = new Rly0RelayModelRouter(core);
    await router.prepareModelList();
    const page1 = {
      id: 1,
      result: { data: [{ id: "gpt-relay-1", model: "gpt-relay-1" }], nextCursor: "p2" },
    };
    expect(router.rewriteModelListResponse(page1)).toBeNull();
    const page2 = {
      id: 2,
      result: { data: [{ id: "gpt-6", model: "gpt-6" }], nextCursor: null },
    };
    const rewritten = router.rewriteModelListResponse(page2) as {
      result: { data: { model: string }[] };
    };
    expect(rewritten.result.data.map((entry) => entry.model)).toEqual([
      "gpt-6",
      "rly0/r1/gpt-relay-1",
      "rly0/r1/gpt-5.5",
    ]);
  });

  it("never takes ownership of bare names even before model/list has been seen", async () => {
    const { core, calls } = fakeCore();
    let reads = 0;
    const router = new Rly0RelayModelRouter(core, {
      loadOfficialModels: async () => {
        reads += 1;
        return { names: ["gpt-5.5"], count: 1 };
      },
    });
    // The relay lists gpt-5.5 too, but it is official: the thread must stay on the account.
    expect(await router.rewriteThreadParams({ model: "gpt-5.5" })).toBeNull();
    expect(calls).not.toContain("start");
    expect(await router.isRelayModel("gpt-relay-1")).toBe(false);
    expect(reads).toBe(0);
    // Unlisted names never trigger an official read.
    expect(await router.isRelayModel("not-a-relay-model")).toBe(false);
    expect(reads).toBe(0);
  });

  it("keeps explicit relay choices usable without guessing bare names when the catalog fails", async () => {
    const { core } = fakeCore();
    let reads = 0;
    const router = new Rly0RelayModelRouter(core, {
      loadOfficialModels: async () => {
        reads += 1;
        throw new Error("official runtime down");
      },
    });
    expect(await router.isRelayModel("rly0/r1/gpt-relay-1")).toBe(true);
    expect(await router.isRelayModel("gpt-relay-1")).toBe(false);
    // A failed read is not retried on every turn.
    expect(await router.isRelayModel("gpt-relay-1")).toBe(false);
    expect(reads).toBe(0);
  });

  it("reports where the picker comes from: Codex's live list, then Hub refreshes", async () => {
    const { core } = fakeCore();
    let now = 1_000;
    let fail = false;
    const router = new Rly0RelayModelRouter(core, {
      now: () => now,
      loadOfficialModels: async () => {
        if (fail) throw new Error("OFFICIAL_CATALOG_FAILED");
        return { names: ["gpt-6", "gpt-relay-1"], count: 2 };
      },
    });
    expect(await router.catalogStatus()).toEqual({
      official: null,
      appended: ["rly0/r1/gpt-relay-1", "rly0/r1/gpt-5.5"],
      shadowed: [],
      delegated: ["claude-opus-5"],
    });

    await router.prepareModelList();
    router.rewriteModelListResponse({
      id: 1,
      result: {
        data: [
          { id: "a", model: "a" },
          { id: "b", model: "b" },
        ],
        nextCursor: "p2",
      },
    });
    now = 2_000;
    router.rewriteModelListResponse(officialList);
    expect(await router.catalogStatus()).toMatchObject({
      official: { fetchedAt: 2_000, count: 3, via: "codex" },
      appended: ["rly0/r1/gpt-relay-1", "rly0/r1/gpt-5.5"],
      shadowed: [],
    });

    now = 3_000;
    const refreshed = await router.catalogStatus(true);
    expect(refreshed).toMatchObject({
      official: { fetchedAt: 3_000, count: 2, via: "hub" },
      appended: ["rly0/r1/gpt-relay-1", "rly0/r1/gpt-5.5"],
      shadowed: [],
    });
    expect(refreshed).not.toHaveProperty("lastError");

    fail = true;
    now = 4_000;
    const failed = await router.catalogStatus(true);
    // The last good read stays visible next to the failure; nothing is invented.
    expect(failed).toMatchObject({
      official: { fetchedAt: 3_000, via: "hub" },
      lastError: { at: 4_000, message: "OFFICIAL_CATALOG_FAILED" },
    });
  });

  it("moves to the next free port when another tool holds the preferred one", async () => {
    const tried: number[] = [];
    const router = new Rly0RelayModelRouter({
      ...fakeCore().core,
      async proxyStatus() {
        return { available: true, running: false, defaultPort: 25917 };
      },
      async proxyStart({ port }: { port?: number }) {
        tried.push(port ?? 0);
        if (port === 25917 || port === 25918) throw new Error("PROXY_PORT_IN_USE");
        return {
          available: true,
          running: true,
          port: port ?? 0,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          requests: 0,
          routed: 0,
          unrouted: 0,
          failed: 0,
          recent: [],
        };
      },
    });
    expect(await router.ensureProxy()).toBe("http://127.0.0.1:25919/v1");
    expect(tried).toEqual([25917, 25918, 25919]);
  });

  it("does not route a model-less resume anywhere when its own proxy cannot start", async () => {
    const router = new Rly0RelayModelRouter({
      ...fakeCore().core,
      async proxyStatus() {
        return { available: true, running: false, defaultPort: 25917 };
      },
      async proxyStart() {
        throw new Error("PROXY_PORT_IN_USE");
      },
    });
    expect(await router.rewriteThreadParams({ threadId: "t1" })).toBeNull();
    await expect(router.rewriteThreadParams({ model: "rly0/r1/gpt-relay-1" })).rejects.toThrow(
      "RLY0_PROXY_UNAVAILABLE",
    );
  });

  describe("no-account mode", () => {
    const pagedOfficial = (cursor: string | null, ids: string[]) => ({
      id: 11,
      result: {
        data: ids.map((id, index) => ({
          id,
          model: id,
          displayName: id.toUpperCase(),
          isDefault: index === 0,
          defaultReasoningEffort: "medium",
        })),
        nextCursor: cursor,
      },
    });

    it("lists only relay models, grouped by relay, with the configured default", async () => {
      const { core } = fakeCore();
      const router = new Rly0RelayModelRouter(core, {
        noAccountMode: async () => ({ model: "gpt-5.5" }),
      });
      await router.prepareModelList();
      // Earlier pages lose their official rows but keep paging.
      const first = router.rewriteModelListResponse(pagedOfficial("p2", ["gpt-6-astra"]));
      expect(first).toMatchObject({ result: { data: [], nextCursor: "p2" } });
      const last = router.rewriteModelListResponse(
        pagedOfficial(null, ["gpt-6.1-sol", "gpt-5.5"]),
      ) as { result: { data: Record<string, unknown>[] } };
      expect(last.result.data.map((row) => [row.id, row.displayName, row.isDefault])).toEqual([
        ["rly0/r1/gpt-relay-1", "My relay · gpt-relay-1", false],
        ["rly0/r1/gpt-5.5", "My relay · gpt-5.5", true],
      ]);
      // Official names are still known as official for later decisions.
      expect(await router.isOfficialModel("gpt-6-astra")).toBe(true);
    });

    it("moves official names onto the same relay model, else the configured default", async () => {
      const { core } = fakeCore();
      const router = new Rly0RelayModelRouter(core, {
        providerRequiresOpenaiAuth: async () => false,
        noAccountMode: async () => ({ model: "gpt-relay-1" }),
      });
      expect(await router.rewriteThreadParams({ model: "gpt-5.5", cwd: "x" })).toMatchObject({
        model: "rly0/r1/gpt-5.5",
        modelProvider: "rly0",
        cwd: "x",
        config: { "model_providers.rly0": { requires_openai_auth: false } },
      });
      expect(await router.rewriteThreadParams({ model: "gpt-6-astra" })).toMatchObject({
        model: "rly0/r1/gpt-relay-1",
        modelProvider: "rly0",
      });
      expect(await router.migrateTurnParams({ threadId: "t", model: "gpt-6-astra" })).toEqual({
        threadId: "t",
        model: "rly0/r1/gpt-relay-1",
      });
      // Relay selectors and model-less turns stay as they are.
      expect(
        await router.migrateTurnParams({ threadId: "t", model: "rly0/r1/gpt-5.5" }),
      ).toBeNull();
      expect(await router.migrateTurnParams({ threadId: "t" })).toBeNull();
      // Desktop names the model in the collaboration mode (with `model: null`).
      expect(
        await router.migrateTurnParams({
          threadId: "t",
          model: null,
          collaborationMode: { mode: "default", settings: { model: "gpt-5.5" } },
        }),
      ).toEqual({
        threadId: "t",
        model: null,
        collaborationMode: { mode: "default", settings: { model: "rly0/r1/gpt-5.5" } },
      });
    });

    it("resumes an older Thread stored on another provider on the rly0 provider", async () => {
      const { core } = fakeCore();
      const router = new Rly0RelayModelRouter(core, {
        providerRequiresOpenaiAuth: async () => false,
        noAccountMode: async () => ({ model: "gpt-relay-1" }),
      });
      const reads: string[] = [];
      const stored = (provider: string, model?: string) => async (threadId: string) => {
        reads.push(threadId);
        return { provider, ...(model ? { model } : {}), status: "notLoaded" };
      };
      // Its own model when a relay offers it, else the configured default.
      expect(
        await router.rewriteResumeParams({ threadId: "a" }, stored("openai", "gpt-5.5")),
      ).toMatchObject({ threadId: "a", model: "rly0/r1/gpt-5.5", modelProvider: "rly0" });
      expect(
        await router.rewriteResumeParams({ threadId: "b", model: null }, stored("openai", "o3")),
      ).toMatchObject({ model: "rly0/r1/gpt-relay-1", modelProvider: "rly0" });
      // A Thread already on rly0 keeps its stored relay model.
      const kept = await router.rewriteResumeParams({ threadId: "c" }, stored("rly0"));
      expect(kept?.model).toBeUndefined();
      expect(kept?.modelProvider).toBeUndefined();
      // A known provider (from an earlier response) needs no read.
      router.observeResponse({ result: { thread: { id: "d", modelProvider: "openai" } } });
      expect(await router.rewriteResumeParams({ threadId: "d" }, stored("rly0"))).toMatchObject({
        model: "rly0/r1/gpt-relay-1",
        modelProvider: "rly0",
      });
      expect(reads).toEqual(["a", "b", "c"]);
      // An unreadable Thread is resumed as Desktop asked.
      expect(
        (await router.rewriteResumeParams({ threadId: "e" }, async () => undefined))?.modelProvider,
      ).toBeUndefined();
    });

    it("sends an official model back to the provider the Thread had before the relay", async () => {
      const { core } = fakeCore();
      const router = new Rly0RelayModelRouter(core, { noAccountMode: async () => null });
      router.observeResponse({ result: { data: [{ id: "x", modelProvider: "azure" }] } });
      router.observeResponse({ result: { thread: { id: "x", modelProvider: "rly0" } } });
      expect(
        await router.rewriteResumeParams(
          { threadId: "x", model: "gpt-5.5" },
          async () => undefined,
        ),
      ).toEqual({ threadId: "x", model: "gpt-5.5", modelProvider: "azure" });
      expect(
        await router.rewriteResumeParams({ threadId: "y", model: "gpt-5.5" }, async () => ({
          provider: "rly0",
        })),
      ).toEqual({ threadId: "y", model: "gpt-5.5", modelProvider: "openai" });
      // Not on rly0: nothing to undo.
      expect(
        await router.rewriteResumeParams({ threadId: "z", model: "gpt-5.5" }, async () => ({
          provider: "openai",
        })),
      ).toBeNull();
    });

    it("knows the model a turn runs with from the request, else the Thread's last choice", async () => {
      const router = new Rly0RelayModelRouter(fakeCore().core);
      router.observeResponse({
        result: { thread: { id: "t", modelProvider: "openai" }, model: "gpt-5.5" },
      });
      expect(router.turnModel("t", { model: null })).toBe("gpt-5.5");
      router.noteThreadModel("t", "rly0/r1/gpt-5.5");
      expect(router.turnModel("t", {})).toBe("rly0/r1/gpt-5.5");
      expect(
        router.turnModel("t", {
          model: "gpt-5.5",
          collaborationMode: { settings: { model: "rly0/r1/gpt-relay-1" } },
        }),
      ).toBe("rly0/r1/gpt-relay-1");
    });

    it("keeps official rows labelled when no relay model is available", async () => {
      const router = new Rly0RelayModelRouter(
        {
          ...fakeCore().core,
          async listRelays() {
            return { available: true, relays: [] };
          },
        },
        { noAccountMode: async () => ({}) },
      );
      await router.prepareModelList();
      const rewritten = router.rewriteModelListResponse(pagedOfficial(null, ["gpt-6-astra"])) as {
        result: { data: Record<string, unknown>[] };
      };
      expect(rewritten.result.data.map((row) => [row.id, row.displayName])).toEqual([
        ["gpt-6-astra", "GPT-6-ASTRA · 走零号中转"],
      ]);
      expect(await router.migrateTurnParams({ threadId: "t", model: "gpt-6-astra" })).toBeNull();
    });

    it("restores the original menu and routing exactly when the mode is off", async () => {
      let mode: { model?: string } | null = { model: "gpt-5.5" };
      const { core } = fakeCore();
      const router = new Rly0RelayModelRouter(core, { noAccountMode: async () => mode });
      await router.prepareModelList();
      router.rewriteModelListResponse(structuredClone(officialList));
      mode = null;
      await router.prepareModelList();
      const rewritten = router.rewriteModelListResponse(structuredClone(officialList)) as {
        result: { data: Record<string, unknown>[] };
      };
      expect(rewritten.result.data[0]).toEqual(officialList.result.data[0]);
      expect(rewritten.result.data.map((row) => row.model)).toEqual([
        "gpt-5.5",
        "rly0/r1/gpt-relay-1",
        "rly0/r1/gpt-5.5",
      ]);
      expect(await router.rewriteThreadParams({ model: "gpt-5.5" })).toBeNull();
      expect(await router.migrateTurnParams({ threadId: "t", model: "gpt-5.5" })).toBeNull();
    });

    it("treats an unreadable mode as off", async () => {
      const { core } = fakeCore();
      const router = new Rly0RelayModelRouter(core, {
        noAccountMode: async () => {
          throw new Error("unreadable");
        },
      });
      expect(await router.rewriteThreadParams({ model: "gpt-5.5" })).toBeNull();
    });
  });
});
