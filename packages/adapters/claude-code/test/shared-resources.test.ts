import { describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SharedHarnessResources,
  SharedResourcesProvider,
} from "@codexhost/harness-adapter/plugin";
import { harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

import {
  CLAUDE_SHARED_RESOURCE_REQUEST,
  ClaudeSdkTransport,
  type ClaudeSdkTransportOptions,
} from "../src/sdk-transport.js";
import { FakeQuery } from "./fake-sdk-query.js";

type QueryInput = Parameters<NonNullable<ClaudeSdkTransportOptions["queryFactory"]>>[0];

async function start(shared: SharedHarnessResources) {
  let input: QueryInput | undefined;
  const provider = vi.fn<SharedResourcesProvider>(async () => shared);
  const transport = new ClaudeSdkTransport({
    command: process.execPath,
    cwd: process.cwd(),
    sessionId: "00000000-0000-4000-8000-000000000031",
    openMode: "create",
    permissionMode: "default",
    thinkingOptionId: harnessThinkingOptionIdSchema.parse("auto"),
    closeTimeoutMs: 100,
    onPermissionModeChanged: vi.fn(),
    onFault: vi.fn(),
    onPlanLimit: vi.fn(),
    sharedResources: provider,
    queryFactory: vi.fn((value) => {
      input = value;
      return new FakeQuery() as unknown as Query;
    }),
  });
  await transport.start();
  await transport.close();
  return { provider, options: input?.options };
}

describe("Claude Code shared Codex resources", () => {
  it("asks for every kind and attaches MCP natively, context only to the system prompt", async () => {
    const { provider, options } = await start({
      mcpServers: {
        codex_docs: {
          type: "http",
          url: "https://docs.invalid/mcp",
          headers: { Authorization: "Bearer synthetic-token" },
        },
      },
      context: "[RLY/0 shared resources] skills and memory",
    });
    expect(provider).toHaveBeenCalledWith(process.cwd(), CLAUDE_SHARED_RESOURCE_REQUEST);
    expect(CLAUDE_SHARED_RESOURCE_REQUEST).toEqual({
      harnessId: "claude-code",
      mcp: true,
      skills: true,
      memory: true,
      memoryMcp: true,
    });
    expect(options?.mcpServers).toEqual({
      codex_docs: {
        type: "http",
        url: "https://docs.invalid/mcp",
        headers: { Authorization: "Bearer synthetic-token" },
      },
    });
    expect(options?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "[RLY/0 shared resources] skills and memory",
    });
    expect(JSON.stringify(options?.systemPrompt)).not.toContain("synthetic-token");
  });

  it("attaches MCP even when skills and memory are not shared", async () => {
    const { options } = await start({
      mcpServers: { codex_local: { type: "stdio", command: "node", args: ["s.js"], env: {} } },
      context: "",
    });
    expect(options?.mcpServers).toHaveProperty("codex_local");
    expect(options).not.toHaveProperty("systemPrompt");
  });

  it("leaves the SDK options untouched when nothing is shared", async () => {
    const { options } = await start({ mcpServers: {}, context: "" });
    expect(options).not.toHaveProperty("mcpServers");
    expect(options).not.toHaveProperty("systemPrompt");
  });
});
