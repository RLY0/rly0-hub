import os from "node:os";

import {
  importLegacyCodexHostData,
  planLegacyCodexHostSync,
  type LegacyThreadCandidate,
  type LegacyThreadIssue,
} from "../legacy-codexhost-import.js";
import {
  backUpChatRecords,
  chatHealthPaths,
  chatRepairBackupDir,
  repairDamagedRecords,
  scanChatHealth,
  type ChatHealthItem,
  type ChatHealthKind,
} from "./chat-health.js";

/** What the maintenance page needs from `Rly0CodexControl`. */
export interface ChatRepairCodexControl {
  status(): Promise<{ running: boolean }>;
  forceQuit(): Promise<{ ok: boolean }>;
  open(): Promise<{ ok: boolean }>;
}

export type ChatRepairKind =
  `legacy-${Exclude<LegacyThreadIssue, "format">}` | "format" | ChatHealthKind;

/** One reason chats cannot be opened or continued, and whether the repair fixes it. */
export interface ChatRepairGroup {
  readonly kind: ChatRepairKind;
  readonly count: number;
  /** Of `count`, how many are archived. */
  readonly archived: number;
  /** Fixed by the repair (`legacy-deleted` only when asked). */
  readonly repairable: boolean;
  /** Newest first, at most 20. */
  readonly items: readonly ChatHealthItem[];
}

export interface ChatRepairScanResult {
  /** Kept for older windows; the scan always runs now. */
  readonly available: boolean;
  /** The legacy CodexHost comparison: `ok`, or why it was skipped. */
  readonly reason: string;
  /** Chats the repair fixes (deleted ones excluded). */
  readonly broken: number;
  /** Chats the user removed in the Hub; only brought back when asked. */
  readonly deleted: number;
  /** Legacy candidates, newest first, at most 50 (older windows list these). */
  readonly items: readonly LegacyThreadCandidate[];
  /** How many chats were looked at; `codex` is null when Codex's list could not be read. */
  readonly checked: {
    readonly agent: number;
    readonly codex: number | null;
    readonly legacy: number;
  };
  /** Every problem found, repairable or not. */
  readonly groups: readonly ChatRepairGroup[];
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
  /** Present when nothing was written; e.g. `CODEX_STILL_RUNNING`, `backup-failed`. */
  readonly reason?: string;
  /** Where the chat records were copied before anything was written. */
  readonly backupDir?: string;
}

export interface ChatRepairOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly codex: ChatRepairCodexControl;
  readonly home?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for Codex to finish closing. */
  readonly quitTimeoutMs?: number;
  readonly now?: () => Date;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const LEGACY_ISSUES = ["missing", "outdated", "deleted", "format"] as const;

/**
 * "修复聊天记录" on the maintenance page: checks every chat the Hub can see (agent chats in the
 * Hub's store, Codex's own list, chats left in the old CodexHost) and says what is wrong with
 * the broken ones (`ChatRepairKind`). The repair fixes what can be fixed safely: brings over
 * CodexHost chats the Hub cannot open ("no rollout found for thread id …", an empty
 * conversation), re-encodes upstream model choices (on Codex start), and puts back the backup of
 * a damaged record. The agents' and Codex's own files are only read.
 *
 * Codex's thread store reads these records once when it starts and keeps them in memory, so the
 * repair runs while Codex is closed: close it, back the records up, repair, open it again.
 * Nothing is deleted; the old CodexHost directory is only read.
 */
export class ChatRepair {
  readonly #options: ChatRepairOptions;

  constructor(options: ChatRepairOptions) {
    this.#options = options;
  }

  async scan(): Promise<ChatRepairScanResult> {
    const plan = planLegacyCodexHostSync(this.#options.environment, this.#home());
    const health = await scanChatHealth(this.#paths());
    const legacyGroups = LEGACY_ISSUES.flatMap((issue): ChatRepairGroup[] => {
      const found = plan.candidates.filter((c) => c.issue === issue);
      if (!found.length) return [];
      return [
        {
          kind: issue === "format" ? "format" : `legacy-${issue}`,
          count: found.length,
          archived: 0,
          repairable: true,
          items: found.slice(0, 20).map(({ id, title, harnessId, updatedAt }) => ({
            id,
            title,
            harnessId,
            updatedAt,
          })),
        },
      ];
    });
    const groups = [...legacyGroups, ...health.groups];
    return {
      available: true,
      reason: plan.reason,
      broken: groups
        .filter((g) => g.repairable && g.kind !== "legacy-deleted")
        .reduce((sum, g) => sum + g.count, 0),
      deleted: plan.candidates.filter((c) => c.issue === "deleted").length,
      items: plan.candidates.slice(0, 50),
      checked: { agent: health.agentChats, codex: health.codexChats, legacy: plan.legacyThreads },
      groups,
    };
  }

  async repair(
    params: { readonly includeDeleted?: boolean | undefined } = {},
  ): Promise<ChatRepairResult> {
    const { codex } = this.#options;
    const includeDeleted = params.includeDeleted === true;
    const before = await this.scan();
    // Nothing to fix: Codex is left alone.
    if (before.broken === 0 && !(includeDeleted && before.deleted > 0)) {
      return {
        ok: true,
        repaired: 0,
        codexRestarted: false,
        reopenFailed: false,
        fixedOnCodexStart: 0,
      };
    }
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
    const reopen = async () =>
      wasRunning ? !(await codex.open().catch(() => ({ ok: false }))).ok : false;
    const paths = this.#paths();
    const stamp = (this.#options.now?.() ?? new Date()).toISOString().replace(/[-:.]/gu, "");
    if (!backUpChatRecords(paths, stamp)) {
      return {
        ok: false,
        repaired: 0,
        codexRestarted: wasRunning,
        reopenFailed: await reopen(),
        fixedOnCodexStart: 0,
        reason: "backup-failed",
      };
    }
    let restored = 0;
    try {
      restored = repairDamagedRecords(paths, stamp);
    } catch {
      // Best effort: what was put back stays; the legacy merge below still runs.
    }
    const result = importLegacyCodexHostData(this.#options.environment, {
      ...this.#home(),
      includeDeleted,
    });
    const pending = planLegacyCodexHostSync(this.#options.environment, this.#home()).candidates;
    const fixedOnCodexStart = pending.filter((c) => c.issue === "format").length;
    const reopenFailed = await reopen();
    return {
      ok: result.reason !== "copy-failed",
      repaired: (result.threads ?? 0) + restored,
      codexRestarted: wasRunning,
      reopenFailed,
      fixedOnCodexStart,
      backupDir: chatRepairBackupDir(paths, stamp),
      ...(result.imported || restored > 0 ? {} : { reason: result.reason }),
    };
  }

  #paths() {
    return chatHealthPaths(this.#options.environment, this.#options.home ?? os.homedir());
  }

  #home(): { home?: string } {
    return this.#options.home ? { home: this.#options.home } : {};
  }
}
