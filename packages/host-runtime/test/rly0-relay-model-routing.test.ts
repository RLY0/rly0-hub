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
              models: ["claude-opus-5", "gpt-5.5", "deepseek-*"],
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
  it("adds enabled relay models to model/list without shadowing official ones", async () => {
    const { core } = fakeCore();
    const router = new Rly0RelayModelRouter(core);
    await router.prepareModelList();
    const rewritten = router.rewriteModelListResponse(officialList) as typeof officialList;
    const models = rewritten.result.data.map((entry) => entry.model);
    expect(models).toEqual(["gpt-5.5", "claude-opus-5"]);
    const added = rewritten.result.data[1] as Record<string, unknown>;
    expect(added).toMatchObject({
      id: "claude-opus-5",
      displayName: "claude-opus-5",
      description: "My relay · RLY/0",
      isDefault: false,
      hidden: false,
      defaultReasoningEffort: "medium",
    });
    expect(added.upgrade).toBeUndefined();
    // Official names stay official even though the relay lists them too.
    expect(await router.isRelayModel("gpt-5.5")).toBe(false);
    expect(await router.isRelayModel("deepseek-v4")).toBe(true);
    expect(await router.isRelayModel("hidden-model")).toBe(false);
  });

  it("moves relay-model threads onto the local proxy and starts it when needed", async () => {
    const { core, calls } = fakeCore();
    const router = new Rly0RelayModelRouter(core);
    const next = await router.rewriteThreadParams({ model: "claude-opus-5", cwd: "x" });
    expect(calls).toContain("start");
    expect(next).toMatchObject({
      model: "claude-opus-5",
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

  it("defines the provider on model-less resumes and tracks thread providers", async () => {
    const { core, calls } = fakeCore();
    const router = new Rly0RelayModelRouter(core);
    const resumed = await router.rewriteThreadParams({ threadId: "t1" });
    expect(resumed).not.toHaveProperty("modelProvider");
    expect(resumed).toHaveProperty(["config", "model_providers.rly0"]);
    expect(calls).not.toContain("start");
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
          { id: "claude-opus-5", model: "claude-opus-5", displayName: "Official Opus" },
        ],
        nextCursor: null,
      },
    };
    const snapshot = structuredClone(official);
    // Every relay name here is official, so nothing is added at all.
    expect(router.rewriteModelListResponse(official)).toBeNull();
    expect(official).toEqual(snapshot);
    expect(await router.isRelayModel("claude-opus-5")).toBe(false);
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
      result: { data: [{ id: "claude-opus-5", model: "claude-opus-5" }], nextCursor: "p2" },
    };
    expect(router.rewriteModelListResponse(page1)).toBeNull();
    const page2 = {
      id: 2,
      result: { data: [{ id: "gpt-6", model: "gpt-6" }], nextCursor: null },
    };
    const rewritten = router.rewriteModelListResponse(page2) as {
      result: { data: { model: string }[] };
    };
    expect(rewritten.result.data.map((entry) => entry.model)).toEqual(["gpt-6", "gpt-5.5"]);
  });

  it("reads the live official catalog before routing when no model/list has been seen", async () => {
    const { core, calls } = fakeCore();
    let reads = 0;
    const router = new Rly0RelayModelRouter(core, {
      loadOfficialModels: async () => {
        reads += 1;
        return ["gpt-5.5"];
      },
    });
    // The relay lists gpt-5.5 too, but it is official: the thread must stay on the account.
    expect(await router.rewriteThreadParams({ model: "gpt-5.5" })).toBeNull();
    expect(calls).not.toContain("start");
    expect(await router.isRelayModel("claude-opus-5")).toBe(true);
    expect(reads).toBe(1);
    // Unlisted names never trigger an official read.
    expect(await router.isRelayModel("not-a-relay-model")).toBe(false);
    expect(reads).toBe(1);
  });

  it("keeps relay models usable when the official catalog cannot be read", async () => {
    const { core } = fakeCore();
    let reads = 0;
    const router = new Rly0RelayModelRouter(core, {
      loadOfficialModels: async () => {
        reads += 1;
        throw new Error("official runtime down");
      },
    });
    expect(await router.isRelayModel("claude-opus-5")).toBe(true);
    // A failed read is not retried on every turn.
    expect(await router.isRelayModel("claude-opus-5")).toBe(true);
    expect(reads).toBe(1);
  });
});
