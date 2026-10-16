import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Rly0CoreClient } from "../src/rly0-core/client.js";
import {
  applyProxyEnvironment,
  Rly0CoreBridge,
  rly0CoreRpcError,
  sanitizeRly0Relay,
} from "../src/rly0-core/index.js";
import { Rly0RelayCodexConfigManager } from "../src/rly0-relay/codex-config.js";
import {
  findTableRange,
  removeTable,
  removeTopLevelKey,
  setTopLevelKey,
  tomlString,
  upsertTable,
} from "../src/rly0-mcp/toml-editor.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-rly0-core.mjs",
);
const spawnFake = ((_binary: string, _args: string[], options: Parameters<typeof spawn>[2]) =>
  spawn(process.execPath, [fixture], options)) as unknown as typeof spawn;

let tempDir: string;
beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-relay-test-"));
});
afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function fakeEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEXHOST_DATA_DIR: path.join(tempDir, "data"),
    CODEX_HOME: path.join(tempDir, "codex"),
    ...extra,
  };
}

describe("Rly0CoreClient per-request options", () => {
  it("honours a per-request timeout override", async () => {
    const client = new Rly0CoreClient({ binaryPath: "fake", spawn: spawnFake, timeoutMs: 60_000 });
    await expect(client.request("slow/echo", {}, { timeoutMs: 50 })).rejects.toThrow(
      "RLY0_CORE_TIMEOUT",
    );
    await client.dispose();
  }, 10_000);

  it("restart() rejects in-flight requests and respawns with a fresh environment", async () => {
    let proxy = "http://first:1";
    const client = new Rly0CoreClient({
      binaryPath: "fake",
      spawn: spawnFake,
      environment: { ...process.env },
      prepareEnvironment: (environment) => ({ ...environment, HTTPS_PROXY: proxy }),
    });
    const first = await client.request<{ HTTPS_PROXY: string; pid: number }>("debug/env", {});
    expect(first.available && first.result.HTTPS_PROXY).toBe("http://first:1");
    const pending = client.request("slow/echo", {});
    proxy = "http://second:2";
    expect(client.restart()).toBe(true);
    await expect(pending).rejects.toThrow("RLY0_CORE_RESTARTED");
    const second = await client.request<{ HTTPS_PROXY: string; pid: number }>("debug/env", {});
    expect(second.available && second.result.HTTPS_PROXY).toBe("http://second:2");
    expect(second.available && first.available && second.result.pid).not.toBe(
      first.available && first.result.pid,
    );
    await client.dispose();
  });
});

describe("applyProxyEnvironment", () => {
  const inherited = {
    PATH: "/bin",
    HTTPS_PROXY: "http://sys:1",
    http_proxy: "http://sys:2",
    ALL_PROXY: "socks5://sys:3",
  };

  it("keeps inherited variables in system mode", () => {
    expect(applyProxyEnvironment(inherited, { mode: "system" })).toEqual(inherited);
  });

  it("strips every proxy variable in direct mode", () => {
    expect(applyProxyEnvironment(inherited, { mode: "direct" })).toEqual({ PATH: "/bin" });
  });

  it("sets HTTPS_PROXY/HTTP_PROXY (both cases) in custom mode", () => {
    const next = applyProxyEnvironment(inherited, { mode: "custom", url: "http://127.0.0.1:7890" });
    expect(next).toEqual({
      PATH: "/bin",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
    });
  });
});

describe("Rly0CoreBridge usage", () => {
  it("returns sanitized usage and forwards usage error codes", async () => {
    const bridge = new Rly0CoreBridge({ binaryPath: "fake", spawn: spawnFake });
    const usage = await bridge.usage({ id: "abcdef012345" });
    expect(usage).toMatchObject({
      available: true,
      usage: { source: "live", fetchedAt: 1789990000 },
    });
    await expect(bridge.usage({ id: "0123456789ab" })).rejects.toMatchObject({
      message: "USAGE_TOKEN_EXPIRED",
    });
    const freeText = await bridge.usage({ id: "ffffffffffff" }).catch((error: unknown) => error);
    expect(rly0CoreRpcError(freeText)).toEqual({ code: -32000, message: "RLY0_CORE_ERROR" });
    await bridge.dispose();
  });

  it("filters usageAll entries to valid ids and code-shaped errors", async () => {
    const bridge = new Rly0CoreBridge({ binaryPath: "fake", spawn: spawnFake });
    const result = await bridge.usageAll();
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.results.map((entry) => entry.id)).toEqual([
      "abcdef012345",
      "0123456789ab",
      "aaaaaaaaaaaa",
    ]);
    expect(result.results[1]).toEqual({ id: "0123456789ab", error: "USAGE_BLOCKED" });
    expect(result.results[2]).toEqual({ id: "aaaaaaaaaaaa", error: "USAGE_BAD_RESPONSE" });
    await bridge.dispose();
  });

  it("reports unavailable for the new methods without a binary", async () => {
    const bridge = new Rly0CoreBridge({ binaryPath: null });
    await expect(bridge.usage({ id: "abcdef012345" })).resolves.toEqual({ available: false });
    await expect(bridge.usageAll()).resolves.toEqual({ available: false });
    await expect(bridge.listRelays()).resolves.toEqual({ available: false });
    await expect(bridge.proxyStatus()).resolves.toEqual({ available: false });
    await bridge.dispose();
  });
});

describe("Rly0CoreBridge relays and proxy", () => {
  it("never returns an apiKey, only hasKey/keyMask", async () => {
    const bridge = new Rly0CoreBridge({ binaryPath: "fake", spawn: spawnFake });
    const added = await bridge.addRelay({
      name: "Relay A",
      baseUrl: "https://relay.example/v1",
      apiKey: "sk-super-secret-99",
      models: ["gpt-5"],
    });
    expect(added.available).toBe(true);
    if (!added.available) return;
    expect(JSON.stringify(added)).not.toContain("sk-super-secret");
    expect(added.relay).toMatchObject({ hasKey: true, keyMask: "sk-…99", models: ["gpt-5"] });
    expect(added.relay).not.toHaveProperty("apiKey");
    expect(added.relay).not.toHaveProperty("internalNote");

    const listed = await bridge.listRelays();
    expect(JSON.stringify(listed)).not.toContain("sk-super-secret");

    const disabled = await bridge.setRelayEnabled({ id: added.id, enabled: false });
    expect(disabled.available && disabled.relay.enabled).toBe(false);
    const cleared = await bridge.updateRelay({ id: added.id, clearKey: true });
    expect(cleared.available && cleared.relay.hasKey).toBe(false);

    const tested = await bridge.testRelay({ id: added.id });
    expect(tested).toMatchObject({ available: true, ok: true, latencyMs: 42, modelCount: 2 });

    await expect(bridge.removeRelay({ id: added.id })).resolves.toEqual({
      available: true,
      ok: true,
    });
    await expect(bridge.removeRelay({ id: added.id })).rejects.toMatchObject({
      message: "NOT_FOUND",
    });
    await bridge.dispose();
  });

  it("starts, reports and stops the proxy, dropping unknown request fields", async () => {
    const bridge = new Rly0CoreBridge({ binaryPath: "fake", spawn: spawnFake });
    await expect(bridge.proxyStatus()).resolves.toEqual({
      available: true,
      running: false,
      defaultPort: 25817,
    });
    const started = await bridge.proxyStart({});
    expect(started).toMatchObject({
      available: true,
      running: true,
      port: 25817,
      baseUrl: "http://127.0.0.1:25817/v1",
    });
    expect(JSON.stringify(started)).not.toContain("sk-leak");
    await expect(bridge.proxyStart({})).resolves.toMatchObject({ alreadyRunning: true });
    await expect(bridge.proxyStop()).resolves.toEqual({ available: true, stopped: true });
    await expect(bridge.proxyStart({ port: 1 })).rejects.toMatchObject({
      message: "PROXY_PORT_IN_USE",
    });
    await bridge.dispose();
  });

  it("rejects malformed relay payloads", () => {
    expect(() => sanitizeRly0Relay({ id: "../bad" })).toThrow("RLY0_CORE_BAD_RESPONSE");
  });
});

describe("Rly0CoreBridge proxy settings", () => {
  it("defaults to system, persists changes and applies them to the core", async () => {
    const environment = fakeEnvironment({ HTTPS_PROXY: "http://inherited:1" });
    const bridge = new Rly0CoreBridge({ binaryPath: "fake", spawn: spawnFake, environment });
    expect(bridge.getProxySettings()).toEqual({ mode: "system" });
    await bridge.proxyStart({ port: 30000 });

    const result = await bridge.setProxySettings({ mode: "custom", url: "http://127.0.0.1:7890" });
    expect(result).toEqual({
      settings: { mode: "custom", url: "http://127.0.0.1:7890" },
      coreRestarted: true,
    });
    const stored = JSON.parse(
      await fs.readFile(path.join(tempDir, "data", "proxy-settings.json"), "utf8"),
    ) as unknown;
    expect(stored).toEqual({ mode: "custom", url: "http://127.0.0.1:7890" });
    // The previously running local proxy is started again on the same port.
    await expect(bridge.proxyStatus()).resolves.toMatchObject({ running: true, port: 30000 });

    const reloaded = new Rly0CoreBridge({ binaryPath: null, environment });
    expect(reloaded.getProxySettings()).toEqual({ mode: "custom", url: "http://127.0.0.1:7890" });
    await reloaded.dispose();

    const direct = await bridge.setProxySettings({ mode: "direct", url: "http://ignored:1" });
    expect(direct.settings).toEqual({ mode: "direct" });
    await bridge.dispose();
  });

  it("does not restart a core that is not running", async () => {
    const bridge = new Rly0CoreBridge({
      binaryPath: "fake",
      spawn: spawnFake,
      environment: fakeEnvironment(),
    });
    await expect(bridge.setProxySettings({ mode: "direct" })).resolves.toEqual({
      settings: { mode: "direct" },
      coreRestarted: false,
    });
    await bridge.dispose();
  });
});

describe("toml-editor generic table and top-level helpers", () => {
  const base = [
    "# Codex config",
    'model = "gpt-5" # my default',
    'approval_policy = "never"',
    "",
    "[model_providers.other]",
    'name = "Other"',
    "",
    "[mcp_servers.foo]",
    'command = "foo"',
    "",
  ].join("\n");

  it("upserts and removes a nested table while keeping comments", () => {
    const added = upsertTable(
      base,
      ["model_providers", "rly0"],
      [
        ["name", tomlString("RLY/0")],
        ["base_url", tomlString("http://127.0.0.1:25817/v1")],
      ],
    );
    expect(added).toContain("# Codex config");
    expect(added).toContain('[model_providers.rly0]\nname = "RLY/0"');
    const parsed = parseToml(added) as { model_providers: Record<string, { name: string }> };
    expect(parsed.model_providers.rly0?.name).toBe("RLY/0");
    expect(parsed.model_providers.other?.name).toBe("Other");

    const updated = upsertTable(added, ["model_providers", "rly0"], [["name", tomlString("B")]]);
    expect(updated.match(/\[model_providers\.rly0\]/gu)).toHaveLength(1);
    expect(updated).not.toContain("base_url");

    expect(removeTable(updated, ["model_providers", "rly0"])).toBe(base);
    expect(removeTable(base, ["model_providers", "rly0"])).toBe(base);
    expect(findTableRange(base.split("\n"), ["model_providers", "other"])).toMatchObject({
      start: 4,
    });
  });

  it("sets top-level keys in place keeping trailing comments, and removes them", () => {
    const set = setTopLevelKey(base, "model", tomlString("relay-model"));
    expect(set).toContain('model = "relay-model" # my default');
    const inserted = setTopLevelKey(base, "model_provider", tomlString("rly0"));
    const lines = inserted.split("\n");
    expect(lines.indexOf('model_provider = "rly0"')).toBe(3);
    expect((parseToml(inserted) as { model_provider: string }).model_provider).toBe("rly0");
    expect(removeTopLevelKey(inserted, "model_provider")).toBe(base);
    // Keys inside tables are never treated as top-level.
    expect(removeTopLevelKey(base, "command")).toBe(base);
  });

  it("preserves CRLF line endings and handles empty files", () => {
    const crlf = base.replace(/\n/gu, "\r\n");
    const next = setTopLevelKey(crlf, "model_provider", tomlString("rly0"));
    expect(next.split("\r\n")).toContain('model_provider = "rly0"');
    expect(next.replace(/\r\n/gu, "")).not.toContain("\n");
    expect(setTopLevelKey("", "model", tomlString("x"))).toBe('model = "x"\n');
    expect(upsertTable("", ["a", "b"], [["k", "1"]])).toBe("[a.b]\nk = 1\n");
  });

  it("escapes strings so values cannot break out of the TOML literal", () => {
    const literal = tomlString('a"b\\c\nd');
    expect(parseToml(`k = ${literal}`)).toEqual({ k: 'a"b\\c\nd' });
  });
});

describe("Rly0RelayCodexConfigManager", () => {
  const BASE_URL = "http://127.0.0.1:25817/v1";

  async function writeConfig(content: string): Promise<string> {
    const configPath = path.join(tempDir, "codex", "config.toml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, content, "utf8");
    return configPath;
  }

  it("reports a model_catalog_json override and never writes or removes one", async () => {
    const original = [
      'model_provider = "aimai1"',
      'model_catalog_json = "C:/Users/x/.codex/codexmate/relay/codex_router_catalog.json"',
      "",
    ].join("\n");
    const configPath = await writeConfig(original);
    const manager = new Rly0RelayCodexConfigManager({ environment: fakeEnvironment() });
    expect(await manager.status()).toMatchObject({
      modelCatalogJson: "C:/Users/x/.codex/codexmate/relay/codex_router_catalog.json",
    });
    await manager.apply({ baseUrl: BASE_URL, setDefault: false });
    const afterApply = await fs.readFile(configPath, "utf8");
    expect(afterApply.match(/model_catalog_json/g)).toHaveLength(1);
    await manager.restore();
    expect(await fs.readFile(configPath, "utf8")).toBe(original);

    await writeConfig('model = "gpt-5"\n');
    expect(await manager.status()).not.toHaveProperty("modelCatalogJson");
    await manager.apply({ baseUrl: BASE_URL, setDefault: true, model: "relay-5" });
    expect(await fs.readFile(configPath, "utf8")).not.toContain("model_catalog_json");
  });

  it("applies the provider with backup and restores the original values", async () => {
    const original = [
      "# keep me",
      'model = "gpt-5"',
      'model_provider = "openai"',
      "",
      "[mcp_servers.foo]",
      'command = "foo"',
      "",
    ].join("\n");
    const configPath = await writeConfig(original);
    const manager = new Rly0RelayCodexConfigManager({
      environment: fakeEnvironment(),
      now: () => 1_789_000_000,
    });

    const applied = await manager.apply({ baseUrl: BASE_URL, setDefault: true, model: "relay-5" });
    expect(applied.status).toMatchObject({
      providerPresent: true,
      providerBaseUrl: BASE_URL,
      modelProvider: "rly0",
      model: "relay-5",
      applied: true,
      setDefault: true,
    });
    const written = await fs.readFile(configPath, "utf8");
    expect(written).toContain("# keep me");
    const parsed = parseToml(written) as Record<string, unknown>;
    expect(parsed.model_providers).toEqual({
      rly0: {
        name: "RLY/0 Hub 本地代理",
        base_url: BASE_URL,
        wire_api: "responses",
        requires_openai_auth: true,
      },
    });
    const backups = (await fs.readdir(path.dirname(configPath))).filter((name) =>
      name.includes(".rly0-bak-"),
    );
    expect(backups).toHaveLength(1);

    const state = JSON.parse(
      await fs.readFile(path.join(tempDir, "data", "relay-injection.json"), "utf8"),
    ) as { previous: unknown };
    expect(state.previous).toEqual({ modelProvider: "openai", model: "gpt-5" });

    // A second apply keeps the first recorded originals.
    await manager.apply({ baseUrl: "http://127.0.0.1:25818/v1", setDefault: true, model: "m2" });

    const restored = await manager.restore();
    expect(restored.status).toMatchObject({ providerPresent: false, applied: false });
    const after = await fs.readFile(configPath, "utf8");
    expect(parseToml(after)).toEqual(parseToml(original));
    expect(after).toContain("# keep me");
  });

  it("restores by removing keys that did not exist before", async () => {
    await writeConfig('approval_policy = "never"\n');
    const manager = new Rly0RelayCodexConfigManager({ environment: fakeEnvironment() });
    await manager.apply({ baseUrl: BASE_URL, setDefault: true, model: "relay-5" });
    await manager.restore();
    const after = await fs.readFile(path.join(tempDir, "codex", "config.toml"), "utf8");
    expect(parseToml(after)).toEqual({ approval_policy: "never" });
  });

  it("does not revert a model the user changed after applying", async () => {
    const configPath = await writeConfig('model = "gpt-5"\n');
    const manager = new Rly0RelayCodexConfigManager({ environment: fakeEnvironment() });
    await manager.apply({ baseUrl: BASE_URL, setDefault: true, model: "relay-5" });
    const edited = (await fs.readFile(configPath, "utf8")).replace(
      'model = "relay-5"',
      'model = "hand-picked"',
    );
    await fs.writeFile(configPath, edited, "utf8");
    await manager.restore();
    expect(parseToml(await fs.readFile(configPath, "utf8"))).toEqual({ model: "hand-picked" });
  });

  it("only adds the provider table when setDefault is false", async () => {
    await writeConfig('model = "gpt-5"\n');
    const manager = new Rly0RelayCodexConfigManager({ environment: fakeEnvironment() });
    const result = await manager.apply({ baseUrl: BASE_URL, setDefault: false });
    expect(result.status).toMatchObject({ providerPresent: true, model: "gpt-5" });
    expect(result.status.modelProvider).toBeUndefined();
  });

  it("creates config.toml when it does not exist", async () => {
    const manager = new Rly0RelayCodexConfigManager({ environment: fakeEnvironment() });
    await expect(manager.status()).resolves.toMatchObject({
      configExists: false,
      providerPresent: false,
      applied: false,
    });
    await manager.apply({ baseUrl: BASE_URL, setDefault: true, model: "relay-5" });
    const parsed = parseToml(
      await fs.readFile(path.join(tempDir, "codex", "config.toml"), "utf8"),
    ) as Record<string, unknown>;
    expect(parsed.model_provider).toBe("rly0");
  });

  it("refuses to write a config that does not parse", async () => {
    const configPath = await writeConfig("this is = = not toml\n");
    const manager = new Rly0RelayCodexConfigManager({ environment: fakeEnvironment() });
    await expect(manager.apply({ baseUrl: BASE_URL, setDefault: false })).rejects.toThrow(
      "CODEX_CONFIG_PARSE_ERROR",
    );
    expect(await fs.readFile(configPath, "utf8")).toBe("this is = = not toml\n");
    await expect(manager.status()).resolves.toMatchObject({
      parseError: "CODEX_CONFIG_PARSE_ERROR",
    });
  });

  it("aborts instead of writing a conflicting provider definition", async () => {
    const original = '[model_providers]\nrly0 = { name = "inline" }\n';
    const configPath = await writeConfig(original);
    const manager = new Rly0RelayCodexConfigManager({ environment: fakeEnvironment() });
    await expect(manager.apply({ baseUrl: BASE_URL, setDefault: false })).rejects.toThrow(
      /CODEX_CONFIG_(PARSE_ERROR|VERIFY_FAILED)/u,
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });
});
