import { describe, expect, it } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  type ExternalHarnessId,
} from "@codexhost/protocol-core";
import { harnessIdSchema } from "@codexhost/shared-contracts";

import {
  createFixture,
  requestId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const SNAPSHOT = { usedPercent: 40, periodType: "five_hour" as const };

class QuotaAdapter extends FakeHarnessAdapter {
  snapshot: typeof SNAPSHOT | null = null;
  next: typeof SNAPSHOT | null = null;
  unavailable: "notSubscriber" | null = null;
  readonly calls: Array<boolean | undefined> = [];

  credits(): typeof SNAPSHOT | null {
    return this.snapshot;
  }

  async refreshCredits(options?: { explicit?: boolean }): Promise<typeof SNAPSHOT | null> {
    this.calls.push(options?.explicit);
    // Like Claude Code: only the explicit refresh reads; a passive call reads nothing.
    if (!options?.explicit) return null;
    if (this.next) this.snapshot = this.next;
    return this.next;
  }

  creditsUnavailableReason(): "notSubscriber" | null {
    return this.unavailable;
  }
}

async function inspect(
  fixture: ReturnType<typeof createFixture>,
  id: number,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  writeRequest(fixture.desktopInput, { id, method: "codexhost/thread/usage/inspect", params });
  return (await fixture.collector.waitFor((message) => requestId(message, id))) as Record<
    string,
    unknown
  >;
}

describe("AppServerHost explicit quota refresh", () => {
  it("awaits the Harness's request-free read and reports live, failed and unavailable", async () => {
    const claude = new QuotaAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["claude-code", claude]]),
    });
    const threadId = await startExternalThread(fixture, CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, 10);

    // A passive inspection never awaits nor reports a quota state before the first read.
    const passive = await inspect(fixture, 11, { threadId });
    expect(passive).toMatchObject({ result: { threadId } });
    expect((passive.result as Record<string, unknown>).quota).toBeUndefined();
    expect(claude.calls).toEqual([false]);

    claude.next = SNAPSHOT;
    const live = await inspect(fixture, 12, { threadId, refresh: "quota" });
    expect(live).toMatchObject({
      result: { accountCredits: SNAPSHOT, quota: { status: "live" } },
    });
    const observedAt = (live.result as { quota: { observedAt?: string } }).quota.observedAt;
    expect(observedAt && Number.isFinite(Date.parse(observedAt))).toBe(true);
    expect(claude.calls.at(-1)).toBe(true);
    expect(claude.sessions[0]?.usageRefreshes).toBe(1);

    // Later passive inspections carry the time of the last good read.
    await expect(inspect(fixture, 13, { threadId })).resolves.toMatchObject({
      result: { quota: { status: "cached", observedAt } },
    });

    // A failed read keeps the previous snapshot and its time.
    claude.next = null;
    await expect(inspect(fixture, 14, { threadId, refresh: "quota" })).resolves.toMatchObject({
      result: { accountCredits: SNAPSHOT, quota: { status: "failed", observedAt } },
    });

    claude.unavailable = "notSubscriber";
    await expect(inspect(fixture, 15, { threadId, refresh: "quota" })).resolves.toMatchObject({
      result: { quota: { status: "unavailable", reason: "notSubscriber" } },
    });
    await stopFixture(fixture);
  });

  it("says a Harness without a quota read cannot refresh, and accepts quota refresh on official Threads", async () => {
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["pi", pi]]),
      accountControl: {
        currentAccountId: () => null,
        snapshot: () => ({
          version: 2,
          currentAccountId: null,
          phase: "unavailable",
          revision: 0,
          accounts: [],
        }),
      },
    });
    const threadId = await startExternalThread(fixture, "codexhost/pi-native", 20);
    await expect(inspect(fixture, 21, { threadId, refresh: "quota" })).resolves.toMatchObject({
      result: { quota: { status: "unavailable", reason: "unsupported" } },
    });
    // Without a current Account there is nothing to read; the control stays usable.
    await expect(
      inspect(fixture, 22, { threadId: "official-thread", refresh: "quota" }),
    ).resolves.toEqual({
      id: 22,
      result: { threadId: "official-thread", usage: null, quota: { status: "unavailable" } },
    });
    await stopFixture(fixture);
  });
});
