import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Rly0ProxyStatusResult, Rly0RelayListResult } from "@codexhost/shared-contracts";

import {
  customProvidersFromConfig,
  readCustomProviders,
  type Rly0CustomProvider,
} from "../src/rly0-relay/custom-providers.js";
import { Rly0RelayModelRouter } from "../src/rly0-relay/model-routing.js";
import {
  codexSignedInWithApiKey,
  readUnifiedChannel,
  unifiedBaseUrl,
  writeUnifiedChannel,
} from "../src/rly0-relay/unified-channel.js";
import type { Rly0OfficialAccount } from "../src/rly0-relay/unified-menu.js";

const RELAY = "rly0/r1/gpt-6.1-sol";
const UNIFIED_BASE = "http://127.0.0.1:25917/u/v1";

const SHUAI: Rly0CustomProvider = {
  id: "shuai",
  name: "帅api",
  baseUrl: "https://api.shuaiapi.example/v1",
  envKey: "SHUAI_KEY",
  requiresOpenaiAuth: false,
  models: [],
};

function setup(
  options: {
    unified?: boolean;
    custom?: Rly0CustomProvider[];
    account?: Rly0OfficialAccount | null;
    noAccount?: boolean;
  } = {},
) {
  const pushed: unknown[] = [];
  const state = { unified: options.unified ?? true, account: options.account ?? null };
  const core = {
    async listRelays(): Promise<Rly0RelayListResult> {
      return {
        available: true,
        relays: [
          {
            id: "r1",
            name: "零号中转",
            baseUrl: "https://relay.example/v1",
            protocol: "responses",
            models: ["gpt-6.1-sol"],
            enabled: true,
            hasKey: true,
          },
        ],
      } as Rly0RelayListResult;
    },
    async proxyStatus(): Promise<Rly0ProxyStatusResult> {
      return {
        available: true,
        running: true,
        port: 25917,
        baseUrl: "http://127.0.0.1:25917/v1",
        requests: 0,
        routed: 0,
        unrouted: 0,
        failed: 0,
        recent: [],
      };
    },
    async proxyStart(): Promise<Rly0ProxyStatusResult> {
      return this.proxyStatus();
    },
    async proxyCustomProviders(providers: unknown) {
      pushed.push(providers);
      return { available: true };
    },
  };
  const router = new Rly0RelayModelRouter(core, {
    unifiedChannel: async () => state.unified,
    customProviders: async () => options.custom ?? [SHUAI],
    officialAccount: async () => state.account,
    providerRequiresOpenaiAuth: async () => !options.noAccount,
    ...(options.noAccount ? { noAccountMode: async () => ({ model: "gpt-6.1-sol" }) } : {}),
  });
  return { router, pushed, state };
}

const official = (data: Record<string, unknown>[], nextCursor: string | null = null) => ({
  id: 1,
  result: { data, nextCursor },
});
const GPT = {
  id: "gpt-5.5",
  model: "gpt-5.5",
  displayName: "GPT-5.5",
  description: "Official",
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
};

describe("SYNTHETIC unified channel: every Thread on rly0, upstream per request", () => {
  it("starts, resumes and forks every Thread on rly0 through the proxy's /u/v1 path", async () => {
    const { router } = setup();
    expect(await router.rewriteThreadParams({ cwd: "/w" })).toMatchObject({
      modelProvider: "rly0",
      config: {
        "model_providers.rly0": { base_url: UNIFIED_BASE, requires_openai_auth: true },
      },
    });
    for (const model of ["gpt-5.5", RELAY, "cfg/shuai/gpt-6-sol"]) {
      expect(await router.rewriteThreadParams({ model })).toMatchObject({
        model,
        modelProvider: "rly0",
      });
    }
    await expect(router.rewriteThreadParams({ model: "cfg/gone/x" })).rejects.toThrow(
      "CUSTOM_PROVIDER_NOT_AVAILABLE",
    );
    await expect(router.rewriteThreadParams({ model: "rly0/nope/x" })).rejects.toThrow(
      "RELAY_MODEL_NOT_AVAILABLE",
    );
  });

  it("resumes an old openai Thread on rly0 with the model it had (the gpt-6.1-sol failure)", async () => {
    const { router } = setup();
    const reads: string[] = [];
    const next = await router.rewriteResumeParams({ threadId: "old" }, async (threadId) => {
      reads.push(threadId);
      return { provider: "openai", model: "gpt-5.5", status: "notLoaded" };
    });
    expect(reads).toEqual(["old"]);
    expect(next).toMatchObject({
      threadId: "old",
      model: "gpt-5.5",
      modelProvider: "rly0",
      config: { "model_providers.rly0": { base_url: UNIFIED_BASE } },
    });
    // Its next turn may name a relay model: the Thread is on rly0, so nothing is locked.
    router.observeResponse({
      result: { thread: { id: "old" }, model: "gpt-5.5", modelProvider: "rly0" },
    });
    expect(router.threadProvider("old")).toBe("rly0");
  });

  it("keeps a rly0 Thread's stored pair and moves a config.toml provider Thread to cfg/", async () => {
    const { router } = setup();
    const onRly0 = await router.rewriteResumeParams({ threadId: "r" }, async () => ({
      provider: "rly0",
      model: RELAY,
    }));
    expect(onRly0).not.toHaveProperty("modelProvider");
    expect(onRly0).not.toHaveProperty("model");
    expect(onRly0).toMatchObject({
      config: { "model_providers.rly0": { base_url: UNIFIED_BASE } },
    });
    const onCustom = await router.rewriteResumeParams({ threadId: "c" }, async () => ({
      provider: "shuai",
      model: "gpt-6-sol",
    }));
    expect(onCustom).toMatchObject({ model: "cfg/shuai/gpt-6-sol", modelProvider: "rly0" });
  });

  it("restores Threads after a backend reload (account A→B) on rly0, and back when off", async () => {
    const { router, state } = setup();
    router.observeResponse({
      result: { thread: { id: "t" }, model: "gpt-5.5", modelProvider: "openai" },
    });
    expect(await router.restoreParams({ threadId: "t", excludeTurns: true })).toMatchObject({
      threadId: "t",
      model: "gpt-5.5",
      modelProvider: "rly0",
      excludeTurns: true,
    });
    state.unified = false;
    await router.unifiedOn(true);
    const back = await router.restoreParams({
      threadId: "t",
      model: "gpt-5.5",
      modelProvider: "rly0",
      config: { "model_providers.rly0": { base_url: UNIFIED_BASE }, other: 1 },
    });
    expect(back).toEqual({
      threadId: "t",
      model: "gpt-5.5",
      modelProvider: "openai",
      config: { other: 1 },
    });
    // A relay model stays on rly0 when off.
    const relay = { threadId: "t", model: RELAY, modelProvider: "rly0" };
    expect(await router.restoreParams(relay)).toBe(relay);
  });

  it("forks a Thread loaded on another provider onto rly0", async () => {
    const { router } = setup();
    expect(await router.forkParams("loaded", "cfg/shuai/gpt-6-sol")).toMatchObject({
      threadId: "loaded",
      model: "cfg/shuai/gpt-6-sol",
      modelProvider: "rly0",
      excludeTurns: true,
      config: { "model_providers.rly0": { base_url: UNIFIED_BASE } },
    });
  });

  it("lists every channel in groups and names the channel in each row", async () => {
    const { router, pushed } = setup({ account: { kind: "chatgpt", email: "a@example.com" } });
    await router.prepareModelList();
    expect(pushed).toEqual([
      [
        {
          id: "shuai",
          name: "帅api",
          baseUrl: "https://api.shuaiapi.example/v1",
          envKey: "SHUAI_KEY",
          requiresOpenaiAuth: false,
        },
      ],
    ]);
    const hidden = { ...GPT, id: "gpt-old", model: "gpt-old", hidden: true, isDefault: false };
    const rows = (
      router.rewriteModelListResponse(official([GPT, hidden]))?.result as {
        data: Record<string, unknown>[];
      }
    ).data;
    expect(rows.map((row) => [row.model, row.displayName, row.description])).toEqual([
      ["gpt-5.5", "官方 · GPT-5.5", "官方账号 当前：a@example.com"],
      ["gpt-old", "官方 · GPT-5.5", "官方账号 当前：a@example.com"],
      [RELAY, "零号中转 · gpt-6.1-sol", "零号中转 · 零号中转"],
      ["cfg/shuai/gpt-5.5", "帅api · gpt-5.5", "自定义中转 · config.toml"],
    ]);
    expect(rows[3]).toMatchObject({ hidden: false, isDefault: false });
  });

  it("names API-key rows and offers a login-reusing provider only with an API key", async () => {
    const custom: Rly0CustomProvider[] = [
      {
        id: "custom",
        name: "帅api",
        baseUrl: "https://x/v1",
        requiresOpenaiAuth: true,
        models: [],
      },
    ];
    const chatgpt = setup({ custom, account: { kind: "chatgpt" } });
    await chatgpt.router.prepareModelList();
    const signedIn = (
      chatgpt.router.rewriteModelListResponse(official([GPT]))?.result as {
        data: Record<string, unknown>[];
      }
    ).data;
    expect(signedIn.some((row) => String(row.model).startsWith("cfg/"))).toBe(false);
    const key = setup({ custom, account: { kind: "apiKey" } });
    await key.router.prepareModelList();
    const rows = (
      key.router.rewriteModelListResponse(official([GPT]))?.result as {
        data: Record<string, unknown>[];
      }
    ).data;
    expect(rows[0]).toMatchObject({ displayName: "API Key · GPT-5.5" });
    expect(rows.at(-1)).toMatchObject({ model: "cfg/custom/gpt-5.5" });
  });

  it("no-account mode still hides official models, and off restores the original menu", async () => {
    const noAccount = setup({ noAccount: true });
    await noAccount.router.prepareModelList();
    const rows = (
      noAccount.router.rewriteModelListResponse(official([GPT]))?.result as {
        data: Record<string, unknown>[];
      }
    ).data;
    expect(rows.map((row) => row.model)).toEqual([RELAY, "cfg/shuai/gpt-5.5"]);
    const off = setup({ unified: false });
    await off.router.prepareModelList();
    const plain = (
      off.router.rewriteModelListResponse(official([GPT]))?.result as {
        data: Record<string, unknown>[];
      }
    ).data;
    expect(plain[0]).toEqual(GPT);
    expect(plain.map((row) => row.model)).toEqual(["gpt-5.5", RELAY]);
    expect(off.pushed).toEqual([]);
  });

  it("starts a new Thread on config.toml's default custom provider when it names no model", async () => {
    const { router } = setup({ custom: [{ ...SHUAI, defaultModel: "gpt-6-sol" }] });
    expect(await router.rewriteThreadParams({})).toMatchObject({
      model: "cfg/shuai/gpt-6-sol",
      modelProvider: "rly0",
    });
  });
});

describe("SYNTHETIC unified channel files", () => {
  it("parses config.toml providers without copying keys anywhere and keeps config.toml untouched", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "rly0-unified-"));
    const codexHome = path.join(home, "codex");
    const dataDir = path.join(home, "hub");
    const environment = { CODEX_HOME: codexHome, CODEXHOST_DATA_DIR: dataDir };
    const config = [
      'model = "gpt-6-sol"',
      'model_provider = "custom"',
      "[model_providers.custom]",
      'name = "帅api"',
      'base_url = "https://api.shuaiapi.example/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "[model_providers.keyed]",
      'base_url = "https://k.example/v1"',
      'env_key = "K_KEY"',
      'http_headers = { "x-a" = "1" }',
      "[model_providers.chat]",
      'base_url = "https://c.example/v1"',
      'wire_api = "chat"',
      "[model_providers.rly0]",
      'base_url = "http://127.0.0.1:25917/v1"',
      "[profiles.fast]",
      'model = "gpt-5.5-mini"',
      'model_provider = "keyed"',
      "",
    ].join("\n");
    await import("node:fs/promises").then((fs) => fs.mkdir(codexHome, { recursive: true }));
    writeFileSync(path.join(codexHome, "config.toml"), config);
    writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-test-not-real" }),
    );
    const providers = await readCustomProviders(environment);
    expect(providers.map((p) => [p.id, p.models, p.defaultModel])).toEqual([
      ["custom", ["gpt-6-sol"], "gpt-6-sol"],
      ["keyed", ["gpt-5.5-mini"], undefined],
    ]);
    expect(providers[1]).toMatchObject({ envKey: "K_KEY", headers: { "x-a": "1" } });
    expect(customProvidersFromConfig("not toml [")).toEqual([]);
    expect(await codexSignedInWithApiKey(environment)).toBe(true);

    expect(await readUnifiedChannel(environment)).toBe(true);
    await writeUnifiedChannel(false, environment);
    expect(await readUnifiedChannel(environment)).toBe(false);
    await writeUnifiedChannel(true, environment);
    expect(await readUnifiedChannel(environment)).toBe(true);
    expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe(config);
    expect(readdirSync(codexHome).sort()).toEqual(["auth.json", "config.toml"]);
    for (const name of readdirSync(dataDir))
      expect(readFileSync(path.join(dataDir, name), "utf8")).not.toMatch(/sk-test|K_KEY/u);
    expect(unifiedBaseUrl("http://127.0.0.1:25917/v1/")).toBe(UNIFIED_BASE);
  });
});
