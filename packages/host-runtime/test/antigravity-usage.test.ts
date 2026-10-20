import { describe, expect, it, vi } from "vitest";
import {
  AntigravityUsageReader,
  parseAntigravityUsage,
} from "../src/rly0-agents/antigravity-usage.js";

/** Shape captured from `agy --print=/usage --output-format stream-json` (CLI v1.1.22). */
const USAGE_LINE = JSON.stringify({
  event: "command_result",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              window: "weekly",
              remaining_fraction: 0.75,
              reset_time: "2026-09-01T03:17:57Z",
            },
            {
              id: "gemini-5h",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "2026-08-31T19:38:13Z",
            },
          ],
        },
        { name: "Claude and GPT models", buckets: [{ window: "weekly", remaining_fraction: 0.5 }] },
      ],
    },
  },
});

describe("Antigravity /usage", () => {
  it("reads every bucket as a consumed-side window", () => {
    const usage = parseAntigravityUsage(`noise\n${USAGE_LINE}\n`, 1_000_000);
    expect(usage?.fetchedAt).toBe(1000);
    expect(usage?.windows).toEqual([
      expect.objectContaining({
        kind: "secondary",
        label: "Gemini Models · 每周额度",
        usedPercent: 25,
      }),
      expect.objectContaining({
        kind: "primary",
        label: "Gemini Models · 5 小时额度",
        usedPercent: 0,
      }),
      {
        kind: "secondary",
        label: "Claude and GPT models · 每周额度",
        usedPercent: 50,
        windowSeconds: 604800,
      },
    ]);
    expect(usage?.windows[0]?.resetsAt).toBe(Math.floor(Date.parse("2026-09-01T03:17:57Z") / 1000));
    expect(parseAntigravityUsage('{"event":"result"}', 1)).toBeNull();
  });

  it("runs agy only on request, keeps the last numbers, and drops them when signed out", async () => {
    let output = { code: 0 as number | null, stdout: USAGE_LINE, stderr: "", timedOut: false };
    const run = vi.fn(async () => output);
    const reader = new AntigravityUsageReader({
      environment: async () => ({ PATH: "C:\\bin" }),
      platform: "win32",
      run,
      fileExists: () => true,
      now: () => 5_000_000,
    });
    expect(await reader.status()).toEqual({ installed: true });
    expect(run).not.toHaveBeenCalled();
    const ok = await reader.refresh();
    expect(ok.usage?.windows).toHaveLength(3);
    output = { code: null, stdout: "", stderr: "", timedOut: true };
    const timeout = await reader.refresh();
    expect(timeout).toMatchObject({ error: "TIMEOUT", usage: ok.usage });
    output = { code: 1, stdout: "", stderr: "Please sign in to continue", timedOut: false };
    const out = await reader.refresh();
    expect(out.error).toBe("ANTIGRAVITY_NOT_LOGGED_IN");
    expect(out.usage).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("says when agy is not installed, without running anything", async () => {
    const run = vi.fn();
    const reader = new AntigravityUsageReader({
      environment: async () => ({ PATH: "" }),
      platform: "win32",
      run,
      fileExists: () => false,
    });
    expect(await reader.refresh()).toEqual({ installed: false });
    expect(run).not.toHaveBeenCalled();
  });
});
