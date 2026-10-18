import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Rly0CoreBridge } from "../src/rly0-core/index.js";
import { Rly0LocalDiscovery } from "../src/rly0-hub-service/local-discovery.js";
import { Rly0HubService } from "../src/rly0-hub-service/service.js";

const OAT = "sk-ant-oat01-" + "A".repeat(60) + "QwAA";
const ANT = "sk-ant-api03-" + "B".repeat(60) + "zzzz";
const RELAY = "sk-relay-" + "C".repeat(40) + "9999";
const CODEX_RELAY = "sk-" + "D".repeat(40) + "7777";
const GEMINI = "AIza" + "E".repeat(35);
const XAI = "xai-" + "F".repeat(40);
const SETUP = "sk-ant-oat01-" + "G".repeat(60) + "SETU";
const BROWSER = "sk-ant-oat01-" + "H".repeat(60) + "BROW";

let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function home(): Promise<string> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-discovery-"));
  const write = async (rel: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  };
  await write(
    ".claude/settings.json",
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://relay.example.com", ANTHROPIC_AUTH_TOKEN: RELAY },
    }),
  );
  await write(
    ".codex/config.toml",
    [
      'model_provider = "custom"',
      'model = "gpt-5.5"',
      "[model_providers.custom]",
      'base_url = "https://api.shuaiapi.example/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "[model_providers.local]",
      'base_url = "http://127.0.0.1:25817/codex/router/v1"',
      'experimental_bearer_token = "sk-local-should-be-ignored-1234"',
    ].join("\n"),
  );
  await write(".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: CODEX_RELAY, tokens: null }));
  await write(".gemini/.env", `GEMINI_API_KEY="${GEMINI}"\n`);
  await write(".grok/user-settings.json", JSON.stringify({ apiKey: XAI }));
  return root;
}

const environment = (dir: string) => ({
  USERPROFILE: dir,
  HOME: dir,
  CODEX_HOME: path.join(dir, ".codex"),
  CODEXHOST_DATA_DIR: path.join(dir, "hub"),
  CLAUDE_CODE_OAUTH_TOKEN: OAT,
});

describe("finding what this computer already uses", () => {
  it("finds tokens, keys and relays from env, Claude, Codex, Gemini and Grok", async () => {
    const dir = await home();
    const discovery = new Rly0LocalDiscovery({
      environment: environment(dir),
      platform: "win32",
      userEnvironment: async () => ({ ANTHROPIC_API_KEY: ANT }),
      // Claude Code's stored logins: a setup-token token is taken, a browser sign-in is not.
      claudeCredentials: async () => [
        JSON.stringify({ claudeAiOauth: { accessToken: SETUP, expiresAt: 1 } }),
        JSON.stringify({ claudeAiOauth: { accessToken: BROWSER, refreshToken: "sk-ant-ort01-x" } }),
      ],
    });
    const items = await discovery.scan();
    const summary = items.map((i) => [i.kind, i.vendor, i.baseUrl, i.keyMask, i.agent]);
    expect(summary).toEqual(
      expect.arrayContaining([
        ["officialKey", "anthropic", null, "····QwAA", "claude"],
        ["officialKey", "anthropic", null, "····zzzz", "claude"],
        ["relay", "anthropic", "https://relay.example.com", "····9999", "claude"],
        ["relay", "openai", "https://api.shuaiapi.example/v1", "····7777", "codex"],
        ["officialKey", "google", null, `····${GEMINI.slice(-4)}`, "gemini"],
        ["officialKey", "xai", null, `····${XAI.slice(-4)}`, "grok"],
        ["officialKey", "anthropic", null, "····SETU", "claude"],
      ]),
    );
    expect(items).toHaveLength(7);
    expect(JSON.stringify(items)).not.toContain("BROW");
    expect(items.find((i) => i.kind === "relay" && i.agent === "codex")?.model).toBe("gpt-5.5");
    // The masked list never carries a value.
    for (const secret of [OAT, ANT, RELAY, CODEX_RELAY, GEMINI, XAI, SETUP])
      expect(JSON.stringify(items)).not.toContain(secret);
  });

  it("marks what the Hub already has and imports the rest without switching Claude Code", async () => {
    const dir = await home();
    const relays: {
      id: string;
      name: string;
      baseUrl: string;
      hasKey: boolean;
      keyMask: string;
      models: string[];
      enabled: boolean;
    }[] = [
      {
        id: "aaaaaaaaaaaa",
        name: "Anthropic 官方 API Key",
        baseUrl: "https://api.anthropic.com",
        hasKey: true,
        keyMask: "****QwAA",
        models: [],
        enabled: true,
      },
    ];
    const core = {
      status: async () => ({ available: false }),
      filters: async () => null,
      listRelays: async () => ({ available: true, relays }),
      addRelay: async (p: { name: string; baseUrl: string; apiKey: string }) => {
        const id = String(relays.length).padStart(12, "b");
        relays.push({
          id,
          name: p.name,
          baseUrl: p.baseUrl,
          hasKey: true,
          keyMask: `****${p.apiKey.slice(-4)}`,
          models: [],
          enabled: true,
        });
        return { available: true, id };
      },
      updateRelay: async (p: { id: string; apiKey?: string }) => {
        const relay = relays.find((r) => r.id === p.id);
        if (relay && p.apiKey) relay.keyMask = `****${p.apiKey.slice(-4)}`;
        return { available: true };
      },
      testRelay: async () => ({ available: true, ok: false, error: "RELAY_NETWORK" }),
      proxyStatus: async () => ({ available: true, running: true, port: 1 }),
      proxyStart: async () => ({ available: true, running: true, port: 1 }),
    } as unknown as Rly0CoreBridge;
    const service = new Rly0HubService({
      environment: environment(dir),
      installRoot: dir,
      platform: "linux",
      core,
    });
    const scan = (await service.handle("discovery.scan", {})) as {
      items: { id: string; keyMask: string; kind: string; state: string; vendor: string }[];
    };
    expect(scan.items.find((i) => i.keyMask === "····QwAA")?.state).toBe("saved");
    expect(scan.items.find((i) => i.keyMask === "····9999")?.state).toBe("new");
    const relayItems = scan.items.filter((i) => i.kind === "relay").map((i) => i.id);
    const result = (await service.handle("discovery.import", { ids: relayItems })) as {
      imported: number;
    };
    expect(result.imported).toBe(2);
    expect(relays.map((r) => r.baseUrl)).toEqual([
      "https://api.anthropic.com",
      "https://relay.example.com",
      "https://api.shuaiapi.example/v1",
    ]);
    const after = (await service.handle("discovery.scan", {})) as typeof scan;
    expect(after.items.filter((i) => i.kind === "relay").every((i) => i.state === "saved")).toBe(
      true,
    );
    // Taking over a key does not change which login Claude Code uses.
    expect(await service.handle("agents.relays.get", {})).toMatchObject({ claudeCode: null });
  });
});
