import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  type ExternalHarnessId,
} from "@codexhost/protocol-core";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { requestClaudeSessionsRefresh } from "../src/rly0-maintenance/backend-reload-channel.js";
import {
  createFixture,
  startExternalThread,
  startPiTurn,
  stopFixture,
  turnEvent,
} from "./app-server-host-fixture.js";

describe("AppServerHost after the Hub switches Claude Code's credential", () => {
  it("replaces idle Claude Code sessions at once and busy ones after their turn", async () => {
    const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["claude-code", claude]]),
    });
    try {
      const idleId = await startExternalThread(fixture, CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, 10);
      const idleTurn = await startPiTurn(fixture, idleId, 11);
      const idle = claude.sessions[0];
      if (!idle) throw new Error("Synthetic Claude session missing");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", idleTurn));
      idle.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", idleTurn));

      const busyId = await startExternalThread(fixture, CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, 20);
      const busyTurn = await startPiTurn(fixture, busyId, 21);
      const busy = claude.sessions[1];
      if (!busy) throw new Error("Synthetic Claude session missing");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", busyTurn));
      const idleClose = vi.spyOn(idle, "close");
      const busyClose = vi.spyOn(busy, "close");

      // The Host skips a request left from before it started; let it see the empty state first.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await requestClaudeSessionsRefresh(fixture.mappingStoreDirectory);

      await vi.waitFor(() => expect(idleClose).toHaveBeenCalledTimes(1), { timeout: 8_000 });
      expect(busyClose).not.toHaveBeenCalled();

      busy.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", busyTurn));
      await vi.waitFor(() => expect(busyClose).toHaveBeenCalledTimes(1), { timeout: 8_000 });

      // The next turn in the same conversation runs on a newly opened session. (The shared Fake
      // Adapter cannot resume a closed session; a native one resumes from its persisted history.)
      const resumed: FakeHarnessSession[] = [];
      const nativeOpen = claude.open.bind(claude);
      vi.spyOn(claude, "open").mockImplementation(async (input) => {
        if (input.kind !== "resume") return nativeOpen(input);
        const session = new FakeHarnessSession(
          claude.harnessId,
          claude.catalog,
          undefined,
          input.nativeRef,
        );
        resumed.push(session);
        return { ok: true, value: session };
      });
      const nextTurn = await startPiTurn(fixture, idleId, 12);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", nextTurn));
      expect(resumed).toHaveLength(1);
      resumed[0]?.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", nextTurn));
    } finally {
      await stopFixture(fixture);
    }
  }, 30_000);
});
