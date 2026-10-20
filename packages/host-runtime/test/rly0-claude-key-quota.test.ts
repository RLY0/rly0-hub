import { describe, expect, it } from "vitest";

import {
  CLAUDE_KEY_QUOTA_AUTO_INTERVAL_MS,
  ClaudeOfficialKeyQuota,
  projectClaudeKeyUsage,
  withClaudeKeyPlanUsage,
} from "../src/rly0-relay/claude-key-quota.js";

const FETCHED = 1_792_000_000;
const SETUP_TOKEN_INFO = {
  kind: "subscription",
  last4: "abcd",
  valid: true,
  profileHidden: true,
  usageVia: "headers",
  usage: {
    fetchedAt: FETCHED,
    source: "live",
    status: "allowed",
    windows: [
      { kind: "primary", usedPercent: 39, resetsAt: FETCHED + 3600, windowSeconds: 18_000 },
      { kind: "secondary", usedPercent: 18, resetsAt: FETCHED + 86_400, windowSeconds: 604_800 },
    ],
  },
};
const KEY = { relayId: "0123456789abcdef", keyMask: "sk-ant-oat01-…abcd" };

function harness(answers: unknown[]) {
  let now = 1_000_000;
  const reads: string[] = [];
  let updates = 0;
  const pending: Array<() => void> = [];
  const quota = new ClaudeOfficialKeyQuota(
    async (relayId) => {
      reads.push(relayId);
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    { now: () => now, onUpdate: () => ((updates += 1), pending.splice(0).forEach((f) => f())) },
  );
  const updated = () => new Promise<void>((resolve) => pending.push(resolve));
  return {
    quota,
    reads,
    updated,
    get updates() {
      return updates;
    },
    advance: (ms: number) => (now += ms),
  };
}

describe("Claude official key quota", () => {
  it("projects rly0-core windows onto the credits capsule and the Popover's plan rows", () => {
    const snapshot = projectClaudeKeyUsage(SETUP_TOKEN_INFO.usage as never);
    expect(snapshot).toEqual({
      credits: {
        usedPercent: 39,
        periodType: "five_hour",
        resetsAt: new Date((FETCHED + 3600) * 1000).toISOString(),
        productUsage: [
          {
            product: "7-day window",
            usagePercent: 18,
            resetsAt: new Date((FETCHED + 86_400) * 1000).toISOString(),
          },
        ],
      },
      plan: {
        planFiveHourUsedPercent: 39,
        planFiveHourResetsAtUnix: FETCHED + 3600,
        planSevenDayUsedPercent: 18,
        planSevenDayResetsAtUnix: FETCHED + 86_400,
      },
      observedAt: new Date(FETCHED * 1000).toISOString(),
    });
    expect(projectClaudeKeyUsage({ windows: [], source: "live" })).toBeNull();
    expect(withClaudeKeyPlanUsage({ totalTokens: 5 }, snapshot?.plan)).toMatchObject({
      totalTokens: 5,
      planSevenDayUsedPercent: 18,
    });
    expect(withClaudeKeyPlanUsage(null, {})).toBeNull();
  });

  it("reads on its own at most once per 5 minutes, without making the inspection wait", async () => {
    const h = harness([SETUP_TOKEN_INFO]);
    const landed = h.updated();
    // First passive inspection: nothing known yet, a read starts in the background.
    await expect(h.quota.inspect(KEY, false)).resolves.toEqual({ snapshot: null });
    await landed;
    expect(h.reads).toEqual([KEY.relayId]);
    const cached = await h.quota.inspect(KEY, false);
    expect(cached.quota).toEqual({
      status: "cached",
      observedAt: new Date(FETCHED * 1000).toISOString(),
    });
    expect(cached.snapshot?.credits.usedPercent).toBe(39);

    h.advance(CLAUDE_KEY_QUOTA_AUTO_INTERVAL_MS - 1);
    await h.quota.inspect(KEY, false);
    expect(h.reads).toHaveLength(1);

    h.advance(1);
    const again = h.updated();
    await h.quota.inspect(KEY, false);
    await again;
    expect(h.reads).toHaveLength(2);
  });

  it("an explicit refresh reads now, at most every 10 seconds, and joins a read in flight", async () => {
    const h = harness([SETUP_TOKEN_INFO]);
    const passive = h.quota.inspect(KEY, false);
    const explicit = await h.quota.inspect(KEY, true);
    await passive;
    // The passive call had already started a read; the refresh waited for it.
    expect(h.reads).toHaveLength(1);
    expect(explicit.quota?.status).toBe("live");

    h.advance(5_000);
    await expect(h.quota.inspect(KEY, true)).resolves.toMatchObject({
      quota: { status: "cached" },
    });
    expect(h.reads).toHaveLength(1);

    h.advance(5_000);
    await expect(h.quota.inspect(KEY, true)).resolves.toMatchObject({
      quota: { status: "live" },
    });
    expect(h.reads).toHaveLength(2);
  });

  it("keeps the last numbers when a read fails and treats a plain API key as not a plan", async () => {
    const network = { ...SETUP_TOKEN_INFO, usage: undefined, usageError: "USAGE_NETWORK" };
    const h = harness([SETUP_TOKEN_INFO, network, new Error("core gone")]);
    await h.quota.inspect(KEY, true);
    h.advance(10_000);
    const failed = await h.quota.inspect(KEY, true);
    expect(failed.quota).toEqual({
      status: "failed",
      observedAt: new Date(FETCHED * 1000).toISOString(),
    });
    expect(failed.snapshot?.credits.usedPercent).toBe(39);
    h.advance(10_000);
    await expect(h.quota.inspect(KEY, true)).resolves.toMatchObject({
      quota: { status: "failed" },
    });

    const apiKey = harness([{ kind: "apiKey", last4: "wxyz", valid: true }]);
    await expect(apiKey.quota.inspect(KEY, true)).resolves.toEqual({
      quota: { status: "unavailable", reason: "notSubscriber" },
      snapshot: null,
    });
  });

  it("a failed first read is reported, and a replaced token reads afresh", async () => {
    const h = harness([{ kind: "subscription", valid: true, usageError: "USAGE_NETWORK" }]);
    const landed = h.updated();
    await h.quota.inspect(KEY, false);
    await landed;
    await expect(h.quota.inspect(KEY, false)).resolves.toEqual({
      quota: { status: "failed" },
      snapshot: null,
    });
    expect(h.reads).toHaveLength(1);
    const replaced = h.updated();
    await h.quota.inspect({ ...KEY, keyMask: "sk-ant-oat01-…efgh" }, false);
    await replaced;
    expect(h.reads).toHaveLength(2);
  });
});
