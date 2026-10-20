import type { ClaudePlanLimitEvent, ClaudePlanLimitWindow } from "./transport.js";

/**
 * Result of Claude Code's `get_usage` control request (the structured `/usage` data). The CLI
 * answers it from the claude.ai usage endpoint for an OAuth login that has the `user:profile`
 * scope; it sends no model request. A `setup-token` (scope `user:inference` only), an API key or
 * a third-party provider answer `rate_limits_available: false`.
 */
export type ClaudePlanUsageRead =
  | { readonly available: false }
  | { readonly available: true; readonly planLimit: ClaudePlanLimitEvent | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `get_usage` reports utilization in percent (0-100) and the reset as an ISO 8601 time. */
function parseUsageWindow(value: unknown): ClaudePlanLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const utilization = value.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0) {
    return undefined;
  }
  const utilizationPercent = Math.min(100, Math.round(utilization * 100) / 100);
  const resetsAtMs = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : NaN;
  return Number.isFinite(resetsAtMs) && resetsAtMs >= 0
    ? { utilizationPercent, resetsAtUnix: Math.floor(resetsAtMs / 1000) }
    : { utilizationPercent };
}

export function parseClaudePlanUsage(value: unknown): ClaudePlanUsageRead | null {
  if (!isRecord(value) || typeof value.rate_limits_available !== "boolean") return null;
  if (!value.rate_limits_available) return { available: false };
  const limits = isRecord(value.rate_limits) ? value.rate_limits : undefined;
  const fiveHour = parseUsageWindow(limits?.five_hour);
  const sevenDay = parseUsageWindow(limits?.seven_day);
  return {
    available: true,
    planLimit:
      fiveHour || sevenDay
        ? { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
        : null,
  };
}

/** Explicit refreshes closer together than this answer from the previous read. */
export const CLAUDE_PLAN_USAGE_COOLDOWN_MS = 10_000;

export interface ClaudePlanUsageSource {
  readPlanUsage(): Promise<ClaudePlanUsageRead | null>;
}

/**
 * Account-level plan-window reads through any open native Session: one read in flight, a
 * cooldown between reads, and a remembered "this login has no plan windows" answer.
 */
export class ClaudePlanUsageRefresher {
  readonly #sources: () => Iterable<ClaudePlanUsageSource>;
  readonly #record: (planLimit: ClaudePlanLimitEvent) => void;
  readonly #now: () => number;
  #inFlight: Promise<boolean> | null = null;
  #lastReadAt = Number.NEGATIVE_INFINITY;
  #lastResult = false;
  #unavailable = false;

  constructor(options: {
    sources: () => Iterable<ClaudePlanUsageSource>;
    record: (planLimit: ClaudePlanLimitEvent) => void;
    now?: () => number;
  }) {
    this.#sources = options.sources;
    this.#record = options.record;
    this.#now = options.now ?? Date.now;
  }

  /** True once Claude Code said plan limits do not apply to this login. */
  get unavailable(): boolean {
    return this.#unavailable;
  }

  /** A native `rate_limit_event` proves the login has plan windows. */
  observePush(): void {
    this.#unavailable = false;
  }

  /**
   * Resolves `true` when plan windows were read, `false` when the read failed or found none.
   * Only the user's explicit refresh reads (native pushes keep the windows current otherwise):
   * a passive call resolves `false` unless it joins a read in flight, and an explicit one within
   * the cooldown answers from the previous read.
   */
  refresh(explicit: boolean): Promise<boolean> {
    if (this.#inFlight) return this.#inFlight;
    if (!explicit) return Promise.resolve(false);
    if (this.#now() - this.#lastReadAt < CLAUDE_PLAN_USAGE_COOLDOWN_MS) {
      return Promise.resolve(this.#lastResult);
    }
    this.#lastReadAt = this.#now();
    this.#inFlight = this.#read().then((result) => {
      this.#lastResult = result;
      return result;
    });
    void this.#inFlight.finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #read(): Promise<boolean> {
    for (const source of this.#sources()) {
      let read: ClaudePlanUsageRead | null;
      try {
        read = await source.readPlanUsage();
      } catch {
        continue;
      }
      if (!read) continue;
      if (!read.available) {
        this.#unavailable = true;
        return false;
      }
      this.#unavailable = false;
      if (!read.planLimit) return false;
      this.#record(read.planLimit);
      return true;
    }
    return false;
  }
}
