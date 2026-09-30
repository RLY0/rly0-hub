import { describe, expect, it } from "vitest";

import {
  rly0AccountSchema,
  rly0AccountsUsageAllResultSchema,
  rly0AccountsUsageResultSchema,
  rly0ProxySettingsSchema,
} from "../src/rly0-core.js";
import {
  rly0ProxyStatusResultSchema,
  rly0RelayAddParamsSchema,
  rly0RelayCodexConfigApplyParamsSchema,
  rly0RelayListResultSchema,
  rly0RelayTestResultSchema,
  rly0RelayUpdateParamsSchema,
} from "../src/rly0-relay.js";

const usage = {
  windows: [
    { kind: "primary", usedPercent: 42, windowSeconds: 18_000, resetsAt: 1_790_000_000 },
    { kind: "secondary", usedPercent: 10, windowSeconds: 604_800 },
  ],
  plan: "plus",
  fetchedAt: 1_789_990_000,
  source: "live",
};

describe("rly0 usage contracts", () => {
  it("accepts accounts carrying a cached lastUsage", () => {
    expect(
      rly0AccountSchema.safeParse({ id: "abcdef012345", current: true, lastUsage: usage }).success,
    ).toBe(true);
  });

  it("accepts usage and usageAll results and the unavailable shape", () => {
    expect(rly0AccountsUsageResultSchema.safeParse({ available: true, usage }).success).toBe(true);
    expect(rly0AccountsUsageResultSchema.safeParse({ available: false }).success).toBe(true);
    expect(
      rly0AccountsUsageAllResultSchema.safeParse({
        available: true,
        results: [
          { id: "abcdef012345", usage },
          { id: "0123456789ab", error: "USAGE_TOKEN_EXPIRED" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects out-of-range percentages and unknown window kinds", () => {
    const bad = { ...usage, windows: [{ kind: "primary", usedPercent: 120 }] };
    expect(rly0AccountsUsageResultSchema.safeParse({ available: true, usage: bad }).success).toBe(
      false,
    );
    const badKind = { ...usage, windows: [{ kind: "tertiary", usedPercent: 1 }] };
    expect(
      rly0AccountsUsageResultSchema.safeParse({ available: true, usage: badKind }).success,
    ).toBe(false);
  });
});

describe("rly0ProxySettingsSchema", () => {
  it("accepts direct, system and custom http(s) proxies", () => {
    expect(rly0ProxySettingsSchema.safeParse({ mode: "direct" }).success).toBe(true);
    expect(rly0ProxySettingsSchema.safeParse({ mode: "system" }).success).toBe(true);
    expect(
      rly0ProxySettingsSchema.safeParse({ mode: "custom", url: "http://127.0.0.1:7890" }).success,
    ).toBe(true);
  });

  it.each([
    ["custom without url", { mode: "custom" }],
    ["socks url", { mode: "custom", url: "socks5://127.0.0.1:1080" }],
    ["whitespace", { mode: "custom", url: "http://a b" }],
    ["unknown mode", { mode: "pac" }],
  ])("rejects %s", (_name, value) => {
    expect(rly0ProxySettingsSchema.safeParse(value).success).toBe(false);
  });
});

describe("rly0 relay contracts", () => {
  const relay = {
    id: "r_1",
    name: "Relay",
    baseUrl: "https://relay.example/v1",
    protocol: "responses",
    models: ["gpt-5", "claude-*"],
    enabled: true,
    addedAt: 1_789_000_000,
    updatedAt: 1_789_000_000,
    hasKey: true,
    keyMask: "sk-…abcd",
  };

  it("accepts relay listings but never an apiKey field", () => {
    expect(rly0RelayListResultSchema.safeParse({ available: true, relays: [relay] }).success).toBe(
      true,
    );
    expect(
      rly0RelayListResultSchema.safeParse({
        available: true,
        relays: [{ ...relay, apiKey: "sk-secret" }],
      }).success,
    ).toBe(false);
  });

  it("validates add/update params", () => {
    expect(
      rly0RelayAddParamsSchema.safeParse({
        name: "Relay",
        baseUrl: "https://relay.example/v1",
        apiKey: "sk-1",
        models: ["gpt-5"],
      }).success,
    ).toBe(true);
    expect(
      rly0RelayAddParamsSchema.safeParse({ name: "Relay", baseUrl: "file:///etc/passwd" }).success,
    ).toBe(false);
    expect(
      rly0RelayAddParamsSchema.safeParse({
        name: "Relay",
        baseUrl: "https://relay.example",
        models: ['bad"model'],
      }).success,
    ).toBe(false);
    expect(rly0RelayUpdateParamsSchema.safeParse({ id: "../x" }).success).toBe(false);
    expect(rly0RelayUpdateParamsSchema.safeParse({ id: "r_1", clearKey: true }).success).toBe(true);
  });

  it("accepts test results and both proxy status shapes", () => {
    expect(
      rly0RelayTestResultSchema.safeParse({
        available: true,
        ok: true,
        latencyMs: 120,
        status: 200,
        modelCount: 2,
        models: ["a", "b"],
      }).success,
    ).toBe(true);
    expect(
      rly0ProxyStatusResultSchema.safeParse({
        available: true,
        running: false,
        defaultPort: 25817,
      }).success,
    ).toBe(true);
    expect(
      rly0ProxyStatusResultSchema.safeParse({
        available: true,
        running: true,
        port: 25817,
        baseUrl: "http://127.0.0.1:25817/v1",
        startedAt: 1_789_000_000,
        requests: 3,
        routed: 2,
        unrouted: 1,
        failed: 0,
        recent: [{ at: 1_789_000_001, method: "POST", path: "/v1/responses", status: 200, ms: 5 }],
      }).success,
    ).toBe(true);
    expect(rly0ProxyStatusResultSchema.safeParse({ available: false }).success).toBe(true);
  });

  it("only allows loopback proxy base URLs for Codex config injection", () => {
    expect(
      rly0RelayCodexConfigApplyParamsSchema.safeParse({
        baseUrl: "http://127.0.0.1:25817/v1",
        setDefault: true,
        model: "gpt-5",
      }).success,
    ).toBe(true);
    expect(
      rly0RelayCodexConfigApplyParamsSchema.safeParse({
        baseUrl: "http://127.0.0.1:25817/v1",
        setDefault: false,
      }).success,
    ).toBe(true);
    for (const baseUrl of [
      "http://evil.example:25817/v1",
      "http://127.0.0.1:99999/v1",
      'http://127.0.0.1:1/v1"\n[x]',
    ]) {
      expect(
        rly0RelayCodexConfigApplyParamsSchema.safeParse({ baseUrl, setDefault: false }).success,
      ).toBe(false);
    }
    expect(
      rly0RelayCodexConfigApplyParamsSchema.safeParse({
        baseUrl: "http://127.0.0.1:25817/v1",
        setDefault: true,
      }).success,
    ).toBe(false);
  });
});
