import type {
  AccountCreditsSnapshot,
  Rly0AccountUsage,
  Rly0UsageWindow,
} from "@codexhost/shared-contracts";

import type { Rly0AccountMessages } from "./rly0-account-messages.js";

export type Rly0UsagePeriod = "five_hour" | "seven_day";

const SIX_HOURS_SECONDS = 6 * 60 * 60;
const SIX_DAYS_SECONDS = 6 * 24 * 60 * 60;

/**
 * Maps one rly0-core usage window onto the two comparison columns the account table already
 * renders. The window length wins when present; otherwise the core's `primary`/`secondary` kind
 * follows Codex's convention (primary = 5-hour, secondary = weekly).
 */
export function rly0UsagePeriod(window: Rly0UsageWindow): Rly0UsagePeriod | null {
  if (window.windowSeconds !== undefined && window.windowSeconds > 0) {
    if (window.windowSeconds <= SIX_HOURS_SECONDS) return "five_hour";
    if (window.windowSeconds >= SIX_DAYS_SECONDS) return "seven_day";
    return null;
  }
  return window.kind === "primary" ? "five_hour" : "seven_day";
}

function isoFromUnixSeconds(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function otherWindowLabel(window: Rly0UsageWindow): string {
  const seconds = window.windowSeconds ?? 0;
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d window`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h window`;
  return window.kind === "primary" ? "Primary window" : "Secondary window";
}

/** Converts a rly0-core usage payload into the snapshot shape the shared quota meters render. */
export function rly0UsageToCredits(usage: Rly0AccountUsage): AccountCreditsSnapshot | null {
  let fiveHour: Rly0UsageWindow | undefined;
  let weekly: Rly0UsageWindow | undefined;
  const others: Rly0UsageWindow[] = [];
  for (const window of usage.windows) {
    const period = rly0UsagePeriod(window);
    if (period === "five_hour" && !fiveHour) fiveHour = window;
    else if (period === "seven_day" && !weekly) weekly = window;
    else others.push(window);
  }
  const main = fiveHour ?? weekly ?? others[0];
  if (!main) return null;
  const productUsage: NonNullable<AccountCreditsSnapshot["productUsage"]> = [];
  if (fiveHour && weekly) {
    const weeklyResetsAt = isoFromUnixSeconds(weekly.resetsAt);
    productUsage.push({
      product: "7-day window",
      usagePercent: weekly.usedPercent,
      ...(weeklyResetsAt ? { resetsAt: weeklyResetsAt } : {}),
    });
  }
  for (const window of others) {
    if (window === main) continue;
    const resetsAt = isoFromUnixSeconds(window.resetsAt);
    productUsage.push({
      product: otherWindowLabel(window),
      usagePercent: window.usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const resetsAt = isoFromUnixSeconds(main.resetsAt);
  const mainPeriod = main === fiveHour ? "five_hour" : main === weekly ? "seven_day" : null;
  return {
    ...(mainPeriod ? {} : { label: otherWindowLabel(main) }),
    usedPercent: main.usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    periodType: mainPeriod ?? "unknown",
    ...(productUsage.length ? { productUsage } : {}),
  };
}

export interface Rly0UsageLowestWindow {
  readonly period: Rly0UsagePeriod | null;
  readonly remainingPercent: number;
  /** When that window resets, in Unix seconds, if the core reported it. */
  readonly resetsAt?: number;
}

/** The tightest window (lowest remaining percentage), or null when the core reported none. */
export function rly0UsageLowestWindow(usage: Rly0AccountUsage): Rly0UsageLowestWindow | null {
  let lowest: Rly0UsageLowestWindow | null = null;
  for (const window of usage.windows) {
    const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
    if (!lowest || remainingPercent < lowest.remainingPercent) {
      lowest = {
        period: rly0UsagePeriod(window),
        remainingPercent,
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      };
    }
  }
  return lowest;
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** Extracts the short, code-shaped message the host forwards for rly0-core failures. */
export function rly0ErrorCode(error: unknown): string | null {
  if (typeof error === "string") return ERROR_CODE_PATTERN.test(error) ? error : null;
  if (typeof error !== "object" || error === null || !("message" in error)) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && ERROR_CODE_PATTERN.test(message) ? message : null;
}

/** Human text for a usage lookup failure; unknown codes fall back to a generic message. */
export function rly0UsageErrorMessage(code: string | null, messages: Rly0AccountMessages): string {
  if (code === "USAGE_TOKEN_EXPIRED" || code === "ACCOUNT_TOKEN_MISSING") {
    return messages.usageTokenExpired;
  }
  if (code === "USAGE_BLOCKED") return messages.usageBlocked;
  if (code === "USAGE_NETWORK") return messages.usageNetwork;
  if (code === "RLY0_CORE_UNAVAILABLE") return messages.unavailableHint;
  return messages.usageFailed;
}

/** "刚刚" / "3 分钟前" / "2 小时前" for a unix-second timestamp. */
export function formatRly0RelativeTime(
  unixSeconds: number,
  messages: Rly0AccountMessages,
  nowMs: number = Date.now(),
): string {
  const elapsedMinutes = Math.floor(Math.max(0, nowMs - unixSeconds * 1000) / 60_000);
  if (elapsedMinutes < 1) return messages.justNow;
  if (elapsedMinutes < 60) return messages.minutesAgo.replace("{n}", String(elapsedMinutes));
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 48) return messages.hoursAgo.replace("{n}", String(hours));
  return messages.daysAgo.replace("{n}", String(Math.floor(hours / 24)));
}
