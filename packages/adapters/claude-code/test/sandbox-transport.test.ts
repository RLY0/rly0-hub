import type * as SandboxRuntime from "@codexhost/sandbox-runtime";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { harnessThinkingOptionIdSchema, type SandboxSettings } from "@codexhost/shared-contracts";

const state = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@codexhost/sandbox-runtime", async (original) => ({
  ...(await original<typeof SandboxRuntime>()),
  resolveSandboxBinding: (_env: unknown, _cwd: unknown, settings: SandboxSettings) => ({
    command: "sbx.exe",
    project: settings.projects[0],
    settings,
  }),
  verifySandboxBinding: (...args: unknown[]) => state.verify(...args),
}));
import { ClaudeSdkTransport, type ClaudeSdkTransportOptions } from "../src/sdk-transport.js";
import { sandboxFilePath } from "../src/sandbox.js";

beforeEach(() => {
  state.verify.mockReset().mockResolvedValue(undefined);
});
function fixture(
  openMode: "create" | "resume",
  sharedResources?: ClaudeSdkTransportOptions["sharedResources"],
) {
  let waiter: ((message: IteratorResult<unknown>) => void) | undefined;
  const queue: unknown[] = [];
  let closed = false;
  const push = (message: unknown) => {
    if (waiter) {
      const receive = waiter;
      waiter = undefined;
      receive({ value: message, done: false });
    } else queue.push(message);
  };
  const fake = {
    initializationResult: async () => ({ commands: [] }),
    accountInfo: async () => ({ apiProvider: "firstParty" }),
    interrupt: vi.fn(async () => {
      push({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
      });
    }),
    close: () => {
      closed = true;
      waiter?.({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        if (queue.length) return { value: queue.shift(), done: false };
        if (closed) return { done: true, value: undefined };
        return new Promise((resolve) => {
          waiter = resolve;
        });
      },
    }),
  };
  let captured: Parameters<NonNullable<ClaudeSdkTransportOptions["queryFactory"]>>[0] | undefined;
  const factory = vi.fn((input) => {
    captured = input;
    return fake as unknown as Query;
  });
  const settings: SandboxSettings = {
    version: 1,
    enabled: true,
    runtimeRoot: "D:\\sandbox-data",
    proxy: "http://127.0.0.1:12345",
    projects: [{ name: "sdk-test", id: "test-id", project: "D:\\project" }],
  };
  const transport = new ClaudeSdkTransport({
    command: "host-Claude-must-not-run.exe",
    environment: {},
    cwd: "D:\\project",
    sandboxSettings: settings,
    sessionId: "00000000-0000-4000-8000-000000000001",
    openMode,
    permissionMode: "default",
    thinkingOptionId: harnessThinkingOptionIdSchema.parse("off"),
    closeTimeoutMs: 20,
    onPermissionModeChanged: vi.fn(),
    onFault: vi.fn(),
    onPlanLimit: vi.fn(),
    queryFactory: factory,
    ...(sharedResources ? { sharedResources } : {}),
  });
  return { transport, factory, fake, push, options: () => captured?.options };
}

describe("Claude SDK inside a selected sandbox", () => {
  it("maps file-change links back to the shared Windows project only", () => {
    expect(sandboxFilePath("/d/project/src/a.ts", "D:\\project")).toBe("D:\\project\\src\\a.ts");
    expect(sandboxFilePath("/d/project/../private/a.ts", "D:\\project")).toBe(
      "/d/project/../private/a.ts",
    );
    expect(sandboxFilePath("/tmp/a.ts", "D:\\project")).toBe("/tmp/a.ts");
  });
  it("keeps the native resume identity and SDK streaming/interrupt protocol", async () => {
    for (const mode of ["create", "resume"] as const) {
      const f = fixture(mode);
      await f.transport.start();
      expect(f.options()).toMatchObject({
        pathToClaudeCodeExecutable: "sbx.exe",
        persistSession: true,
        includePartialMessages: true,
        [mode === "create" ? "sessionId" : "resume"]: "00000000-0000-4000-8000-000000000001",
      });
      const events: unknown[] = [];
      const turn = f.transport.runTurn("hello", "00000000-0000-4000-8000-000000000002", (event) =>
        events.push(event),
      );
      f.push({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "sandbox response" },
        },
        parent_tool_use_id: null,
        uuid: "partial-1",
        session_id: f.transport.sessionId,
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({ type: "text.delta", delta: "sandbox response" }),
        ),
      );
      await f.transport.abort();
      await expect(turn).resolves.toEqual({ status: "cancelled", reason: "aborted_streaming" });
      expect(f.fake.interrupt).toHaveBeenCalledOnce();
      await f.transport.close();
    }
  });
  it("never hands Codex MCP, skills or memory to an isolated Claude", async () => {
    const provider = vi.fn(async () => ({
      mcpServers: { codex_docs: { type: "http" as const, url: "https://x.invalid", headers: {} } },
      context: "shared",
    }));
    const f = fixture("create", provider);
    await f.transport.start();
    expect(provider).not.toHaveBeenCalled();
    expect(f.options()).not.toHaveProperty("mcpServers");
    expect(f.options()).not.toHaveProperty("systemPrompt");
    await f.transport.close();
  });
  it("stops before creating an SDK query when the sandbox/proxy check fails", async () => {
    state.verify.mockRejectedValue(new Error("ISOLATION_PROXY_UNAVAILABLE"));
    const f = fixture("create");
    await expect(f.transport.start()).rejects.toThrow("ISOLATION_PROXY_UNAVAILABLE");
    expect(f.factory).not.toHaveBeenCalled();
    await f.transport.close();
  });
});
