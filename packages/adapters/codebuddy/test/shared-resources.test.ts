import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SharedResourcesProvider } from "@codexhost/harness-adapter/plugin";

import { CodeBuddyAcpClient } from "../src/acp-client.js";

vi.mock("../src/command.js", () => ({
  codeBuddyInvocation: () => ({
    command: process.execPath,
    arguments: [path.resolve("packages/adapters/codebuddy/test/fixtures/acp.mjs"), "echo"],
    environment: process.env,
    windowsVerbatimArguments: false,
  }),
}));

describe("CodeBuddy / WorkBuddy shared resources", () => {
  it("opens with Codex MCP and rly0-memory and prefixes prompts with context", async () => {
    const provider = vi.fn<SharedResourcesProvider>(async (_cwd, request) =>
      request?.mcp
        ? {
            mcpServers: {
              rly0_memory: { type: "stdio", command: "node", args: ["m.js"], env: { RLY0_MEMORY_AGENT: "workbuddy" } },
            },
            context: "",
          }
        : { mcpServers: {}, context: "[RLY/0 shared resources] index" },
    );
    const client = new CodeBuddyAcpClient({
      cwd: process.cwd(),
      environment: process.env,
      ephemeral: false,
      sharedResources: provider,
      harnessId: "workbuddy",
      handlers: { update: vi.fn(), permission: vi.fn(), question: vi.fn(), fault: vi.fn() },
    });
    try {
      await client.initialize();
      const opened = await client.open(process.cwd());
      expect((opened._meta as { mcpServers: unknown }).mcpServers).toEqual([
        { name: "rly0_memory", command: "node", args: ["m.js"], env: [{ name: "RLY0_MEMORY_AGENT", value: "workbuddy" }] },
      ]);
      const answered = await client.prompt("native", "hi");
      expect((answered._meta as { prompt: { text: string }[] }).prompt[0]?.text).toBe("[RLY/0 shared resources] index\n\n[Current user request]\nhi");
      expect(provider).toHaveBeenCalledWith(process.cwd(), { harnessId: "workbuddy", mcp: true, memoryMcp: true });
    } finally {
      await client.close();
    }
  });
});
