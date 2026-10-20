import { z } from "zod";

import { hostThreadIdSchema } from "./ids.js";

const nonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const finiteNonNegativeNumberSchema = z.number().finite().nonnegative();
const cacheHitRatePercentSchema = z.number().finite().min(0).max(100);

export const threadUsageSnapshotSchema = z
  .object({
    inputTokens: nonNegativeSafeIntegerSchema.optional(),
    cachedInputTokens: nonNegativeSafeIntegerSchema.optional(),
    cacheWriteInputTokens: nonNegativeSafeIntegerSchema.optional(),
    outputTokens: nonNegativeSafeIntegerSchema.optional(),
    outputTokensPerSecond: finiteNonNegativeNumberSchema.optional(),
    reasoningOutputTokens: nonNegativeSafeIntegerSchema.optional(),
    totalTokens: nonNegativeSafeIntegerSchema.optional(),
    totalCostUsd: finiteNonNegativeNumberSchema.optional(),
    totalCredits: finiteNonNegativeNumberSchema.optional(),
    contextUsagePercent: finiteNonNegativeNumberSchema.optional(),
    cacheHitRatePercent: cacheHitRatePercentSchema.optional(),
    contextWindowTokens: nonNegativeSafeIntegerSchema.optional(),
    contextUsedTokens: nonNegativeSafeIntegerSchema.optional(),
    planFiveHourUsedPercent: cacheHitRatePercentSchema.optional(),
    planFiveHourResetsAtUnix: nonNegativeSafeIntegerSchema.optional(),
    planSevenDayUsedPercent: cacheHitRatePercentSchema.optional(),
    planSevenDayResetsAtUnix: nonNegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (Object.keys(usage).length === 0) {
      context.addIssue({ code: "custom", message: "Thread Usage must contain a reliable field" });
    }
    const hasContextUsed = usage.contextUsedTokens !== undefined;
    const hasContextWindow = usage.contextWindowTokens !== undefined;
    if (hasContextUsed !== hasContextWindow) {
      context.addIssue({
        code: "custom",
        message: "Thread Usage context fields must be provided together",
        path: [hasContextUsed ? "contextWindowTokens" : "contextUsedTokens"],
      });
    }
    if (usage.contextWindowTokens === 0) {
      context.addIssue({
        code: "custom",
        message: "Thread Usage contextWindowTokens must be greater than zero",
        path: ["contextWindowTokens"],
      });
    }
    if (
      usage.planFiveHourResetsAtUnix !== undefined &&
      usage.planFiveHourUsedPercent === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Thread Usage planFiveHourResetsAtUnix must be provided with planFiveHourUsedPercent",
        path: ["planFiveHourResetsAtUnix"],
      });
    }
    if (
      usage.planSevenDayResetsAtUnix !== undefined &&
      usage.planSevenDayUsedPercent === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Thread Usage planSevenDayResetsAtUnix must be provided with planSevenDayUsedPercent",
        path: ["planSevenDayResetsAtUnix"],
      });
    }
  });

export type ThreadUsageSnapshot = z.infer<typeof threadUsageSnapshotSchema>;

const usagePercentSchema = z.number().finite().min(0).max(100);

export const accountCreditsProductUsageSchema = z
  .object({
    product: z.string().min(1),
    usagePercent: usagePercentSchema,
    resetsAt: z.string().min(1).optional(),
  })
  .strict();

export const accountResetCreditsSchema = z
  .object({
    availableCount: z.number().int().safe().positive(),
    nextExpiresAt: z.string().min(1).optional(),
    expiresAt: z.array(z.string().min(1)).min(1).max(32).optional(),
  })
  .strict();

export const accountCreditsSnapshotSchema = z
  .object({
    /** Native label when the primary limit is scoped to a model or product group. */
    label: z.string().min(1).optional(),
    usedPercent: usagePercentSchema,
    resetsAt: z.string().min(1).optional(),
    periodType: z.enum(["weekly", "monthly", "five_hour", "seven_day", "unknown"]),
    productUsage: z.array(accountCreditsProductUsageSchema).min(1).optional(),
    resetCredits: accountResetCreditsSchema.optional(),
  })
  .strict();

export type AccountResetCredits = z.infer<typeof accountResetCreditsSchema>;
export type AccountCreditsSnapshot = z.infer<typeof accountCreditsSnapshotSchema>;

export const threadUsageInspectionParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    /**
     * `exact` asks the owning Session for its exact Usage (opening the details Popover).
     * `quota` is the user's explicit quota refresh: Host re-reads the Account quota through a
     * path that sends no model request, and reports the outcome in `quota`.
     */
    refresh: z.enum(["exact", "quota"]).optional(),
  })
  .strict();

export type ThreadUsageInspectionParams = z.infer<typeof threadUsageInspectionParamsSchema>;

/**
 * Why the Account quota of a Thread cannot be read on demand:
 * - `proxiedCredential`: the Harness runs on an official key or subscription token kept by
 *   RLY/0 Hub and sent by its local proxy, so the Harness never learns the plan windows;
 * - `relay`: the Harness runs through a third-party relay, which has a balance, not plan windows;
 * - `notSubscriber`: the Harness reports that plan limits do not apply to its login;
 * - `unsupported`: the Harness has no request-free quota read.
 */
export const threadQuotaUnavailableReasonSchema = z.enum([
  "proxiedCredential",
  "relay",
  "notSubscriber",
  "unsupported",
]);
export type ThreadQuotaUnavailableReason = z.infer<typeof threadQuotaUnavailableReasonSchema>;

export const threadQuotaStateSchema = z
  .object({
    /** `live`: just re-read; `cached`: still fresh, not re-read; `failed`: the read failed. */
    status: z.enum(["live", "cached", "failed", "unavailable"]),
    /** When the quota shown was last read (ISO 8601). */
    observedAt: z.string().min(1).max(64).optional(),
    reason: threadQuotaUnavailableReasonSchema.optional(),
  })
  .strict();
export type ThreadQuotaState = z.infer<typeof threadQuotaStateSchema>;

export const threadUsageInspectionSchema = z
  .object({
    threadId: hostThreadIdSchema,
    usage: threadUsageSnapshotSchema.nullable(),
    accountCredits: accountCreditsSnapshotSchema.optional(),
    quota: threadQuotaStateSchema.optional(),
  })
  .strict();

export type ThreadUsageInspection = z.infer<typeof threadUsageInspectionSchema>;
