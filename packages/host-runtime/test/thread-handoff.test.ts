import type { StoredDelegationRecordV1 } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";

import { buildHandoffSeed, handoffTitle, sourceThreadTitle } from "../src/thread-handoff.js";
import { runThreadHandoff, type ThreadHandoffDeps } from "../src/thread-handoff-service.js";

function turn(id: string, items: JsonObject[], status = "completed"): JsonObject {
  return { id, status, items };
}
const user = (id: string, text: string): JsonObject => ({
  id,
  type: "userMessage",
  content: [{ type: "text", text }],
});
const agent = (id: string, text: string): JsonObject => ({ id, type: "agentMessage", text });

const conversation: JsonObject[] = [
  turn("t1", [user("u1", "修复登录页的报错"), agent("a1", "我先看一下 src/login.ts。")]),
  turn("t2", [
    { id: "r1", type: "reasoning", summary: ["hidden reasoning must not travel"] },
    {
      id: "c1",
      type: "commandExecution",
      command: "npm test -- login",
      exitCode: 1,
      aggregatedOutput: `${"x".repeat(2_000)}\nFAIL login.test.ts`,
    },
    {
      id: "f1",
      type: "fileChange",
      changes: [
        { path: "src/login.ts", kind: { type: "update" } },
        { path: "src/new.ts", kind: { type: "add" } },
      ],
    },
    { id: "m1", type: "mcpToolCall", server: "github", tool: "search", status: "completed" },
    agent("a2", "测试还有一处失败，key 是 sk-abcdefghijklmnopqrstuv。"),
  ]),
];

describe("handoff transcript", () => {
  it("carries messages, command results and changed files, never reasoning or raw secrets", () => {
    const seed = buildHandoffSeed({
      turns: conversation,
      sourceLabel: "Codex",
      targetLabel: "Claude Code",
      sourceTitle: "修复登录",
      cwd: "/work/app",
    });
    expect(seed.text).toContain("从 Codex 的对话「修复登录」接过来的，现在由 Claude Code 继续");
    expect(seed.text).toContain("工作目录：/work/app");
    expect(seed.text).toContain("用户：修复登录页的报错");
    expect(seed.text).toContain("Codex：我先看一下 src/login.ts。");
    expect(seed.text).toContain("（运行命令）npm test -- login → 退出码 1");
    expect(seed.text).toContain("FAIL login.test.ts");
    expect(seed.text).toContain("（改动文件）修改 src/login.ts；新增 src/new.ts");
    expect(seed.text).toContain("（调用工具）github/search：completed");
    expect(seed.text).not.toContain("hidden reasoning");
    expect(seed.text).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(seed.text).toContain("[credential removed]");
    expect(seed.text).toContain("等待用户的指示");
    expect(seed.carried).toEqual({
      turns: 2,
      includedTurns: 2,
      omittedTurns: 0,
      commands: 1,
      files: 2,
      truncated: true,
    });
  });

  it("keeps the first turn and the newest turns within the budget", () => {
    const turns = Array.from({ length: 30 }, (_, index) =>
      turn(`t${index}`, [user(`u${index}`, `问题 ${index} ${"y".repeat(900)}`)]),
    );
    const seed = buildHandoffSeed({
      turns,
      sourceLabel: "Claude Code",
      targetLabel: "Codex",
      budgetChars: 6_000,
    });
    expect(seed.text).toContain("问题 0 ");
    expect(seed.text).toContain("问题 29 ");
    expect(seed.text).not.toContain("问题 10 ");
    expect(seed.text).toMatch(/这里省略了 \d+ 轮较早的内容/u);
    expect(seed.carried.omittedTurns).toBeGreaterThan(0);
    expect(seed.carried.includedTurns + seed.carried.omittedTurns).toBe(30);
    expect(seed.text.length).toBeLessThan(9_000);
  });

  it("uses the draft as the new request when one is given", () => {
    const seed = buildHandoffSeed({
      turns: conversation,
      sourceLabel: "Codex",
      targetLabel: "Grok",
      followUp: "接着把测试修好",
    });
    expect(seed.text.endsWith("[用户的新请求]\n接着把测试修好")).toBe(true);
  });

  it("titles the new Thread after the original without stacking handoff markers", () => {
    expect(handoffTitle("修复登录", "Claude Code")).toBe("↪ 修复登录 · 接力 Claude Code");
    expect(handoffTitle("↪ 修复登录 · 接力 Claude Code", "Grok")).toBe("↪ 修复登录 · 接力 Grok");
    expect(handoffTitle(null, "Pi")).toBe("↪ 对话 · 接力 Pi");
    expect(handoffTitle("长".repeat(300), "Codex").length).toBeLessThanOrEqual(120);
    expect(sourceThreadTitle({ name: null, preview: "first line\nsecond" })).toBe("first line");
  });
});

function deps(overrides: Partial<ThreadHandoffDeps> = {}): ThreadHandoffDeps {
  return {
    source: vi.fn(async () => ({
      harnessId: "codex" as const,
      thread: { id: "source", name: "修复登录" },
      turns: conversation,
      cwd: "/work/app",
    })),
    start: vi.fn(async () => ({
      delegationId: "d1",
      threadId: "created-thread",
      turnId: "turn",
      harnessId: "claude-code",
      deepLink: "codex://threads/created-thread",
      status: "running" as const,
      next: { read: "", wait: "" },
    })),
    send: vi.fn(async () => ({
      threadId: "origin",
      turnId: "turn",
      harnessId: "codex",
      status: "running" as const,
      next: { read: "", wait: "" },
    })),
    delegationByChild: vi.fn(async () => null),
    label: (id) => ({ codex: "Codex", "claude-code": "Claude Code" })[id] ?? id,
    ...overrides,
  };
}

describe("runThreadHandoff", () => {
  it("creates a linked Thread on the chosen Agent with the person's configuration", async () => {
    const fake = deps();
    const result = await runThreadHandoff(fake, {
      threadId: "source" as never,
      targetHarnessId: "claude-code" as never,
      requestId: "click-0001",
      model: { id: "claude-sonnet" } as never,
      permissionModeId: "acceptEdits" as never,
    });
    expect(result).toMatchObject({
      threadId: "created-thread",
      mode: "created",
      title: "↪ 修复登录 · 接力 Claude Code",
      carried: { turns: 2, commands: 1, files: 2 },
    });
    expect(fake.start).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessId: "claude-code",
        parentThreadId: "source",
        cwd: "/work/app",
        requestId: "handoff:click-0001",
        model: { id: "claude-sonnet" },
        handoff: { title: "↪ 修复登录 · 接力 Claude Code", permissionModeId: "acceptEdits" },
        task: expect.stringContaining("用户：修复登录页的报错"),
      }),
    );
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("brings only the new turns back when returning to the Agent a handoff came from", async () => {
    const link: StoredDelegationRecordV1 = {
      delegationId: "d1",
      parentHostThreadId: "origin",
      childHostThreadId: "child",
      sourceHarnessId: "codex",
      targetHarnessId: "claude-code",
      status: "completed",
      requestId: "handoff:click-0001",
      taskDigest: "digest",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as never;
    const fake = deps({
      source: vi.fn(async () => ({
        harnessId: "claude-code" as const,
        thread: { id: "child", name: "↪ 修复登录 · 接力 Claude Code" },
        turns: [
          turn("seed", [user("s", "[接力对话] 旧的整段记录")]),
          turn("n1", [user("u", "再加一个单测"), agent("a", "已添加 login.spec.ts")]),
        ],
        cwd: "/work/app",
      })),
      delegationByChild: vi.fn(async () => link),
    });
    const result = await runThreadHandoff(fake, {
      threadId: "child" as never,
      targetHarnessId: "codex" as never,
      requestId: "click-0002",
    });
    expect(result).toMatchObject({ threadId: "origin", mode: "returned", title: null });
    expect(fake.start).not.toHaveBeenCalled();
    const message = vi.mocked(fake.send).mock.calls[0]?.[0].message ?? "";
    expect(message).toContain("[接力回来]");
    expect(message).toContain("Claude Code：已添加 login.spec.ts");
    expect(message).not.toContain("旧的整段记录");
  });

  it("does not hand a conversation to the Agent it already uses", async () => {
    await expect(
      runThreadHandoff(deps(), {
        threadId: "source" as never,
        targetHarnessId: "codex" as never,
        requestId: "click-0003",
      }),
    ).rejects.toThrow("already uses the selected Agent");
  });

  it("treats an agent-initiated delegation as a normal source, not a return", async () => {
    const fake = deps({
      source: vi.fn(async () => ({
        harnessId: "claude-code" as const,
        thread: { id: "child" },
        turns: conversation,
      })),
      delegationByChild: vi.fn(
        async () =>
          ({
            parentHostThreadId: "origin",
            sourceHarnessId: "codex",
            requestId: "cli-request",
          }) as never,
      ),
    });
    const result = await runThreadHandoff(fake, {
      threadId: "child" as never,
      targetHarnessId: "codex" as never,
      requestId: "click-0004",
    });
    expect(result.mode).toBe("created");
    expect(fake.send).not.toHaveBeenCalled();
  });
});
