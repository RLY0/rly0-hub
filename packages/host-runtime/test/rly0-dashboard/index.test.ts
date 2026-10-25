import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RLY0_DASHBOARD_ACTIVITY_DAYS,
  RLY0_DASHBOARD_HISTORY_DAYS,
  rly0DashboardHealthParamsSchema,
  rly0DashboardHealthResultSchema,
  rly0DashboardThreadStatsParamsSchema,
  rly0DashboardThreadStatsResultSchema,
} from "@codexhost/shared-contracts";

import { Rly0DashboardManager, rly0DashboardRpcError } from "../../src/rly0-dashboard/index.js";

describe("Rly0DashboardManager", () => {
  let codexHome: string;
  let manager: Rly0DashboardManager;

  beforeEach(async () => {
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-dashboard-home-"));
    manager = new Rly0DashboardManager({
      environment: { CODEX_HOME: codexHome, HOME: codexHome },
      now: () => new Date(2026, 8, 30, 12),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("uses strict param contracts", () => {
    expect(rly0DashboardHealthParamsSchema.safeParse({}).success).toBe(true);
    expect(rly0DashboardHealthParamsSchema.safeParse({ path: "/" }).success).toBe(false);
    expect(rly0DashboardThreadStatsParamsSchema.safeParse({ x: 1 }).success).toBe(false);
  });

  it("reports everything missing for a nonexistent CODEX_HOME", async () => {
    const missingHome = path.join(codexHome, "missing");
    const result = await new Rly0DashboardManager({
      environment: { CODEX_HOME: missingHome },
    }).health();
    expect(rly0DashboardHealthResultSchema.parse(result)).toEqual({
      codexHome: missingHome,
      codexHomeExists: false,
      authJsonExists: false,
      configTomlExists: false,
      configTomlParses: null,
      sessionsDirExists: false,
    });
  });

  it("checks auth.json by existence only and validates config.toml", async () => {
    await fs.writeFile(path.join(codexHome, "auth.json"), '{"secret":"do-not-read"}', "utf8");
    await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "x"\n', "utf8");
    await fs.mkdir(path.join(codexHome, "sessions"));
    const readFileSpy = vi.spyOn(fs, "readFile");
    const openSpy = vi.spyOn(fs, "open");
    const result = await manager.health();
    expect(result).toEqual({
      codexHome,
      codexHomeExists: true,
      authJsonExists: true,
      configTomlExists: true,
      configTomlParses: true,
      sessionsDirExists: true,
    });
    const touched = [...readFileSpy.mock.calls, ...openSpy.mock.calls].map((call) =>
      String(call[0]),
    );
    expect(touched.some((file) => file.endsWith("auth.json"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("do-not-read");
  });

  it("reports a broken config.toml as not parsing, without the error text", async () => {
    await fs.writeFile(path.join(codexHome, "config.toml"), "model = = [broken\n", "utf8");
    const result = await manager.health();
    expect(result.configTomlExists).toBe(true);
    expect(result.configTomlParses).toBe(false);
    expect(result.authJsonExists).toBe(false);
    expect(result.sessionsDirExists).toBe(false);
  });

  it("returns zeroed stats and an 84-day window when sessions are missing", async () => {
    const result = rly0DashboardThreadStatsResultSchema.parse(await manager.threadStats());
    expect(result.rootExists).toBe(false);
    expect(result.stats).toEqual({
      totalThreads: 0,
      totalBytes: 0,
      activeDays: 0,
      averagePerActiveDay: 0,
    });
    expect(result.activity).toHaveLength(RLY0_DASHBOARD_ACTIVITY_DAYS);
    // The Hub's 首页 grid gets 105 weeks ending on the same day.
    expect(result.history).toHaveLength(RLY0_DASHBOARD_HISTORY_DAYS);
    expect(result.history?.at(-1)?.date).toBe(result.activity.at(-1)?.date);
    expect(result.activity.at(-1)?.date).toBe("2026-09-30");
  });

  it("counts session files by mtime", async () => {
    const file = path.join(codexHome, "sessions", "2026", "09", "30", "rollout-a.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{}\n", "utf8");
    const when = new Date(2026, 8, 30, 9);
    await fs.utimes(file, when, when);
    const result = await manager.threadStats();
    expect(result.rootExists).toBe(true);
    expect(result.stats.totalThreads).toBe(1);
    expect(result.stats.totalBytes).toBe(3);
    expect(result.activity.at(-1)).toEqual({ date: "2026-09-30", count: 1 });
  });

  it("maps errors to a fixed code", () => {
    expect(rly0DashboardRpcError()).toEqual({
      code: -32000,
      message: "DASHBOARD_OPERATION_FAILED",
    });
  });
});
