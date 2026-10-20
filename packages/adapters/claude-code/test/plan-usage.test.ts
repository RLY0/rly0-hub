import { describe, expect, it } from "vitest";

import {
  CLAUDE_PLAN_USAGE_COOLDOWN_MS,
  ClaudePlanUsageRefresher,
  parseClaudePlanUsage,
  type ClaudePlanUsageRead,
} from "../src/plan-usage.js";
import type { ClaudePlanLimitEvent } from "../src/transport.js";

describe("Claude /usage plan windows", () => {
  it("reads the five-hour and seven-day windows in percent with ISO reset times", () => {
    expect(
      parseClaudePlanUsage({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42.5, resets_at: "2026-10-20T05:00:00.000Z" },
          seven_day: { utilization: 7, resets_at: null },
          seven_day_opus: { utilization: 99, resets_at: null },
        },
      }),
    ).toEqual({
      available: true,
      planLimit: {
        fiveHour: { utilizationPercent: 42.5, resetsAtUnix: 1_792_472_400 },
        sevenDay: { utilizationPercent: 7 },
      },
    });
  });

  it("separates a login without plan limits from a malformed answer", () => {
    expect(parseClaudePlanUsage({ rate_limits_available: false, rate_limits: null })).toEqual({
      available: false,
    });
    expect(parseClaudePlanUsage({ rate_limits_available: true, rate_limits: null })).toEqual({
      available: true,
      planLimit: null,
    });
    expect(parseClaudePlanUsage({ rate_limits: {} })).toBeNull();
    expect(parseClaudePlanUsage(null)).toBeNull();
    expect(
      parseClaudePlanUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: -1 }, seven_day: { utilization: 250 } },
      }),
    ).toEqual({ available: true, planLimit: { sevenDay: { utilizationPercent: 100 } } });
  });
});

describe("ClaudePlanUsageRefresher", () => {
  const WINDOW: ClaudePlanLimitEvent = { fiveHour: { utilizationPercent: 30 } };

  function setup(reads: Array<ClaudePlanUsageRead | null | Error>) {
    let now = 1_000_000;
    let calls = 0;
    const recorded: ClaudePlanLimitEvent[] = [];
    const source = {
      readPlanUsage: async () => {
        const next = reads[Math.min(calls, reads.length - 1)];
        calls += 1;
        if (next instanceof Error) throw next;
        return next ?? null;
      },
    };
    const refresher = new ClaudePlanUsageRefresher({
      sources: () => [source],
      record: (planLimit) => recorded.push(planLimit),
      now: () => now,
    });
    return {
      refresher,
      recorded,
      calls: () => calls,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("reads only on an explicit refresh, once in flight, then waits out the cooldown", async () => {
    const test = setup([{ available: true, planLimit: WINDOW }]);
    await expect(test.refresher.refresh(false)).resolves.toBe(false);
    expect(test.calls()).toBe(0);

    const first = test.refresher.refresh(true);
    const joined = test.refresher.refresh(true);
    await expect(first).resolves.toBe(true);
    await expect(joined).resolves.toBe(true);
    expect(test.calls()).toBe(1);
    expect(test.recorded).toEqual([WINDOW]);

    await expect(test.refresher.refresh(true)).resolves.toBe(true);
    expect(test.calls()).toBe(1);
    test.advance(CLAUDE_PLAN_USAGE_COOLDOWN_MS);
    await expect(test.refresher.refresh(true)).resolves.toBe(true);
    expect(test.calls()).toBe(2);
  });

  it("remembers a login without plan limits until a native push proves otherwise", async () => {
    const test = setup([{ available: false }]);
    await expect(test.refresher.refresh(true)).resolves.toBe(false);
    expect(test.refresher.unavailable).toBe(true);
    test.refresher.observePush();
    expect(test.refresher.unavailable).toBe(false);
  });

  it("treats a failing or closed Session as a failed read", async () => {
    const test = setup([new Error("closed"), null]);
    await expect(test.refresher.refresh(true)).resolves.toBe(false);
    expect(test.refresher.unavailable).toBe(false);
    expect(test.recorded).toEqual([]);
  });
});
