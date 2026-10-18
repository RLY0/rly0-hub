import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { resolveRly0HubAutostartCommand } from "../src/rly0-appearance/hub-autostart.js";
import { Rly0AppearanceManager } from "../src/rly0-appearance/index.js";
import type { Rly0CoreBridge } from "../src/rly0-core/index.js";
import { Rly0CodexControl } from "../src/rly0-hub-service/codex-control.js";
import { evaluateRly0HubAlerts } from "../src/rly0-hub-service/alerts.js";
import { isRly0Relay, Rly0HubService } from "../src/rly0-hub-service/service.js";
import { serveRly0HubStdio } from "../src/rly0-hub-service/stdio-server.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function tempDir(): Promise<string> {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-hub-service-"));
  return directory;
}

const relay = (id: string, baseUrl: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  baseUrl,
  protocol: "responses",
  models: [],
  enabled: true,
  hasKey: true,
  addedAt: "",
  updatedAt: "",
  ...extra,
});

function fakeCore(relays: ReturnType<typeof relay>[]) {
  const calls: string[] = [];
  const core = {
    listRelays: async () => ({ available: true, relays }),
    relayBalance: async (p: { id: string }) => {
      calls.push(`balance:${p.id}`);
      return { available: true, ok: true, valid: true, balance: 86.4, unit: "CNY" };
    },
    proxyStatus: async () => ({ available: true, running: true, port: 25917, baseUrl: "x" }),
    listAccounts: async () => ({ available: true, accounts: [{ id: "a", current: true }] }),
    getProxySettings: () => ({ mode: "system" }),
    dispose: async () => undefined,
    currentAccount: async () => ({ loggedIn: true, saved: false, email: "me@example.com" }),
    usageCurrent: async () => ({ available: false }),
  };
  return { core: core as unknown as Rly0CoreBridge, calls };
}

function memoryAutostart() {
  let value: string | null = null;
  return {
    registry: {
      get: async () => value,
      set: async (command: string) => {
        value = command;
      },
      remove: async () => {
        value = null;
      },
    },
    value: () => value,
  };
}

describe("RLY/0 Hub service", () => {
  it("rejects unknown methods and malformed params with codes only", async () => {
    const root = await tempDir();
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      backendReloadTimeoutMs: 50,
      core: fakeCore([]).core,
    });
    await expect(service.handle("constructor", {})).rejects.toThrow("METHOD_NOT_FOUND");
    await expect(service.handle("relay.test", { id: "../x" })).rejects.toThrow("INVALID_PARAMS");
    await expect(service.handle("links.open", { target: "https://evil" })).rejects.toThrow(
      "INVALID_PARAMS",
    );
  });

  it("shows the balance of 零号中转 itself, not of other relays", async () => {
    const root = await tempDir();
    const { core, calls } = fakeCore([
      relay("aaaaaaaaaaaa", "https://other.example/v1"),
      relay("bbbbbbbbbbbb", "https://api.rly0.com/v1"),
    ]);
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      backendReloadTimeoutMs: 50,
      core,
    });
    expect(await service.handle("balance.get", {})).toMatchObject({
      configured: true,
      relayId: "bbbbbbbbbbbb",
      balance: 86.4,
    });
    expect(calls).toEqual(["balance:bbbbbbbbbbbb"]);
    expect(isRly0Relay({ baseUrl: "https://rly0.com.evil.example" })).toBe(false);

    const none = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      backendReloadTimeoutMs: 50,
      core: fakeCore([relay("aaaaaaaaaaaa", "https://other.example")]).core,
    });
    expect(await none.handle("balance.get", {})).toEqual({ configured: false });
  });

  it("opens only the fixed recharge page", async () => {
    const root = await tempDir();
    const opened: string[] = [];
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      backendReloadTimeoutMs: 50,
      core: fakeCore([]).core,
      openUrl: (url) => opened.push(url),
    });
    await service.handle("links.open", { target: "recharge" });
    await service.handle("links.open", { target: "github" });
    await service.handle("links.open", { target: "nodejs" });
    expect(opened).toEqual([
      "https://rly0.com/purchase?tab=recharge",
      "https://github.com/a1039861261-stack/rly0-hub",
      "https://nodejs.org",
    ]);
  });

  it("turns autostart on the first time only", async () => {
    const root = await tempDir();
    const memory = memoryAutostart();
    const appearance = new Rly0AppearanceManager({
      registry: memory.registry,
      platform: "win32",
      launcherCommand: '"C:\\Hub\\bin\\rly0-hub.exe" --background',
    });
    const make = () =>
      new Rly0HubService({
        environment: { CODEXHOST_DATA_DIR: root, CODEX_HOME: path.join(root, "codex") },
        installRoot: root,
        backendReloadTimeoutMs: 50,
        core: fakeCore([]).core,
        appearance,
      });
    await make().start();
    expect(memory.value()).toBe('"C:\\Hub\\bin\\rly0-hub.exe" --background');
    await make().handle("autostart.set", { enabled: false });
    await make().start();
    expect(memory.value()).toBeNull();
  });

  it("registers the Hub executable, never a bare script", () => {
    expect(resolveRly0HubAutostartCommand("C:\\Hub", () => true)).toBe(
      '"C:\\Hub\\bin\\rly0-hub.exe" --background',
    );
    expect(resolveRly0HubAutostartCommand("C:\\Hub", () => false)).toBeUndefined();
  });
});

describe("Codex control from the Hub", () => {
  it("restarts only the running Launcher named in its descriptor", async () => {
    const root = await tempDir();
    const runtime = path.join(root, "rly0-hub");
    await fs.mkdir(runtime, { recursive: true });
    const control = new Rly0CodexControl({
      environment: { LOCALAPPDATA: root },
      installRoot: root,
      backendReloadTimeoutMs: 50,
      platform: "win32",
      isAlive: (pid) => pid === 4242,
      fileExists: () => true,
    });
    expect(await control.status()).toEqual({ running: false, canOpen: true });
    expect(await control.restart()).toEqual({ ok: false });

    const nonce = "0123456789abcdef0123456789abcdef";
    await fs.writeFile(
      path.join(runtime, "desktop-runtime-v1.json"),
      JSON.stringify({ schemaVersion: 1, launcherPid: 4242, controlPort: 1, nonce }),
    );
    expect((await control.status()).running).toBe(true);
    expect(await control.restart()).toEqual({ ok: true });
    const request = JSON.parse(
      await fs.readFile(path.join(runtime, "desktop-control-request.json"), "utf8"),
    ) as unknown;
    expect(request).toEqual({ schemaVersion: 1, launcherPid: 4242, nonce, action: "restart" });
    expect(await control.forceQuit()).toEqual({ ok: true });
    expect(
      JSON.parse(await fs.readFile(path.join(runtime, "desktop-control-request.json"), "utf8")),
    ).toMatchObject({ action: "quit", launcherPid: 4242, nonce });
  });

  it("starts Codex through the Launcher's Start entry", async () => {
    const started: string[] = [];
    const control = new Rly0CodexControl({
      environment: {},
      installRoot: "C:\\Hub",
      backendReloadTimeoutMs: 50,
      platform: "win32",
      fileExists: () => true,
      startDetached: (file) => started.push(file),
    });
    expect(await control.open()).toEqual({ ok: true });
    expect(started).toEqual([path.join("C:\\Hub", "bin", "codexhost-start.exe")]);
  });
});

describe("Hub stdio protocol", () => {
  it("answers by id and hides error details", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: unknown[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line));
      }
    });
    const served = serveRly0HubStdio(
      {
        handle: async (method) => {
          if (method === "ok") return { fine: true };
          throw new Error("secret path C:\\Users\\me\\key.txt");
        },
      },
      input,
      output,
    );
    input.write('{"id":"r1","method":"ok"}\n');
    input.write('{"id":"r2","method":"boom"}\n');
    input.write("not json\n");
    input.write('{"id":"bad id!","method":"ok"}\n');
    input.end();
    await served;
    expect(lines).toEqual([
      { id: "r1", result: { fine: true } },
      { id: "r2", error: { code: -32000, message: "HUB_ERROR" } },
    ]);
  });
});

describe("Hub tray notices", () => {
  it("warns about a low balance once, and again only after it recovered", () => {
    const low = { balance: { amount: 0.5, unit: "USD" as const } };
    const first = evaluateRly0HubAlerts(low, {});
    expect(first.alerts.map((a) => [a.id, a.action, a.body])).toEqual([
      ["balance-low", "recharge", "还剩 $0.50，点这里充值。"],
    ]);
    expect(evaluateRly0HubAlerts(low, first.state).alerts).toEqual([]);
    const recovered = evaluateRly0HubAlerts({ balance: { amount: 20, unit: "USD" } }, first.state);
    expect(recovered.alerts).toEqual([]);
    expect(evaluateRly0HubAlerts(low, recovered.state).alerts).toHaveLength(1);
    expect(evaluateRly0HubAlerts({ balance: { amount: 5, unit: "CNY" } }, {}).alerts).toHaveLength(
      1,
    );
  });

  it("warns about the Codex quota once per window", () => {
    const quota = { quota: { usedPercent: 93, resetsAt: 1_800_000_000 } };
    const first = evaluateRly0HubAlerts(quota, {});
    expect(first.alerts[0]).toMatchObject({ id: "quota-low", title: "Codex 额度只剩 7%" });
    expect(evaluateRly0HubAlerts(quota, first.state).alerts).toEqual([]);
    const nextWindow = { quota: { usedPercent: 95, resetsAt: 1_800_018_000 } };
    expect(evaluateRly0HubAlerts(nextWindow, first.state).alerts).toHaveLength(1);
    expect(evaluateRly0HubAlerts({ quota: { usedPercent: 50 } }, {}).alerts).toEqual([]);
  });

  it("remembers the first-run guide", async () => {
    const root = await tempDir();
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      backendReloadTimeoutMs: 50,
      core: fakeCore([]).core,
    });
    expect(await service.handle("hub.state", {})).toEqual({ onboarded: false });
    await service.handle("hub.finishOnboarding", {});
    expect(await service.handle("hub.state", {})).toEqual({ onboarded: true });
  });
});

describe("Opening the Hub from Codex", () => {
  it("starts the Hub executable when this build has one", async () => {
    const { openRly0Hub } = await import("../src/rly0-appearance/hub-autostart.js");
    const started: string[] = [];
    if (process.platform === "win32") {
      expect(
        openRly0Hub(
          "C:/Hub",
          () => true,
          (file) => started.push(file),
        ),
      ).toEqual({
        available: true,
        ok: true,
      });
      expect(started).toEqual([path.win32.join("C:/Hub", "bin", "rly0-hub.exe")]);
    }
    expect(
      openRly0Hub(
        "C:\Hub",
        () => false,
        (file) => started.push(file),
      ),
    ).toEqual({
      available: false,
      ok: false,
    });
  });
});

describe("零号中转 first", () => {
  it("lists 零号 before other relays and shows its balance in dollars like rly0.com", async () => {
    const root = await tempDir();
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      backendReloadTimeoutMs: 50,
      core: fakeCore([
        relay("aaaaaaaaaaaa", "https://other.example/v1"),
        relay("bbbbbbbbbbbb", "https://api.rly0.com/v1"),
      ]).core,
    });
    const list = (await service.handle("relay.list", {})) as { relays: { id: string }[] };
    expect(list.relays.map((r) => r.id)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
    expect(await service.handle("balance.get", {})).toMatchObject({ unit: "USD", balance: 86.4 });
    expect(await service.handle("relay.balance", { id: "aaaaaaaaaaaa" })).toMatchObject({
      unit: "CNY",
    });
    expect(await service.handle("home.summary", {})).toMatchObject({
      currentAccount: { loggedIn: true, saved: false, email: "me@example.com" },
    });
  });
});

describe("AI 助手 catalog and relay logos", () => {
  it("lists official agents first and hides agents for domestic models", async () => {
    const { listRly0HubAgents, RLY0_HUB_HIDDEN_AGENTS } =
      await import("../src/rly0-hub-service/agents.js");
    const agents = listRly0HubAgents({ PATH: "" }, "win32", () => false);
    expect(agents.map((a) => a.id)).toEqual([
      "claude-code",
      "antigravity",
      "grok",
      "opencode",
      "pi",
      "hermes",
      "cursor-cli",
      "kiro-cli",
    ]);
    expect(agents.filter((a) => a.category === "official").map((a) => a.vendor)).toEqual([
      "Anthropic",
      "Google",
      "xAI",
    ]);
    for (const hidden of RLY0_HUB_HIDDEN_AGENTS)
      expect(agents.map((a) => a.id)).not.toContain(hidden);
    expect(agents.find((a) => a.id === "opencode")?.manualCommand).toBe(
      "npm install -g opencode-ai",
    );
  });

  it("opens only the catalog's own docs pages", async () => {
    const root = await tempDir();
    const opened: string[] = [];
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      backendReloadTimeoutMs: 50,
      core: fakeCore([]).core,
      openUrl: (url) => opened.push(url),
    });
    await service.handle("links.agentDocs", { agent: "opencode" });
    await expect(service.handle("links.agentDocs", { agent: "https://evil" })).rejects.toThrow(
      "INVALID_PARAMS",
    );
    expect(opened).toEqual(["https://opencode.ai/docs"]);
  });

  it("reads a Sub2API site's logo as a data URI and nothing else", async () => {
    const { fetchRelayLogo } = await import("../src/rly0-hub-service/relay-logo.js");
    const png = Buffer.from([137, 80, 78, 71]);
    const seen: string[] = [];
    const fake = async (url: string) => {
      seen.push(url);
      if (url === "https://api.example.com/api/v1/settings/public")
        return new Response("nope", { status: 404 });
      if (url === "https://api.example.com/favicon.ico") return new Response("x", { status: 404 });
      if (url === "https://example.com/api/v1/settings/public")
        return Response.json({ code: 0, data: { site_name: "Example", site_logo: "/logo.png" } });
      if (url === "https://example.com/logo.png")
        return new Response(png, { headers: { "content-type": "image/png" } });
      return new Response("", { status: 404 });
    };
    const result = await fetchRelayLogo("https://api.example.com/v1", fake);
    expect(result).toEqual({
      logo: `data:image/png;base64,${png.toString("base64")}`,
      siteName: "Example",
    });
    const html = async () => new Response("<html>", { headers: { "content-type": "text/html" } });
    expect(await fetchRelayLogo("https://relay.example/v1", html)).toEqual({
      logo: null,
      siteName: null,
    });
    expect(await fetchRelayLogo("http://plain.example/v1", fake)).toEqual({
      logo: null,
      siteName: null,
    });
  });
});

describe("Auto-switch before the Codex quota runs out", () => {
  const usage = (used5h: number, usedWeekly = 0, resetsAt = 1_800_000_000) => ({
    windows: [
      { kind: "primary" as const, usedPercent: used5h, resetsAt },
      { kind: "secondary" as const, usedPercent: usedWeekly },
    ],
    source: "live" as const,
  });
  const account = (id: string, used5h: number | null, extra: Record<string, unknown> = {}) => ({
    id,
    alias: `账号${id.slice(-1)}`,
    current: false,
    ...(used5h === null ? {} : { lastUsage: usage(used5h) }),
    ...extra,
  });

  it("picks the saved account with the most quota and skips unknown or low ones", async () => {
    const { decideAutoSwitch, RLY0_AUTO_SWITCH_DEFAULTS } =
      await import("../src/rly0-hub-service/auto-switch.js");
    const on = { ...RLY0_AUTO_SWITCH_DEFAULTS, enabled: true };
    const accounts = [
      account("aaaaaaaaaaa1", 40),
      account("aaaaaaaaaaa2", 10),
      account("aaaaaaaaaaa3", null),
      account("aaaaaaaaaaa4", 95),
    ] as never;
    expect(decideAutoSwitch(on, { id: "c", usage: usage(50) }, accounts)).toBeNull();
    expect(
      decideAutoSwitch({ ...on, enabled: false }, { id: "c", usage: usage(99) }, accounts),
    ).toBeNull();
    expect(decideAutoSwitch(on, { id: "c", usage: usage(90) }, accounts)).toEqual({
      reason: { window: "5h", left: 10, resetsAt: 1_800_000_000 },
      target: { id: "aaaaaaaaaaa2", name: "账号2", left: 90 },
    });
    expect(
      decideAutoSwitch(on, { id: "c", usage: usage(10, 95) }, [
        account("aaaaaaaaaaa5", 99),
      ] as never),
    ).toMatchObject({ reason: { window: "weekly", left: 5 }, target: null });
  });

  it("asks once per window, and switches and restarts Codex in auto mode", async () => {
    const root = await tempDir();
    const switched: string[] = [];
    const restarted: number[] = [];
    const { core } = fakeCore([]);
    Object.assign(core, {
      currentAccount: async () => ({ loggedIn: true, saved: true, id: "cccccccccccc" }),
      usageCurrent: async () => ({ available: true, usage: usage(92) }),
      usageAll: async () => ({ available: true, entries: [] }),
      listAccounts: async () => ({
        available: true,
        accounts: [account("cccccccccccc", 92, { current: true }), account("bbbbbbbbbbbb", 20)],
      }),
      switchAccount: async (p: { id: string }) => {
        switched.push(p.id);
        return { available: true, switched: true };
      },
    });
    const codex = {
      status: async () => ({ running: true, canOpen: true }),
      restart: async () => {
        restarted.push(1);
        return { ok: true };
      },
    };
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      backendReloadTimeoutMs: 50,
      core,
      codex: codex as never,
    });
    await service.handle("accounts.autoSwitchSet", {
      enabled: true,
      remain5h: 15,
      remainWeekly: 10,
      mode: "ask",
    });
    const first = (await service.handle("alerts.check", {})) as {
      alerts: Record<string, unknown>[];
    };
    expect(first.alerts).toEqual([
      expect.objectContaining({
        id: "switch-suggest",
        action: "switch",
        accountId: "bbbbbbbbbbbb",
      }),
    ]);
    expect(((await service.handle("alerts.check", {})) as { alerts: unknown[] }).alerts).toEqual(
      [],
    );
    expect(switched).toEqual([]);

    await service.handle("accounts.switchAndRestart", { id: "bbbbbbbbbbbb" });
    expect(switched).toEqual(["bbbbbbbbbbbb"]);
    expect(restarted).toEqual([1]);

    const autoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-hub-auto-"));
    const auto = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: autoRoot },
      installRoot: autoRoot,
      backendReloadTimeoutMs: 50,
      core,
      codex: codex as never,
    });
    await auto.handle("accounts.autoSwitchSet", {
      enabled: true,
      remain5h: 15,
      remainWeekly: 10,
      mode: "auto",
    });
    const done = (await auto.handle("alerts.check", {})) as { alerts: Record<string, unknown>[] };
    expect(done.alerts[0]).toMatchObject({ id: "switched", title: "已切换到 账号b" });
    expect(switched).toEqual(["bbbbbbbbbbbb", "bbbbbbbbbbbb"]);
    await fs.rm(autoRoot, { recursive: true, force: true });
  });
});

describe("No-account mode from the Hub", () => {
  it("offers only relay GPT models and needs an explicit confirmation", async () => {
    const root = await tempDir();
    const { core } = fakeCore([
      relay("aaaaaaaaaaaa", "https://api.rly0.com/v1", {
        models: ["gpt-6.1-sol", "claude-opus-5", "gpt-*"],
      }),
      relay("bbbbbbbbbbbb", "https://off.example/v1", { models: ["gpt-off"], enabled: false }),
    ]);
    Object.assign(core, {
      proxyStatus: async () => ({
        available: true,
        running: true,
        port: 25917,
        baseUrl: "http://127.0.0.1:25917/v1",
      }),
    });
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root, CODEX_HOME: path.join(root, "codex") },
      installRoot: root,
      backendReloadTimeoutMs: 50,
      core,
    });
    expect(await service.handle("relay.noAccountStatus", {})).toMatchObject({
      enabled: false,
      models: ["gpt-6.1-sol"],
    });
    await expect(service.handle("relay.noAccountEnable", { model: "gpt-6.1-sol" })).rejects.toThrow(
      "INVALID_PARAMS",
    );
    await expect(
      service.handle("relay.noAccountEnable", { model: "gpt-off", confirmed: true }),
    ).rejects.toThrow("NO_ACCOUNT_MODEL_UNKNOWN");
    expect(
      await service.handle("relay.noAccountEnable", { model: "gpt-6.1-sol", confirmed: true }),
    ).toEqual({
      ok: true,
      noAccount: true,
    });
    expect(await service.handle("relay.noAccountStatus", {})).toMatchObject({
      enabled: true,
      model: "gpt-6.1-sol",
    });
    await service.handle("relay.noAccountDisable", {});
    expect(await service.handle("relay.noAccountStatus", {})).toMatchObject({ enabled: false });
  });
});

describe("Tray notice thresholds", () => {
  it("follows the person's own balance and quota thresholds", async () => {
    const { evaluateRly0HubAlerts } = await import("../src/rly0-hub-service/alerts.js");
    const input = {
      balance: { amount: 4, unit: "USD" as const },
      quota: { usedPercent: 85, resetsAt: 1 },
    };
    expect(evaluateRly0HubAlerts(input, {}).alerts).toEqual([]);
    expect(
      evaluateRly0HubAlerts(input, {}, { balanceUsd: 5, quotaUsedPercent: 80 }).alerts.map(
        (a) => a.id,
      ),
    ).toEqual(["balance-low", "quota-low"]);
    // CNY relays use the same threshold in yuan (×7).
    expect(
      evaluateRly0HubAlerts(
        { balance: { amount: 30, unit: "CNY" } },
        {},
        { balanceUsd: 5, quotaUsedPercent: 90 },
      ).alerts,
    ).toHaveLength(1);
    // 0 / 100 turn a notice off.
    expect(
      evaluateRly0HubAlerts(
        { ...input, quota: { usedPercent: 99 } },
        {},
        { balanceUsd: 0, quotaUsedPercent: 100 },
      ).alerts,
    ).toEqual([]);
  });
});
