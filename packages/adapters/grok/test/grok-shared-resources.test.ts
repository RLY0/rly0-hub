import { describe, expect, it } from "vitest";

import {
  GROK_SHARED_CONTEXT_REQUEST,
  GROK_SHARED_MCP_REQUEST,
  grokAcpMcpServers,
  grokPromptWithSharedContext,
} from "../src/acp-transport.js";

describe("Grok shared Codex resources", () => {
  it("asks for MCP when a Session opens and for skills and memory with each prompt", () => {
    expect(GROK_SHARED_MCP_REQUEST).toEqual({ harnessId: "grok", mcp: true, memoryMcp: true });
    expect(GROK_SHARED_CONTEXT_REQUEST).toEqual({
      harnessId: "grok",
      skills: true,
      memory: true,
      memoryMcp: true,
    });
  });

  it("maps Codex MCP servers to ACP Session configuration, credentials included only there", () => {
    const servers = grokAcpMcpServers({
      mcpServers: {
        codex_local: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          env: { API_TOKEN: "synthetic-env-token" },
        },
        codex_docs: {
          type: "http",
          url: "https://docs.invalid/mcp",
          headers: { Authorization: "Bearer synthetic-header-token" },
        },
      },
      context: "",
    });
    expect(servers).toEqual([
      {
        name: "codex_local",
        command: "node",
        args: ["server.js"],
        env: [{ name: "API_TOKEN", value: "synthetic-env-token" }],
      },
      {
        name: "codex_docs",
        type: "http",
        url: "https://docs.invalid/mcp",
        headers: [{ name: "Authorization", value: "Bearer synthetic-header-token" }],
      },
    ]);
    expect(grokAcpMcpServers(undefined)).toEqual([]);
  });

  it("puts only the reference context before the person's request", () => {
    expect(grokPromptWithSharedContext("[RLY/0 shared resources]", "fix the test")).toBe(
      "[RLY/0 shared resources]\n\n[Current user request]\nfix the test",
    );
    expect(grokPromptWithSharedContext("", "fix the test")).toBe("fix the test");
    expect(grokPromptWithSharedContext(undefined, "fix the test")).toBe("fix the test");
  });
});
