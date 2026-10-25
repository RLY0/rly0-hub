import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import { Rly0GlobalBridge, rly0GlobalConfigFile } from "../src/rly0-bridge/global-config.js";
import { renderAntigravityMcp, renderHermesMcpLines } from "../src/rly0-bridge/renderers.js";
import { syncCodexMemoryServer } from "../src/rly0-memory/codex-config.js";
import { updateMcpServerConnection } from "../src/rly0-mcp/toml-editor.js";
import { createBridgeRoutes } from "../src/rly0-hub-service/bridge-routes.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rly0-bridge-"));
  roots.push(root);
  const environment = {
    USERPROFILE: path.join(root, "home"),
    HOME: path.join(root, "home"),
    CODEX_HOME: path.join(root, "home", ".codex"),
    CODEXHOST_DATA_DIR: path.join(root, "data"),
  };
  await mkdir(environment.CODEX_HOME, { recursive: true });
  return { root, environment };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const launch = { command: "C:/rly0/runtime/node.exe", args: ["C:/rly0/app/host-runtime.mjs", "--rly0-memory-mcp"], env: { RLY0_MEMORY_DIR: "C:/data/memory", RLY0_MEMORY_AGENT: "codex" } };
const memoryServer = { type: "stdio" as const, ...launch, env: { ...launch.env, RLY0_MEMORY_AGENT: "x" } };

describe("MCP edit keeps the rest of a server's settings", () => {
  it("replaces only command / args / url", () => {
    const content = [
      "[mcp_servers.docs]",
      'command = "old"',
      "args = [",
      '  "a",',
      "]",
      "startup_timeout_sec = 20",
      "",
      "[mcp_servers.docs.env]",
      'TOKEN = "keep"',
      "",
    ].join("\n");
    const next = updateMcpServerConnection(content, { type: "stdio", name: "docs", command: "npx", args: ["-y", "docs"] });
    expect(parse(next)).toEqual({
      mcp_servers: { docs: { command: "npx", args: ["-y", "docs"], startup_timeout_sec: 20, env: { TOKEN: "keep" } } },
    });
    expect(() => updateMcpServerConnection(content, { type: "http", name: "other", url: "https://x" })).toThrow("MCP_SERVER_NOT_FOUND");
  });
});

describe("Codex's own rly0_memory entry", () => {
  it("adds, keeps, and removes exactly its table with a backup each time", async () => {
    const { environment } = await fixture();
    const file = path.join(environment.CODEX_HOME, "config.toml");
    await writeFile(file, 'model = "x"\n\n[mcp_servers.docs]\nurl = "https://docs"\n');
    expect(await syncCodexMemoryServer({ environment, enabled: true, launch })).toBe("added");
    const added = parse(await readFile(file, "utf8")) as { mcp_servers: Record<string, unknown>; model: string };
    expect(added.model).toBe("x");
    expect(added.mcp_servers.docs).toEqual({ url: "https://docs" });
    expect(added.mcp_servers.rly0_memory).toEqual({ command: launch.command, args: launch.args, env: launch.env });
    expect(await syncCodexMemoryServer({ environment, enabled: true, launch })).toBe("unchanged");
    expect(await syncCodexMemoryServer({ environment, enabled: false, launch })).toBe("removed");
    expect(parse(await readFile(file, "utf8"))).toEqual({ model: "x", mcp_servers: { docs: { url: "https://docs" } } });
    expect((await readdir(environment.CODEX_HOME)).filter((name) => name.includes(".rly0-bak-"))).toHaveLength(2);
    expect(await syncCodexMemoryServer({ environment, enabled: false, launch })).toBe("unchanged");
  });
});

describe("opt-in global blocks", () => {
  it("renders the documented shapes", () => {
    expect(renderAntigravityMcp({ m: memoryServer, h: { type: "http", url: "https://h", headers: {} } })).toEqual({
      m: { command: launch.command, args: launch.args, env: memoryServer.env },
      h: { serverUrl: "https://h" },
    });
    expect(renderHermesMcpLines({ m: { type: "stdio", command: "n", args: [], env: {} } })).toEqual(['  "m": {"command":"n","args":[]}']);
  });

  it("Antigravity: adds only credential-free Hub entries and removes them cleanly", async () => {
    const { environment } = await fixture();
    const file = rly0GlobalConfigFile("antigravity", environment);
    await mkdir(path.dirname(file), { recursive: true });
    const original = { mcpServers: { mine: { command: "x" } }, other: true };
    await writeFile(file, JSON.stringify(original));
    const bridge = new Rly0GlobalBridge({
      environment,
      servers: async () => ({
        rly0_memory: memoryServer,
        codex_secret: { type: "stdio", command: "s", args: [], env: { API_KEY: "k" } },
      }),
    });
    expect((await bridge.status("antigravity")).enabled).toBe(false);
    const on = await bridge.set("antigravity", true);
    expect(on).toMatchObject({ enabled: true, servers: ["rly0-memory"], skipped: ["secret"] });
    const written = JSON.parse(await readFile(file, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(written.mcpServers)).toEqual(["mine", "rly0-memory"]);
    expect(await readFile(file, "utf8")).not.toContain('"k"');
    await bridge.set("antigravity", false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(original);
  });

  it("Antigravity: refuses a commented file instead of dropping the comments", async () => {
    const { environment } = await fixture();
    const file = rly0GlobalConfigFile("antigravity", environment);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{\n  // mine\n  "mcpServers": {}\n}\n');
    const bridge = new Rly0GlobalBridge({ environment, servers: async () => ({ rly0_memory: memoryServer }) });
    await expect(bridge.set("antigravity", true)).rejects.toThrow("GLOBAL_CONFIG_UNPARSEABLE");
  });

  it("Hermes: a marked block under mcp_servers with the file's indentation, removed exactly", async () => {
    const { environment } = await fixture();
    const file = rly0GlobalConfigFile("hermes", environment);
    await mkdir(path.dirname(file), { recursive: true });
    const original = "model: x\nmcp_servers:\n    github:\n      command: gh\nother: 1\n";
    await writeFile(file, original);
    const bridge = new Rly0GlobalBridge({ environment, servers: async () => ({ rly0_memory: memoryServer }) });
    await bridge.set("hermes", true);
    const text = await readFile(file, "utf8");
    expect(text).toContain('    "rly0-memory": {"command":');
    expect(text.indexOf("RLY/0 Hub managed")).toBeGreaterThan(text.indexOf("mcp_servers:"));
    await bridge.set("hermes", false);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("Hermes: creates mcp_servers when absent and takes it away again", async () => {
    const { environment } = await fixture();
    const file = rly0GlobalConfigFile("hermes", environment);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "model: x\n");
    const bridge = new Rly0GlobalBridge({ environment, servers: async () => ({ rly0_memory: memoryServer }) });
    await bridge.set("hermes", true);
    expect(await readFile(file, "utf8")).toContain("mcp_servers:  # added by RLY/0 Hub");
    await bridge.set("hermes", false);
    expect((await readFile(file, "utf8")).trim()).toBe("model: x");
  });
});

describe("打通设置 memory routes", () => {
  it("adds, lists, searches, exports and forgets memories", async () => {
    const { environment, root } = await fixture();
    const opened: string[] = [];
    const bridge = createBridgeRoutes({ environment, installRoot: path.join(root, "install"), openFolder: (d) => opened.push(d), memoryLaunch: null });
    const repo = path.join(root, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    const added = (await bridge.routes["memory.add"]({ text: "Use pnpm here", scope: "project", project: repo })) as { id: string };
    await bridge.routes["memory.add"]({ text: "Answer in Chinese", scope: "global", tags: ["lang"] });
    await expect(bridge.routes["memory.add"]({ text: "x", scope: "project" })).rejects.toThrow("MEMORY_PROJECT_REQUIRED");
    const list = (await bridge.routes["memory.list"]({})) as { records: { text: string; agent: string }[]; total: number; projects: number };
    expect(list).toMatchObject({ total: 2, projects: 1 });
    expect(list.records.every((r) => r.agent === "hub")).toBe(true);
    expect(((await bridge.routes["memory.list"]({ query: "pnpm" })) as { records: unknown[] }).records).toHaveLength(1);
    expect(((await bridge.routes["memory.list"]({ scope: "global" })) as { records: unknown[] }).records).toHaveLength(1);
    const exported = (await bridge.routes["memory.export"]({})) as { file: string; count: number };
    expect(exported.count).toBe(2);
    expect(JSON.parse(await readFile(exported.file, "utf8"))).toHaveLength(2);
    expect(await bridge.routes["memory.forget"]({ id: added.id })).toEqual({ forgotten: true });
    await bridge.routes["memory.openFolder"]({});
    expect(opened).toEqual([path.join(environment.CODEXHOST_DATA_DIR, "memory")]);
    expect(await bridge.routes["bridge.status"]({})).toMatchObject({
      memoryServer: { available: false },
      globals: [
        { agent: "antigravity", enabled: false },
        { agent: "hermes", enabled: false },
      ],
    });
    await expect(bridge.routes["memory.list"]({ scope: "nope" })).rejects.toThrow("INVALID_PARAMS");
  });

  it("gives Codex the memory server when memory sharing is on (the default)", async () => {
    const { environment, root } = await fixture();
    const bridge = createBridgeRoutes({ environment, installRoot: path.join(root, "install"), openFolder: () => undefined, memoryLaunch: launch });
    await bridge.start();
    const config = parse(await readFile(path.join(environment.CODEX_HOME, "config.toml"), "utf8")) as { mcp_servers: Record<string, unknown> };
    expect(config.mcp_servers.rly0_memory).toMatchObject({ command: launch.command });
  });
});
