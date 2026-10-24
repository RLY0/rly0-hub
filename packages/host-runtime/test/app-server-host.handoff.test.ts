import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { ExternalHarnessId, JsonObject } from "@codexhost/protocol-core";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";

import {
  completePiTurn,
  createFixture,
  method,
  messageParams,
  requestId,
  startPiThread,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

type ExecuteSpy = { mock: { calls: unknown[][]; contexts: unknown[] } };

function turnTexts(spy: ExecuteSpy, session: FakeHarnessSession): string[] {
  return spy.mock.calls.flatMap((call: unknown[], index: number) => {
    if (spy.mock.contexts[index] !== session) return [];
    const command = call[0] as { type: string; input?: { type: string; text?: string }[] };
    return command.type === "turn.start" ? [command.input?.[0]?.text ?? ""] : [];
  });
}

describe("AppServerHost thread handoff", () => {
  it("continues an external conversation on another Agent and returns to the original", async () => {
    const execute = vi.spyOn(FakeHarnessSession.prototype, "execute");
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", pi],
        ["claude-code", claude],
      ]),
    });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    try {
      const sourceThreadId = await startPiThread(fixture);
      await completePiTurn(fixture, sourceThreadId, 2);

      writeRequest(fixture.desktopInput, {
        id: 20,
        method: "codexhost/thread/handoff",
        params: {
          threadId: sourceThreadId,
          targetHarnessId: "claude-code",
          requestId: "click-0001",
        },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 20));
      expect(response).toMatchObject({
        result: {
          mode: "created",
          title: expect.stringMatching(/^↪ .* · 接力 claude-code$/u),
          carried: { turns: 1, includedTurns: 1, omittedTurns: 0 },
        },
      });
      const childThreadId = (response.result as JsonObject).threadId as string;
      expect(childThreadId).not.toBe(sourceThreadId);
      await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/started") &&
          (messageParams(message).thread as JsonObject | undefined)?.id === childThreadId,
      );
      const childSession = claude.sessions[0];
      if (!childSession) throw new Error("Claude handoff Session was not opened");
      const [seed] = turnTexts(execute, childSession);
      expect(seed).toContain("[接力对话]");
      expect(seed).toContain("用户：synthetic");
      expect(seed).toContain("pi：answer 2");
      const delegation = await fixture.mappingStore.getDelegationByChild(
        hostThreadIdSchema.parse(childThreadId),
      );
      expect(delegation).toMatchObject({
        parentHostThreadId: sourceThreadId,
        requestId: "handoff:click-0001",
        sourceHarnessId: "pi",
        targetHarnessId: "claude-code",
      });

      // The child answers, then the person picks Pi again: the new turn goes back to the origin.
      childSession.appendText("got it");
      childSession.succeedTurn();
      await fixture.collector.waitFor(
        (message) =>
          method(message, "turn/completed") && messageParams(message).threadId === childThreadId,
      );
      writeRequest(fixture.desktopInput, {
        id: 22,
        method: "turn/start",
        params: { threadId: childThreadId, input: [{ type: "text", text: "add a unit test" }] },
      });
      const childTurn = await fixture.collector.waitFor((message) => requestId(message, 22));
      const childTurnId = ((childTurn.result as JsonObject).turn as JsonObject).id as string;
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", childTurnId));
      childSession.appendText("claude did more");
      childSession.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", childTurnId),
      );
      writeRequest(fixture.desktopInput, {
        id: 21,
        method: "codexhost/thread/handoff",
        params: { threadId: childThreadId, targetHarnessId: "pi", requestId: "click-0002" },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 21)),
      ).resolves.toMatchObject({ result: { threadId: sourceThreadId, mode: "returned" } });
      // Returning may reopen the origin's Native Session; read the turn from the live one.
      const sourceSession = pi.sessions.at(-1);
      if (!sourceSession) throw new Error("Pi Session was not opened");
      const returned = turnTexts(execute, sourceSession).at(-1) ?? "";
      expect(returned).toContain("[接力回来]");
      expect(returned).toContain("用户：add a unit test");
      expect(returned).toContain("claude-code：claude did more");
      expect(returned).toContain("claude-code：got it");
      expect(returned).not.toContain("[接力对话]");
      sourceSession.succeedTurn();
      await fixture.collector.waitFor(
        (message) =>
          method(message, "turn/completed") && messageParams(message).threadId === sourceThreadId,
      );
      expect(officialWrite).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
      await stopFixture(fixture);
    }
  });

  it("rejects an unknown Agent and the Agent the Thread already uses", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      await completePiTurn(fixture, threadId, 2);
      writeRequest(fixture.desktopInput, {
        id: 30,
        method: "codexhost/thread/handoff",
        params: { threadId, targetHarnessId: "missing-agent", requestId: "click-0003" },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 30)),
      ).resolves.toMatchObject({ error: { code: -32070 } });
      writeRequest(fixture.desktopInput, {
        id: 31,
        method: "codexhost/thread/handoff",
        params: { threadId, targetHarnessId: "pi", requestId: "click-0004" },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 31)),
      ).resolves.toMatchObject({ error: { code: -32602 } });
    } finally {
      await stopFixture(fixture);
    }
  });
});
