import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { externalMcp, syncExternalMcp } from "../src/rly0-mcp/discovery.js";
import { Rly0McpManager } from "../src/rly0-mcp/index.js";
import { syncNativeResourcesIfChanged } from "../src/rly0-bridge/native-resources.js";
import { sharedResourcesProvider } from "../src/shared-harness-resources.js";

describe("external MCP discovery (synthetic)", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let config: string;
  const raw = { command: "synthetic-mcp", args: ["--offline"] };
  async function install(servers: Record<string, unknown>) {
    await fs.writeFile(
      path.join(root, ".claude.json"),
      JSON.stringify({
        mcpServers: servers,
        projects: { private: { mcpServers: { never: raw } } },
      }),
    );
  }
  async function codex() {
    return parse(await fs.readFile(config, "utf8"));
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-external-mcp-synthetic-"));
    env = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, ".codex"),
      CODEXHOST_DATA_DIR: path.join(root, "hub"),
      RLY0_MEMORY_DIR: path.join(root, "memory"),
    };
    config = path.join(root, ".codex", "config.toml");
    await fs.mkdir(path.dirname(config));
    await fs.writeFile(config, 'model = "synthetic"\n');
  });
  afterEach(async () => {
    await syncNativeResourcesIfChanged(env, { memory: false, skills: false, mcp: false });
    await fs.rm(root, { recursive: true, force: true });
  });
  it("lists external sources without exporting env/header values or project entries", async () => {
    await install({ docs: { ...raw, env: { PRIVATE: "synthetic-env-value" } } });
    const listed = await new Rly0McpManager({ environment: env }).list();
    expect(listed.servers).toEqual([
      {
        name: "docs",
        type: "stdio",
        enabled: true,
        command: raw.command,
        args: raw.args,
        envKeys: ["PRIVATE"],
        source: "claude",
        sourcePath: path.join(root, ".claude.json"),
        external: true,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("synthetic-env-value");
    expect(JSON.stringify(listed)).not.toContain("never");
  });
  it("imports credential-free MCPs, follows updates and removes only Hub-owned copies", async () => {
    await install({ docs: raw });
    const original = await fs.readFile(path.join(root, ".claude.json"), "utf8");
    await syncExternalMcp(env, true);
    expect(await codex()).toEqual({
      model: "synthetic",
      mcp_servers: { docs: { ...raw, enabled: true } },
    });
    const first = await fs.readFile(config, "utf8");
    await syncExternalMcp(env, true);
    expect(await fs.readFile(config, "utf8")).toBe(first);
    expect(await fs.readFile(path.join(root, ".claude.json"), "utf8")).toBe(original);
    await install({ docs: { command: "synthetic-mcp-v2" } });
    await syncExternalMcp(env, true);
    expect(await codex()).toEqual({
      model: "synthetic",
      mcp_servers: { docs: { command: "synthetic-mcp-v2", enabled: true } },
    });
    await syncExternalMcp(env, false);
    expect(await codex()).toEqual({ model: "synthetic" });
    expect((await externalMcp(env))[0]?.raw.command).toBe("synthetic-mcp-v2");
  });
  it("preserves native same-name configurations and later user edits", async () => {
    await install({ docs: raw });
    await fs.writeFile(config, '[mcp_servers.docs]\ncommand="user-owned"\n');
    await syncExternalMcp(env, true);
    expect(await codex()).toEqual({ mcp_servers: { docs: { command: "user-owned" } } });
    await fs.writeFile(config, 'model="synthetic"\n');
    await syncExternalMcp(env, true);
    await fs.writeFile(config, '[mcp_servers.docs]\ncommand="user-edited"\n');
    await syncExternalMcp(env, false);
    expect(await codex()).toEqual({ mcp_servers: { docs: { command: "user-edited" } } });
  });
  it("shares credential-bearing MCPs only through process options; skips unsupported auth/policies", async () => {
    await install({
      private: { ...raw, env: { PRIVATE: "synthetic-process-value" } },
      restricted: { ...raw, allowedTools: ["read"] },
      oauth: { ...raw, oauth: { scope: "read" } },
    });
    await syncExternalMcp(env, true);
    expect(await fs.readFile(config, "utf8")).not.toContain("private");
    const shared = await sharedResourcesProvider(env)(root, { harnessId: "synthetic", mcp: true });
    expect(shared.mcpServers).toEqual({
      codex_private: {
        type: "stdio",
        command: raw.command,
        args: raw.args,
        env: { PRIVATE: "synthetic-process-value" },
      },
    });
    expect(shared.context).not.toContain("synthetic-process-value");
    expect(Object.keys(shared.mcpServers)).not.toContain("codex_restricted");
  });
  it("discovers custom Claude config, Cursor, Gemini and Antigravity user maps", async () => {
    env.CLAUDE_CONFIG_DIR = path.join(root, "custom");
    const files = [
      [path.join(root, "custom", ".claude.json"), "custom"],
      [path.join(root, ".cursor", "mcp.json"), "cursor"],
      [path.join(root, ".gemini", "settings.json"), "gemini"],
      [path.join(root, ".gemini", "config", "mcp_config.json"), "agy"],
    ] as const;
    for (const [file, name] of files) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ mcpServers: { [name]: raw } }));
    }
    expect((await externalMcp(env)).map((v) => v.name)).toEqual([
      "custom",
      "cursor",
      "gemini",
      "agy",
    ]);
  });
  it("keeps external toggles through installer updates and supports removing process-only servers", async () => {
    await install({ docs: raw, private: { ...raw, env: { PRIVATE: "synthetic-value" } } });
    const manager = new Rly0McpManager({ environment: env });
    await syncExternalMcp(env, true);
    expect(await manager.setEnabled("docs", false)).toEqual({ ok: true });
    await install({
      docs: { command: "synthetic-mcp-v2" },
      private: { ...raw, env: { PRIVATE: "synthetic-value" } },
    });
    await syncExternalMcp(env, true);
    expect(await codex()).toEqual({
      model: "synthetic",
      mcp_servers: { docs: { command: "synthetic-mcp-v2", enabled: false } },
    });
    expect(await manager.setEnabled("docs", true)).toEqual({ ok: true });
    await manager.remove("private");
    expect((await manager.list()).servers).toEqual([
      expect.objectContaining({ name: "docs", enabled: true }),
      expect.objectContaining({ name: "private", enabled: false, external: true }),
    ]);
  });
  it("fails safely on invalid Codex config and leaves both files untouched", async () => {
    await install({ docs: raw });
    await fs.writeFile(config, "[broken");
    await expect(syncExternalMcp(env, true)).rejects.toThrow("GLOBAL_CONFIG_MCP_CONFIG_INVALID");
    expect(await fs.readFile(config, "utf8")).toBe("[broken");
  });
});
