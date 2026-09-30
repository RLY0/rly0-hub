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
});
