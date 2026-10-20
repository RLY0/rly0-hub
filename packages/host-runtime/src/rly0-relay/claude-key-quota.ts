import type {
  AccountCreditsSnapshot,
  Rly0AccountUsage,
  Rly0UsageWindow,
  ThreadQuotaState,
} from "@codexhost/shared-contracts";

import { sanitizeRly0Usage } from "../rly0-core/index.js";

/**
 * Plan quota of the official Anthropic key or subscription token that RLY/0 Hub keeps for Claude
 * Code (the `claudeCode` relay choice pointing at an `api.anthropic.com` entry). Claude Code runs
 * behind the local proxy and never sees the token, so it reports no plan windows itself; rly0-core
 * `claude/keyInfo` reads them instead (the OAuth usage endpoint, or for a `claude setup-token`
 * token the rate-limit headers of a one-token model request).
 *
 * Because a read can cost a tiny model request, reads happen at most once per
 * `autoIntervalMs` per token on their own (Usage inspections, opening a Thread), and on the
 * user's explicit refresh no more often than `manualIntervalMs`. A passive inspection never
 * waits: it starts the read and reports what is known; `onUpdate` fires when the read lands.
 */
export const CLAUDE_KEY_QUOTA_AUTO_INTERVAL_MS = 5 * 60_000;
export const CLAUDE_KEY_QUOTA_MANUAL_INTERVAL_MS = 10_000;

/** Which saved key: its relay entry and the core's mask, so a replaced token reads afresh. */
export interface ClaudeOfficialKeyRef {
  readonly relayId: string;
  readonly keyMask?: string | null;
}

/** The Usage Popover's plan rows (same fields the Claude Code adapter fills from its events). */
export interface ClaudeKeyPlanUsage {
  planFiveHourUsedPercent?: number;
  planFiveHourResetsAtUnix?: number;
  planSevenDayUsedPercent?: number;
  planSevenDayResetsAtUnix?: number;
}

export interface ClaudeKeyQuotaSnapshot {
  readonly credits: AccountCreditsSnapshot;
  readonly plan: ClaudeKeyPlanUsage;
  /** When rly0-core read the numbers (ISO 8601); the core reuses a probe for a minute. */
  readonly observedAt?: string;
}

export interface ClaudeKeyQuotaRead {
  /** Absent for a passive inspection before anything was read. */
  readonly quota?: ThreadQuotaState;
  /** The last good numbers, kept across failed reads. */
  readonly snapshot: ClaudeKeyQuotaSnapshot | null;
}

export type ClaudeKeyInfoReader = (relayId: string) => Promise<unknown>;

interface Entry {
  snapshot: ClaudeKeyQuotaSnapshot | null;
  /** The last read's start (ms); reads are counted when started, failed or not. */
  attemptedAt: number | null;
  outcome: "live" | "failed" | "notSubscriber" | null;
  /** The last failed read was the provider limiting quota checks (USAGE_RATE_LIMITED). */
  rateLimited: boolean;
  inflight: Promise<void> | null;
}

const SIX_HOURS_SECONDS = 6 * 3600;
const SIX_DAYS_SECONDS = 6 * 86_400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoFromUnix(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isFiveHour(window: Rly0UsageWindow): boolean {
  return window.windowSeconds
    ? window.windowSeconds <= SIX_HOURS_SECONDS
    : window.kind === "primary";
}

function isSevenDay(window: Rly0UsageWindow): boolean {
  return window.windowSeconds
    ? window.windowSeconds >= SIX_DAYS_SECONDS
    : window.kind === "secondary";
}

/** rly0-core usage windows → the credits capsule and the Popover's plan rows. */
export function projectClaudeKeyUsage(usage: Rly0AccountUsage): ClaudeKeyQuotaSnapshot | null {
  const fiveHour = usage.windows.find(isFiveHour);
  const sevenDay = usage.windows.find(isSevenDay);
  const primary = fiveHour ?? sevenDay;
  if (!primary) return null;
  const other = fiveHour && sevenDay ? sevenDay : undefined;
  const primaryResetsAt = isoFromUnix(primary.resetsAt);
  const otherResetsAt = isoFromUnix(other?.resetsAt);
  const credits: AccountCreditsSnapshot = {
    usedPercent: primary.usedPercent,
    periodType: fiveHour ? "five_hour" : "seven_day",
    ...(primaryResetsAt ? { resetsAt: primaryResetsAt } : {}),
    ...(other
      ? {
          productUsage: [
            {
              product: "7-day window",
              usagePercent: other.usedPercent,
              ...(otherResetsAt ? { resetsAt: otherResetsAt } : {}),
            },
          ],
        }
      : {}),
  };
  const plan: ClaudeKeyPlanUsage = {};
  if (fiveHour) {
    plan.planFiveHourUsedPercent = fiveHour.usedPercent;
    if (fiveHour.resetsAt !== undefined) plan.planFiveHourResetsAtUnix = fiveHour.resetsAt;
  }
  if (sevenDay) {
    plan.planSevenDayUsedPercent = sevenDay.usedPercent;
    if (sevenDay.resetsAt !== undefined) plan.planSevenDayResetsAtUnix = sevenDay.resetsAt;
  }
  const observedAt = isoFromUnix(usage.fetchedAt);
  return { credits, plan, ...(observedAt ? { observedAt } : {}) };
}

export class ClaudeOfficialKeyQuota {
  readonly #read: ClaudeKeyInfoReader;
  readonly #now: () => number;
  readonly #autoIntervalMs: number;
  readonly #manualIntervalMs: number;
  readonly #onUpdate: (() => void) | undefined;
  #key: string | null = null;
  #entry: Entry = ClaudeOfficialKeyQuota.#empty();

  constructor(
    read: ClaudeKeyInfoReader,
    options: {
      now?: () => number;
      autoIntervalMs?: number;
      manualIntervalMs?: number;
      onUpdate?: () => void;
    } = {},
  ) {
    this.#read = read;
    this.#now = options.now ?? Date.now;
    this.#autoIntervalMs = options.autoIntervalMs ?? CLAUDE_KEY_QUOTA_AUTO_INTERVAL_MS;
    this.#manualIntervalMs = options.manualIntervalMs ?? CLAUDE_KEY_QUOTA_MANUAL_INTERVAL_MS;
    this.#onUpdate = options.onUpdate;
  }

  static #empty(): Entry {
    return {
      snapshot: null,
      attemptedAt: null,
      outcome: null,
      rateLimited: false,
      inflight: null,
    };
  }

  /**
   * Passive (`explicit` false): starts a read when none happened within the automatic interval
   * and answers at once from what is known. Explicit: awaits a read (or the one in flight).
   */
  async inspect(ref: ClaudeOfficialKeyRef, explicit: boolean): Promise<ClaudeKeyQuotaRead> {
    const entry = this.#entryFor(ref);
    const since = entry.attemptedAt === null ? Infinity : this.#now() - entry.attemptedAt;
    if (!explicit) {
      if (!entry.inflight && since >= this.#autoIntervalMs) void this.#start(ref.relayId, entry);
      return this.#state(entry, "cached");
    }
    if (entry.inflight) await entry.inflight;
    else if (since >= this.#manualIntervalMs) await this.#start(ref.relayId, entry);
    else return this.#state(entry, "cached");
    return this.#state(entry, entry.outcome === "live" ? "live" : "failed");
  }

  #entryFor(ref: ClaudeOfficialKeyRef): Entry {
    const key = `${ref.relayId}\u0000${ref.keyMask ?? ""}`;
    if (this.#key !== key) {
      this.#key = key;
      this.#entry = ClaudeOfficialKeyQuota.#empty();
    }
    return this.#entry;
  }

  #state(entry: Entry, status: "live" | "cached" | "failed"): ClaudeKeyQuotaRead {
    if (entry.outcome === "notSubscriber") {
      return { quota: { status: "unavailable", reason: "notSubscriber" }, snapshot: null };
    }
    const observedAt = entry.snapshot?.observedAt;
    const failure = entry.outcome === "failed" && entry.rateLimited ? "rateLimited" : undefined;
    if (status === "cached" && !entry.snapshot) {
      return entry.outcome === "failed"
        ? { quota: { status: "failed", ...(failure ? { failure } : {}) }, snapshot: null }
        : { snapshot: null };
    }
    return {
      quota: {
        status,
        ...(observedAt ? { observedAt } : {}),
        ...(status === "failed" && failure ? { failure } : {}),
      },
      snapshot: entry.snapshot,
    };
  }

  #start(relayId: string, entry: Entry): Promise<void> {
    entry.attemptedAt = this.#now();
    const run = (async () => {
      const info = await this.#read(relayId).catch(() => null);
      if (isRecord(info) && info.kind === "apiKey") {
        entry.outcome = "notSubscriber";
        entry.snapshot = null;
        return;
      }
      const usage = isRecord(info) ? sanitizeRly0Usage(info.usage) : undefined;
      const snapshot = usage ? projectClaudeKeyUsage(usage) : null;
      if (snapshot) entry.snapshot = snapshot;
      entry.outcome = snapshot ? "live" : "failed";
      entry.rateLimited = !snapshot && isRecord(info) && info.usageError === "USAGE_RATE_LIMITED";
    })().finally(() => {
      entry.inflight = null;
      // A replaced key started a fresh entry; nothing to announce for the old one.
      if (this.#entry === entry) this.#onUpdate?.();
    });
    entry.inflight = run;
    return run;
  }
}

/** Thread Usage with the key's plan rows laid over it (or the rows alone before any turn). */
export function withClaudeKeyPlanUsage<T extends object>(
  usage: T | null,
  plan: ClaudeKeyPlanUsage | undefined,
): (T & ClaudeKeyPlanUsage) | ClaudeKeyPlanUsage | null {
  if (!plan || !Object.keys(plan).length) return usage;
  return usage ? { ...usage, ...plan } : { ...plan };
}
