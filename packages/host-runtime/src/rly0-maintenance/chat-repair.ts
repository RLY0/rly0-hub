import {
  importLegacyCodexHostData,
  planLegacyCodexHostSync,
  type LegacyThreadCandidate,
} from "../legacy-codexhost-import.js";

/** What the maintenance page needs from `Rly0CodexControl`. */
export interface ChatRepairCodexControl {
  status(): Promise<{ running: boolean }>;
  forceQuit(): Promise<{ ok: boolean }>;
  open(): Promise<{ ok: boolean }>;
}

export interface ChatRepairScanResult {
  /** False: nothing to compare with (no CodexHost data, custom data directory, …). */
  readonly available: boolean;
  readonly reason: string;
  /** Chats the Hub cannot open now, or would open in an older state. Fixed by default. */
  readonly broken: number;
  /** Chats the user removed in the Hub; only brought back when asked. */
  readonly deleted: number;
  /** Newest first, at most 50. */
  readonly items: readonly LegacyThreadCandidate[];
}

export interface ChatRepairResult {
  readonly ok: boolean;
  readonly repaired: number;
  /** Codex was open and had to be closed: it was reopened (or reopening was attempted). */
  readonly codexRestarted: boolean;
  readonly reopenFailed: boolean;
  /**
   * Chats whose model choice still needs re-encoding. The Host runtime does that when Codex
   * opens (it carries the encoders); repairing reopens Codex when it was running, so this is
   * only non-zero when Codex was closed and these get fixed the next time it is opened.
   */
  readonly fixedOnCodexStart: number;
  /** Present when nothing was written; e.g. `CODEX_STILL_RUNNING`, `copy-failed`. */
  readonly reason?: string;
}

export interface ChatRepairOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly codex: ChatRepairCodexControl;
  readonly home?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for Codex to finish closing. */
  readonly quitTimeoutMs?: number;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * "修复聊天记录" on the maintenance page: finds chats with Claude Code and other agents that were
 * started under the old CodexHost and that the Hub cannot open ("no rollout found for thread
 * id …", an empty conversation), and brings them over.
 *
 * Codex's thread store reads these mappings once when it starts and keeps them in memory, so the
 * merge runs while Codex is closed: close it, merge, open it again. Nothing is deleted; the old
 * CodexHost directory is only read.
 */
export class ChatRepair {
  readonly #options: ChatRepairOptions;

  constructor(options: ChatRepairOptions) {
    this.#options = options;
  }

  scan(): ChatRepairScanResult {
    const plan = planLegacyCodexHostSync(this.#options.environment, this.#home());
    const deleted = plan.candidates.filter((c) => c.issue === "deleted").length;
    return {
      available: plan.available,
      reason: plan.reason,
      broken: plan.candidates.length - deleted,
      deleted,
      items: plan.candidates.slice(0, 50),
    };
  }

  async repair(
    params: { readonly includeDeleted?: boolean | undefined } = {},
  ): Promise<ChatRepairResult> {
    const { codex } = this.#options;
    const sleep = this.#options.sleep ?? sleepFor;
    const wasRunning = (await codex.status()).running;
    if (wasRunning) {
      await codex.forceQuit();
      // `status()` also trusts Codex's heartbeat, which goes stale 10 s after Codex is gone.
      const deadline = Date.now() + (this.#options.quitTimeoutMs ?? 20_000);
      while ((await codex.status()).running) {
        if (Date.now() >= deadline) {
          return {
            ok: false,
            repaired: 0,
            codexRestarted: false,
            reopenFailed: false,
            fixedOnCodexStart: 0,
            reason: "CODEX_STILL_RUNNING",
          };
        }
        await sleep(500);
      }
      // Let the thread store's last writes land before merging next to them.
      await sleep(1_000);
    }
    const result = importLegacyCodexHostData(this.#options.environment, {
      ...this.#home(),
      includeDeleted: params.includeDeleted === true,
    });
    const pending = planLegacyCodexHostSync(this.#options.environment, this.#home()).candidates;
    const fixedOnCodexStart = pending.filter((c) => c.issue === "format").length;
    let reopenFailed = false;
    if (wasRunning) reopenFailed = !(await codex.open().catch(() => ({ ok: false }))).ok;
    const failed = result.reason === "copy-failed";
    return {
      ok: !failed,
      repaired: result.threads ?? 0,
      codexRestarted: wasRunning,
      reopenFailed,
      fixedOnCodexStart,
      ...(result.imported ? {} : { reason: result.reason }),
    };
  }

  #home(): { home?: string } {
    return this.#options.home ? { home: this.#options.home } : {};
  }
}
