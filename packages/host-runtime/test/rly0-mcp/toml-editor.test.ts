import { describe, expect, it } from "vitest";

import {
  appendMcpServer,
  findMcpServerRange,
  listMcpServerNames,
  removeMcpServer,
  setMcpServerEnabled,
} from "../../src/rly0-mcp/toml-editor.js";

const SAMPLE = `# top comment
[profile]
name = "default"

# a stdio server
[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-server"]

[mcp_servers.docs.env]
API_KEY = "secret-value"

[mcp_servers.search]
url = "https://example.com/mcp"
enabled = false
`;

describe("findMcpServerRange", () => {
  it("finds the header, direct-key end, and whole-block end including subtables", () => {
    const lines = SAMPLE.split("\n");
    const range = findMcpServerRange(lines, "docs");
    expect(range).not.toBeNull();
    if (!range) throw new Error("expected a range");
    expect(lines[range.start]).toBe("[mcp_servers.docs]");
    expect(lines[range.directEnd]).toBe("[mcp_servers.docs.env]");
    expect(lines[range.blockEnd]).toBe("[mcp_servers.search]");
  });

  it("returns null for an unknown server", () => {
    expect(findMcpServerRange(SAMPLE.split("\n"), "missing")).toBeNull();
  });
});

describe("listMcpServerNames", () => {
  it("lists every top-level mcp_servers table once", () => {
    expect(listMcpServerNames(SAMPLE.split("\n"))).toEqual(["docs", "search"]);
  });
});

describe("setMcpServerEnabled", () => {
  it("inserts enabled = false without touching comments or other tables", () => {
    const next = setMcpServerEnabled(SAMPLE, "docs", false);
    expect(next).toContain("# top comment");
    expect(next).toContain("# a stdio server");
    expect(next.split("\n")).toEqual(
      expect.arrayContaining(["[mcp_servers.docs]", "enabled = false"]),
    );
    const docsIndex = next.split("\n").indexOf("[mcp_servers.docs]");
    expect(next.split("\n")[docsIndex + 1]).toBe("enabled = false");
  });

  it("removes an existing enabled = false line when re-enabling", () => {
    const next = setMcpServerEnabled(SAMPLE, "search", true);
    expect(next).not.toContain("enabled = false");
    expect(next).toContain('url = "https://example.com/mcp"');
  });

  it("is a no-op when already enabled and asked to enable again", () => {
    const next = setMcpServerEnabled(SAMPLE, "docs", true);
    expect(next).toBe(SAMPLE);
  });

  it("throws for an unknown server", () => {
    expect(() => setMcpServerEnabled(SAMPLE, "missing", true)).toThrow("MCP_SERVER_NOT_FOUND");
  });
});

describe("removeMcpServer", () => {
  it("removes the whole block including its subtable, keeping everything else intact", () => {
    const next = removeMcpServer(SAMPLE, "docs");
    expect(next).not.toContain("mcp_servers.docs");
    expect(next).not.toContain("API_KEY");
    expect(next).toContain("# top comment");
    expect(next).toContain("[mcp_servers.search]");
  });

  it("removes the last table in the file", () => {
    const next = removeMcpServer(SAMPLE, "search");
    expect(next).not.toContain("mcp_servers.search");
    expect(next).toContain("[mcp_servers.docs]");
  });
});

describe("appendMcpServer", () => {
  it("appends a new stdio server block", () => {
    const next = appendMcpServer(SAMPLE, {
      type: "stdio",
      name: "new-tool",
      command: "node",
      args: ["server.js"],
    });
    expect(next).toContain('[mcp_servers."new-tool"]');
    expect(next).toContain('command = "node"');
    expect(next).toContain('args = ["server.js"]');
    expect(next).toContain("[mcp_servers.search]"); // original content preserved
  });

  it("appends a new http server block to an empty file", () => {
    const next = appendMcpServer("", { type: "http", name: "remote", url: "https://a.example" });
    expect(next.trim().split("\n")).toEqual([
      '[mcp_servers."remote"]',
      'url = "https://a.example"',
    ]);
  });

  it("rejects a duplicate name", () => {
    expect(() => appendMcpServer(SAMPLE, { type: "http", name: "docs", url: "https://x" })).toThrow(
      "MCP_SERVER_ALREADY_EXISTS",
    );
  });

  it("escapes quotes and backslashes in generated string values", () => {
    const next = appendMcpServer("", {
      type: "stdio",
      name: "weird",
      command: 'C:\\tools\\"run".exe',
    });
    expect(next).toContain('command = "C:\\\\tools\\\\\\"run\\".exe"');
  });
});
