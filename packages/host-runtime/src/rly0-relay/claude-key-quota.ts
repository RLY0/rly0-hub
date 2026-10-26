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
 * the numbers come from the rate-limit headers of Claude Code's own replies (`observe`, read by the
 * local forwarder), so the official side sees no request Claude Code would not make itself.
 *
 * Nothing is read on a timer or on a passive inspection (Usage popover, opening a Thread): those
 * report what real replies carried, or nothing yet ("未知 · 聊一句后更新"). Only the person's explicit
 * refresh reads with rly0-core `claude/keyInfo` (`probe: true`: the OAuth usage endpoint, or for a
 * `claude setup-token` token Claude Code's own one-token quota check), no more often than
 * `manualIntervalMs`.
 */
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
  readonly #manualIntervalMs: number;
  readonly #onUpdate: (() => void) | undefined;
  #key: string | null = null;
  #entry: Entry = ClaudeOfficialKeyQuota.#empty();
  /** The latest numbers a real reply carried, per token (see `observe`). */
  readonly #observed = new Map<string, { snapshot: ClaudeKeyQuotaSnapshot; at: number }>();

  constructor(
    read: ClaudeKeyInfoReader,
    options: {
      now?: () => number;
      manualIntervalMs?: number;
      onUpdate?: () => void;
    } = {},
  ) {
    this.#read = read;
    this.#now = options.now ?? Date.now;
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
   * Passive (`explicit` false): answers at once from what real replies carried; never reads.
   * Explicit (the person's refresh): awaits a read (or the one in flight).
   */
  async inspect(ref: ClaudeOfficialKeyRef, explicit: boolean): Promise<ClaudeKeyQuotaRead> {
    const entry = this.#entryFor(ref);
    const since = entry.attemptedAt === null ? Infinity : this.#now() - entry.attemptedAt;
    if (!explicit) return this.#state(entry, "cached");
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
      const seen = this.#observed.get(ref.relayId);
      if (seen) this.#seed(this.#entry, seen.snapshot, seen.at);
    }
    return this.#entry;
  }

  #seed(entry: Entry, snapshot: ClaudeKeyQuotaSnapshot, at: number): void {
    entry.snapshot = snapshot;
    entry.outcome = "live";
    entry.rateLimited = false;
    // Counts as a read: the automatic interval starts again, so no probe follows a reply.
    entry.attemptedAt = Math.max(entry.attemptedAt ?? 0, at);
  }

  /**
   * Numbers a real reply carried (Anthropic's unified rate-limit headers, read by the local
   * forwarder). They replace the last read and restart the automatic interval, so an active
   * Thread never needs a quota probe of its own.
   */
  observe(relayId: string, usage: Rly0AccountUsage): void {
    const snapshot = projectClaudeKeyUsage(usage);
    if (!snapshot) return;
    const at = this.#now();
    this.#observed.delete(relayId);
    this.#observed.set(relayId, { snapshot, at });
    const oldest = this.#observed.keys().next();
    if (this.#observed.size > 16 && !oldest.done) this.#observed.delete(oldest.value);
    if (this.#key?.startsWith(`${relayId}\u0000`)) {
      this.#seed(this.#entry, snapshot, at);
      this.#onUpdate?.();
    }
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
