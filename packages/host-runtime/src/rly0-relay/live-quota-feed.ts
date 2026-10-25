import { promises as fs } from "node:fs";
import path from "node:path";

import type { HostUsage } from "@codexhost/harness-adapter";
import type { Rly0AccountUsage, Rly0UsageWindow } from "@codexhost/shared-contracts";

import { sanitizeRly0Usage } from "../rly0-core/index.js";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { writePrivateQuotaCache } from "../rly0-maintenance/private-quota-cache.js";

/**
 * Quota numbers that real conversations already carry, handed from the Codex-side host to the
 * Hub window without any extra request:
 *
 * - Codex official: the app-server's `account/rateLimits/updated` notifications (the same numbers
 *   Codex reads from ChatGPT's `x-codex-primary/secondary-*` response headers; the unified
 *   channel's core proxy passes those headers through unchanged).
 * - Claude subscription tokens behind the local forwarder: Anthropic's
 *   `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}` response headers.
 * - Relay turns: only the time a relay turn finished, so the Hub can re-read the balance.
 *
 * The host writes one small private file (`~/.rly0-hub/quota-cache/live-quota.json`); the Hub
 * service polls its modification time. No credential, request body, or header other than the
 * numbers above is ever written.
 */
export type LiveQuotaProvider = "codex" | "claude";

export interface LiveQuotaEntry {
  readonly provider: LiveQuotaProvider;
  /** Codex: the official account id (or "current"); Claude: the relay id of the token. */
  readonly key: string;
  /** Codex only: the signed-in email, to match the Hub's saved account. */
  readonly email?: string;
  readonly usage: Rly0AccountUsage;
  /** Epoch ms when the response carrying these numbers arrived. */
  readonly observedAt: number;
}

export interface LiveQuotaDocument {
  readonly version: 1;
  readonly entries: readonly LiveQuotaEntry[];
  /** Epoch ms when the latest relay turn finished (a balance changed). */
  readonly relayTurnAt?: number;
}

export function liveQuotaFeedPath(environment: NodeJS.ProcessEnv): string {
  return path.join(resolveRly0DataDir(environment), "quota-cache", "live-quota.json");
}

const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 86_400;
const KEY = /^[A-Za-z0-9._~@+-]{1,256}$/u;
const MAX_ENTRIES = 32;

type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

function header(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  const first = Array.isArray(value) ? (value as readonly string[])[0] : value;
  return typeof first === "string" ? first.trim() : undefined;
}

/**
 * Anthropic's unified rate-limit headers → the Hub's usage windows. Utilization is 0–1; the
 * reset is unix seconds. Returns null when the response carries neither window (API keys,
 * relays, errors before the limiter).
 */
export function parseAnthropicRateLimitHeaders(
  headers: HeaderBag,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Rly0AccountUsage | null {
  const windows: Rly0UsageWindow[] = [];
  for (const [key, kind, seconds] of [
    ["5h", "primary", FIVE_HOURS],
    ["7d", "secondary", SEVEN_DAYS],
  ] as const) {
    const raw = header(headers, `anthropic-ratelimit-unified-${key}-utilization`);
    if (raw === undefined || raw === "") continue;
    const utilization = Number(raw);
    if (!Number.isFinite(utilization) || utilization < 0) continue;
    const window: Rly0UsageWindow = {
      kind,
      usedPercent: Math.min(100, Math.round(utilization * 10_000) / 100),
      windowSeconds: seconds,
    };
    const reset = Number(header(headers, `anthropic-ratelimit-unified-${key}-reset`));
    if (Number.isSafeInteger(reset) && reset > 0 && reset < 100_000_000_000) {
      windows.push({ ...window, resetsAt: reset });
    } else windows.push(window);
  }
  if (windows.length === 0) return null;
  return { windows, fetchedAt: nowSeconds, source: "live" };
}

/** Codex's plan rows (from a rate-limit notification) → the Hub's usage windows. */
export function codexUsageFromPlan(
  plan: Partial<HostUsage>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Rly0AccountUsage | null {
  const windows: Rly0UsageWindow[] = [];
  const add = (
    kind: Rly0UsageWindow["kind"],
    seconds: number,
    used: number | undefined,
    resetsAt: number | undefined,
  ) => {
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return;
    windows.push({
      kind,
      usedPercent: Math.min(100, used),
      windowSeconds: seconds,
      ...(Number.isSafeInteger(resetsAt) && (resetsAt ?? 0) > 0 ? { resetsAt } : {}),
    });
  };
  add("primary", FIVE_HOURS, plan.planFiveHourUsedPercent, plan.planFiveHourResetsAtUnix);
  add("secondary", SEVEN_DAYS, plan.planSevenDayUsedPercent, plan.planSevenDayResetsAtUnix);
  return windows.length ? { windows, fetchedAt: nowSeconds, source: "live" } : null;
}

function cleanEntry(value: unknown): LiveQuotaEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (entry.provider !== "codex" && entry.provider !== "claude") return null;
  if (typeof entry.key !== "string" || !KEY.test(entry.key)) return null;
  if (
    typeof entry.observedAt !== "number" ||
    !Number.isSafeInteger(entry.observedAt) ||
    entry.observedAt <= 0
  )
    return null;
  const usage = sanitizeRly0Usage(entry.usage);
  if (!usage?.windows.length) return null;
  const email =
    typeof entry.email === "string" && entry.email.length <= 320 && entry.email.includes("@")
      ? entry.email
      : undefined;
  return {
    provider: entry.provider,
    key: entry.key,
    ...(email ? { email } : {}),
    usage: { ...usage, source: "live" },
    observedAt: entry.observedAt,
  };
}

export function parseLiveQuotaDocument(text: string): LiveQuotaDocument {
  const empty: LiveQuotaDocument = { version: 1, entries: [] };
  if (text.length > 256 * 1024) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (typeof raw !== "object" || raw === null) return empty;
  const document = raw as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.entries)) return empty;
  const entries = document.entries
    .slice(0, MAX_ENTRIES)
    .map(cleanEntry)
    .filter((entry): entry is LiveQuotaEntry => entry !== null);
  const relayTurnAt = document.relayTurnAt;
  return {
    version: 1,
    entries,
    ...(typeof relayTurnAt === "number" && Number.isSafeInteger(relayTurnAt) && relayTurnAt > 0
      ? { relayTurnAt }
      : {}),
  };
}

export async function readLiveQuotaDocument(file: string): Promise<LiveQuotaDocument> {
  try {
    return parseLiveQuotaDocument(await fs.readFile(file, "utf8"));
  } catch {
    return { version: 1, entries: [] };
  }
}

export interface LiveQuotaFeedOptions {
  readonly file: string;
  /** Writes are coalesced: at most one per this many ms (default 2 s). */
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly write?: (file: string, value: LiveQuotaDocument) => Promise<void>;
  readonly read?: (file: string) => Promise<LiveQuotaDocument>;
}

/**
 * The host's writer. Every observation replaces the previous one for the same account or token;
 * writes are coalesced so a streaming turn costs one small file write every few seconds at most.
 */
export class Rly0LiveQuotaFeed {
  readonly #options: LiveQuotaFeedOptions;
  readonly #pending = new Map<string, LiveQuotaEntry>();
  #relayTurnAt: number | undefined;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastWriteAt = 0;
  #writing: Promise<void> = Promise.resolve();

  constructor(options: LiveQuotaFeedOptions) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  record(entry: Omit<LiveQuotaEntry, "observedAt"> & { observedAt?: number }): void {
    const clean = cleanEntry({ ...entry, observedAt: entry.observedAt ?? this.#now() });
    if (!clean) return;
    this.#pending.set(`${clean.provider}:${clean.key}`, clean);
    this.#schedule();
  }

  /** A relay turn finished: the relay's balance changed. */
  relayTurnFinished(): void {
    this.#relayTurnAt = this.#now();
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer) return;
    const interval = this.#options.minIntervalMs ?? 2_000;
    const wait = Math.max(0, this.#lastWriteAt + interval - this.#now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, wait);
    this.#timer.unref?.();
  }

  /** Writes what is pending now (tests and shutdown). */
  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#pending.size === 0 && this.#relayTurnAt === undefined) return this.#writing;
    const entries = [...this.#pending.values()];
    const relayTurnAt = this.#relayTurnAt;
    this.#pending.clear();
    this.#relayTurnAt = undefined;
    this.#lastWriteAt = this.#now();
    const read = this.#options.read ?? readLiveQuotaDocument;
    const write = this.#options.write ?? writePrivateQuotaCache;
    this.#writing = this.#writing
      .then(async () => {
        const previous = await read(this.#options.file);
        const merged = new Map(previous.entries.map((e) => [`${e.provider}:${e.key}`, e]));
        for (const entry of entries) {
          const key = `${entry.provider}:${entry.key}`;
          if ((merged.get(key)?.observedAt ?? 0) <= entry.observedAt) merged.set(key, entry);
        }
        const next: LiveQuotaDocument = {
          version: 1,
          entries: [...merged.values()]
            .sort((a, b) => b.observedAt - a.observedAt)
            .slice(0, MAX_ENTRIES),
          ...((relayTurnAt ?? previous.relayTurnAt)
            ? { relayTurnAt: Math.max(relayTurnAt ?? 0, previous.relayTurnAt ?? 0) }
            : {}),
        };
        await write(this.#options.file, next);
      })
      .catch(() => undefined);
    return this.#writing;
  }
}
