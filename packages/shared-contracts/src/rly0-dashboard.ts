import { z } from "zod";

import { rly0ThreadStatsSchema } from "./rly0-threads.js";

/**
 * Contracts for the dashboard page. Health checks are existence / parse-ability booleans only:
 * no file content (in particular nothing from `auth.json`, which is only `stat`-ed) ever crosses
 * this boundary.
 */

export const RLY0_DASHBOARD_HEALTH_METHOD = "codexhost/rly0/dashboard/health";
export const RLY0_DASHBOARD_THREAD_STATS_METHOD = "codexhost/rly0/dashboard/threadStats";

/** The activity heat map covers the last 12 weeks. */
export const RLY0_DASHBOARD_ACTIVITY_DAYS = 84;
/** RLY/0 Hub 首页 grid: 105 weeks, shown as many weeks as fit the window. */
export const RLY0_DASHBOARD_HISTORY_DAYS = 735;

export const rly0DashboardHealthParamsSchema = z.object({}).strict();
export type Rly0DashboardHealthParams = z.infer<typeof rly0DashboardHealthParamsSchema>;

export const rly0DashboardHealthResultSchema = z
  .object({
    codexHome: z.string().max(4096),
    codexHomeExists: z.boolean(),
    authJsonExists: z.boolean(),
    configTomlExists: z.boolean(),
    /** `null` when config.toml does not exist. */
    configTomlParses: z.boolean().nullable(),
    sessionsDirExists: z.boolean(),
  })
  .strict();
export type Rly0DashboardHealthResult = z.infer<typeof rly0DashboardHealthResultSchema>;

export const rly0DashboardThreadStatsParamsSchema = z.object({}).strict();
export type Rly0DashboardThreadStatsParams = z.infer<typeof rly0DashboardThreadStatsParamsSchema>;

export const rly0DashboardActivityDaySchema = z
  .object({
    /** Local calendar date, `YYYY-MM-DD`. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type Rly0DashboardActivityDay = z.infer<typeof rly0DashboardActivityDaySchema>;

export const rly0DashboardThreadStatsResultSchema = z
  .object({
    sessionsRoot: z.string().max(4096),
    rootExists: z.boolean(),
    stats: rly0ThreadStatsSchema,
    /** Oldest first, exactly 84 consecutive days ending today (host local time). */
    activity: z.array(rly0DashboardActivityDaySchema).length(RLY0_DASHBOARD_ACTIVITY_DAYS),
    /** Same, for the last 735 days (105 weeks); the Hub window shows as many weeks as fit. */
    history: z.array(rly0DashboardActivityDaySchema).max(RLY0_DASHBOARD_HISTORY_DAYS).optional(),
  })
  .strict();
export type Rly0DashboardThreadStatsResult = z.infer<typeof rly0DashboardThreadStatsResultSchema>;
