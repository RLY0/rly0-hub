import { promises as fs } from "node:fs";

import type { Rly0Account, Rly0AccountUsage, Rly0Relay } from "@codexhost/shared-contracts";

import {
  readLiveQuotaDocument,
  type LiveQuotaDocument,
  type LiveQuotaEntry,
} from "../rly0-relay/live-quota-feed.js";
import { officialVendorOf } from "../rly0-relay/official-keys.js";

/**
 * The Hub side of the live quota feed (rly0-relay/live-quota-feed.ts): watches the small file the
 * Codex-side host writes, maps each observation to the Hub's own account or token, keeps the
 * Claude token numbers in the persisted token-usage cache, and pushes one event per change to the
 * window. A finished relay turn re-reads the balance, at most once per `balanceDebounceMs`.
 * Polling is a file `stat` every `pollMs`; no network request is made for quota.
 */
export interface LiveQuotaUpdate {
  readonly provider: "codex" | "claude";
  /** Codex: the Hub account id; Claude: the token's relay id. */
  readonly id: string;
  readonly usage: Rly0AccountUsage;
  /** Epoch ms when the reply carrying the numbers arrived. */
  readonly observedAt: number;
  readonly source: "conversation";
}

export interface Rly0HubLiveQuotaOptions {
  readonly file: string;
  readonly listAccounts: () => Promise<readonly Rly0Account[]>;
  readonly listRelays: () => Promise<readonly Rly0Relay[]>;
  /** Persist a Claude token's numbers (Rly0OfficialKeyUsage.record). */
  readonly recordToken: (relay: Rly0Relay, info: Record<string, unknown>) => Promise<unknown>;
  readonly emit: (event: string, params: Record<string, unknown>) => void;
  /** Re-read the zero relay balance; its result is pushed as the `balance` event. */
  readonly readBalance?: () => Promise<Record<string, unknown> | null>;
  readonly pollMs?: number;
  readonly balanceDebounceMs?: number;
  readonly now?: () => number;
  readonly read?: (file: string) => Promise<LiveQuotaDocument>;
  readonly mtime?: (file: string) => Promise<number | null>;
}

async function fileMtime(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

export class Rly0HubLiveQuota {
  readonly #options: Rly0HubLiveQuotaOptions;
  readonly #latest = new Map<string, LiveQuotaUpdate>();
  readonly #seen = new Map<string, number>();
  #mtime: number | null = null;
  #relayTurnAt = 0;
  #balanceAt = 0;
  #balanceTimer: ReturnType<typeof setTimeout> | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;
  #checking: Promise<void> | null = null;
  /** The first read only learns what is there; older observations are not pushed again. */
  #primed = false;

  constructor(options: Rly0HubLiveQuotaOptions) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  start(): void {
    if (this.#poll) return;
    void this.check();
    this.#poll = setInterval(() => void this.check(), this.#options.pollMs ?? 2_000);
    this.#poll.unref?.();
  }

  dispose(): void {
    if (this.#poll) clearInterval(this.#poll);
    if (this.#balanceTimer) clearTimeout(this.#balanceTimer);
    this.#poll = null;
    this.#balanceTimer = null;
  }

  /** What the feed said so far (the window's store starts from this). */
  snapshot(): LiveQuotaUpdate[] {
    return [...this.#latest.values()];
  }

  /** One poll: reads the file only when its modification time changed. */
  check(): Promise<void> {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #check(): Promise<void> {
    const mtime = await (this.#options.mtime ?? fileMtime)(this.#options.file);
    if (mtime === null || mtime === this.#mtime) {
      this.#primed = true;
      return;
    }
    this.#mtime = mtime;
    const document = await (this.#options.read ?? readLiveQuotaDocument)(this.#options.file);
    const fresh = document.entries.filter((entry) => {
      const key = `${entry.provider}:${entry.key}`;
      if ((this.#seen.get(key) ?? 0) >= entry.observedAt) return false;
      this.#seen.set(key, entry.observedAt);
      return true;
    });
    const announce = this.#primed;
    this.#primed = true;
    if (fresh.length) await this.#apply(fresh, announce).catch(() => undefined);
    if (document.relayTurnAt && document.relayTurnAt > this.#relayTurnAt) {
      const first = this.#relayTurnAt === 0 && !announce;
      this.#relayTurnAt = document.relayTurnAt;
      if (!first) this.#scheduleBalance();
    }
  }

  async #apply(entries: readonly LiveQuotaEntry[], announce: boolean): Promise<void> {
    const codex = entries.filter((entry) => entry.provider === "codex");
    const claude = entries.filter((entry) => entry.provider === "claude");
    if (codex.length) {
      const accounts = await this.#options.listAccounts().catch(() => []);
      for (const entry of codex) {
        const account = matchCodexAccount(accounts, entry);
        if (account) this.#publish("codex", account.id, entry, announce);
      }
    }
    if (claude.length) {
      const relays = await this.#options.listRelays().catch(() => []);
      for (const entry of claude) {
        const relay = relays.find((candidate) => candidate.id === entry.key);
        if (!relay || officialVendorOf(relay) !== "anthropic") continue;
        await this.#options
          .recordToken(relay, { kind: "subscription", usage: entry.usage })
          .catch(() => undefined);
        this.#publish("claude", relay.id, entry, announce);
      }
    }
  }

  #publish(
    provider: "codex" | "claude",
    id: string,
    entry: LiveQuotaEntry,
    announce: boolean,
  ): void {
    const update: LiveQuotaUpdate = {
      provider,
      id,
      usage: entry.usage,
      observedAt: entry.observedAt,
      source: "conversation",
    };
    this.#latest.set(`${provider}:${id}`, update);
    if (announce) this.#options.emit("quota", { ...update });
  }

  #scheduleBalance(): void {
    if (!this.#options.readBalance || this.#balanceTimer) return;
    const debounce = this.#options.balanceDebounceMs ?? 30_000;
    const wait = Math.max(0, this.#balanceAt + debounce - this.#now());
    this.#balanceTimer = setTimeout(() => {
      this.#balanceTimer = null;
      this.#balanceAt = this.#now();
      void this.#options
        .readBalance?.()
        .then((balance) => {
          if (balance) this.#options.emit("balance", balance);
        })
        .catch(() => undefined);
    }, wait);
    this.#balanceTimer.unref?.();
  }
}

/** The saved Codex account a notification belongs to: its official id, else its email. */
export function matchCodexAccount(
  accounts: readonly Rly0Account[],
  entry: Pick<LiveQuotaEntry, "key" | "email">,
): Rly0Account | null {
  const byId = accounts.find((account) => account.accountId && account.accountId === entry.key);
  if (byId) return byId;
  const email = entry.email?.toLowerCase();
  if (email) {
    const byEmail = accounts.filter((account) => account.email?.toLowerCase() === email);
    if (byEmail.length === 1) return byEmail[0] ?? null;
    const current = byEmail.find((account) => account.current);
    if (current) return current;
  }
  // Codex has one login: without an id or email to go by, it is the current account.
  if (entry.key === "current" && !email) return accounts.find((account) => account.current) ?? null;
  return null;
}
