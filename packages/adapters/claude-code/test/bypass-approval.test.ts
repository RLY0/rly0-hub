import { describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

import {
  approvedInBypassMode,
  ClaudeSdkTransport,
  type ClaudeSdkTransportOptions,
} from "../src/sdk-transport.js";
import { FakeQuery } from "./fake-sdk-query.js";

describe("绕过权限: asks Claude Code still sends", () => {
  it("approves ordinary asks, keeps questions, MCP tools and dangerous deletes for the person", () => {
    expect(approvedInBypassMode("Bash", {})).toBe(true);
    expect(approvedInBypassMode("Edit", { decisionReason: "Path is outside the project" })).toBe(
      true,
    );
    expect(approvedInBypassMode("Bash", { defaultToNo: true })).toBe(false);
    expect(
      approvedInBypassMode("Bash", { decisionReason: "Dangerous rm operation not ruled out" }),
    ).toBe(false);
    expect(
      approvedInBypassMode("Bash", { decisionReason: "Deletes files in the home folder" }),
    ).toBe(false);
    expect(approvedInBypassMode("AskUserQuestion", {})).toBe(false);
    expect(approvedInBypassMode("ExitPlanMode", {})).toBe(false);
    expect(approvedInBypassMode("mcp__drive__upload", {})).toBe(false);
  });

  function session(permissionMode: ClaudeSdkTransportOptions["permissionMode"]) {
    const fakeQuery = new FakeQuery();
    let input: Parameters<NonNullable<ClaudeSdkTransportOptions["queryFactory"]>>[0] | undefined;
    const transport = new ClaudeSdkTransport({
      command: process.execPath,
      cwd: process.cwd(),
      sessionId: "00000000-0000-4000-8000-000000000001",
      openMode: "create",
      permissionMode,
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("auto"),
      allowDangerouslySkipPermissions: true,
      closeTimeoutMs: 100,
      queryFactory: vi.fn((value) => {
        input = value;
        return fakeQuery as unknown as Query;
      }),
      onFault: vi.fn(),
      onPermissionModeChanged: vi.fn(),
      onPlanLimit: vi.fn(),
    } as unknown as ClaudeSdkTransportOptions);
    return { transport, canUseTool: () => input?.options?.canUseTool };
  }

  it("answers a Bash ask itself in 绕过权限 and still shows it in 默认", async () => {
    const bypass = session("bypassPermissions");
    await bypass.transport.start();
    const allow = bypass.canUseTool();
    if (!allow) throw new Error("canUseTool was not configured");
    await expect(
      allow(
        "Bash",
        { command: "python3 -I - <<'EOF'\nprint(1)\nEOF" },
        { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
      ),
    ).resolves.toMatchObject({ behavior: "allow", toolUseID: "t1" });
    await bypass.transport.close();

    const ask = session("default");
    await ask.transport.start();
    const asked = ask.canUseTool();
    if (!asked) throw new Error("canUseTool was not configured");
    // No turn is running here, so the ask cannot reach the person: it is refused, not approved.
    await expect(
      asked(
        "Bash",
        { command: "ls" },
        {
          signal: new AbortController().signal,
          toolUseID: "t2",
          requestId: "r2",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny" });
    await ask.transport.close();
  });
});
