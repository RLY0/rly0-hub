import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Rly0McpManager, rly0McpRpcError } from "../../src/rly0-mcp/index.js";

describe("Rly0McpManager", () => {
  let codexHome: string;
  let manager: Rly0McpManager;

  beforeEach(async () => {
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-mcp-test-"));
    manager = new Rly0McpManager({ environment: { CODEX_HOME: codexHome } });
  });

  afterEach(async () => {
    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("reports configExists: false when config.toml is absent", async () => {
    const result = await manager.list();
    expect(result).toEqual({
      configPath: path.join(codexHome, "config.toml"),
      configExists: false,
      totalCount: 0,
      enabledCount: 0,
      servers: [],
    });
  });

  it("lists servers, counts, and hides env/header values", async () => {
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      [
        "[mcp_servers.docs]",
        'command = "npx"',
        'args = ["-y", "docs-server"]',
        "",
        "[mcp_servers.docs.env]",
        'API_KEY = "super-secret"',
        "",
        "[mcp_servers.remote]",
        'url = "https://example.com/mcp"',
        "enabled = false",
        "",
        "[mcp_servers.remote.headers]",
        'Authorization = "Bearer super-secret"',
      ].join("\n"),
      "utf8",
    );
    const result = await manager.list();
    expect(result.configExists).toBe(true);
    expect(result.totalCount).toBe(2);
    expect(result.enabledCount).toBe(1);
    const docs = result.servers.find((server) => server.name === "docs");
    expect(docs).toMatchObject({
      type: "stdio",
      enabled: true,
      command: "npx",
      args: ["-y", "docs-server"],
    });
    expect(docs?.envKeys).toEqual(["API_KEY"]);
    expect(JSON.stringify(docs)).not.toContain("super-secret");
    const remote = result.servers.find((server) => server.name === "remote");
    expect(remote).toMatchObject({ type: "http", enabled: false, url: "https://example.com/mcp" });
    expect(remote?.headerKeys).toEqual(["Authorization"]);
    expect(JSON.stringify(remote)).not.toContain("Bearer super-secret");
  });

  it("surfaces a parse error instead of throwing", async () => {
    await fs.writeFile(path.join(codexHome, "config.toml"), "not [ valid toml", "utf8");
    const result = await manager.list();
    expect(result.configExists).toBe(true);
    expect(result.servers).toEqual([]);
    expect(result.parseError).toBeTruthy();
  });

  it("adds, toggles, and removes a server, writing a timestamped backup each time", async () => {
    await manager.add({ type: "stdio", name: "tool", command: "node", args: ["server.js"] });
    let entries = await fs.readdir(codexHome);
    expect(entries).toContain("config.toml");
    expect(entries.some((name) => name.startsWith("config.toml.rly0-bak-"))).toBe(false); // no prior file to back up

    await manager.setEnabled("tool", false);
    entries = await fs.readdir(codexHome);
    expect(entries.some((name) => name.startsWith("config.toml.rly0-bak-"))).toBe(true);
    let list = await manager.list();
    expect(list.servers).toEqual([expect.objectContaining({ name: "tool", enabled: false })]);

    await manager.remove("tool");
    list = await manager.list();
    expect(list.servers).toEqual([]);
  });

  it("rejects an unsafe name defensively even though the RPC boundary already validates it", async () => {
    await expect(manager.setEnabled("../escape", true)).rejects.toThrow("MCP_SERVER_INVALID_NAME");
  });

  it("rejects adding a duplicate server", async () => {
    await manager.add({ type: "http", name: "svc", url: "https://a" });
    await expect(manager.add({ type: "http", name: "svc", url: "https://b" })).rejects.toThrow(
      "MCP_SERVER_ALREADY_EXISTS",
    );
  });
});

describe("rly0McpRpcError", () => {
  it("forwards known business errors by message", () => {
    expect(rly0McpRpcError(new Error("MCP_SERVER_NOT_FOUND"))).toEqual({
      code: -32000,
      message: "MCP_SERVER_NOT_FOUND",
    });
  });

  it("collapses unknown failures to a generic message", () => {
    expect(rly0McpRpcError(new Error("some internal path leak"))).toEqual({
      code: -32000,
      message: "MCP_OPERATION_FAILED",
    });
  });
});
