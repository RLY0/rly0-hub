import { z } from "zod";

import type { BackendReloadStatus } from "../rly0-maintenance/backend-reload-channel.js";

/**
 * Makes a settings change the Hub just wrote (Codex's config.toml, login, MCP, isolation) take
 * effect in the running Codex without manual steps:
 *
 * - `backend`: the official app-server reads it. Codex opened through RLY/0 Hub swaps its backend
 *   in place (the window and conversations stay; a running reply finishes first).
 * - `window`: Codex Desktop itself must start again (for example the login gate). Codex is
 *   restarted through the Launcher right away when nothing is running, or as soon as the running
 *   work ends. Conversations are kept by Codex.
 *
 * A Codex whose state the Hub cannot see (older build, opened another way) is never restarted
 * on its own: the result says so and the page offers one click to restart it.
 */
export const codexApplyParams = z
  .object({
    scope: z.enum(["backend", "window"]),
    /** The person's one click on "立即应用": restart now, even when Codex might be busy. */
    restartNow: z.literal(true).optional(),
  })
  .strict();

export type Rly0CodexApplyOutcome =
  /** Backend swapped in place; the next message uses the new settings. */
  | "reloaded"
  /** A reply is running; the backend swap happens right after it. */
  | "deferred"
  /** Codex is not open through the Hub; the next start reads the new settings. */
  | "notRunning"
  /** Codex is being restarted through the Launcher. */
  | "restarting"
  /** Codex is busy; it restarts once the running work ends. */
  | "scheduled"
  /** The Hub cannot tell whether Codex is busy or reload it in place: ask for one click. */
  | "needsRestart"
  /** Restart was attempted and did not go through. */
  | "failed";

export interface Rly0CodexApplyDeps {
  readonly status: () => Promise<{ running: boolean }>;
  readonly restart: () => Promise<{ ok: boolean }>;
  /** Hub → Codex in-place backend reload; null when the Codex side does not answer. */
  readonly requestReload: (timeoutMs: number) => Promise<BackendReloadStatus | null>;
  /** From the Codex heartbeat: true/false, or null when unknown. */
  readonly busy: () => Promise<boolean | null>;
  readonly reloadTimeoutMs?: number;
  readonly pollMs?: number;
  /** Give up waiting for an idle Codex after this long (the change still applies next start). */
  readonly maxWaitMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class Rly0CodexApplier {
  readonly #deps: Rly0CodexApplyDeps;
  #scheduled: { cancelled: boolean } | null = null;

  constructor(deps: Rly0CodexApplyDeps) {
    this.#deps = deps;
  }

  /** Whether a restart is waiting for Codex to finish its current work. */
  get pending(): boolean {
    return this.#scheduled !== null;
  }

  async apply(params: z.infer<typeof codexApplyParams>): Promise<{
    outcome: Rly0CodexApplyOutcome;
  }> {
    const running = (await this.#deps.status()).running;
    if (params.restartNow) {
      this.cancel();
      if (!running) return { outcome: "notRunning" };
      return { outcome: (await this.#deps.restart()).ok ? "restarting" : "failed" };
    }
    if (!running) return { outcome: "notRunning" };
    if (params.scope === "backend") {
      const reload = await this.#deps
        .requestReload(this.#deps.reloadTimeoutMs ?? 15_000)
        .catch(() => null);
      if (reload === "reloaded" || reload === "deferred") return { outcome: reload };
    }
    const busy = await this.#deps.busy().catch(() => null);
    if (busy === null) return { outcome: "needsRestart" };
    if (busy) {
      this.#schedule();
      return { outcome: "scheduled" };
    }
    this.cancel();
    return { outcome: (await this.#deps.restart()).ok ? "restarting" : "failed" };
  }

  cancel(): { ok: true } {
    if (this.#scheduled) this.#scheduled.cancelled = true;
    this.#scheduled = null;
    return { ok: true };
  }

  /** One waiting restart at most; a newer change reuses it. */
  #schedule(): void {
    if (this.#scheduled) return;
    const ticket = { cancelled: false };
    this.#scheduled = ticket;
    void this.#waitThenRestart(ticket).finally(() => {
      if (this.#scheduled === ticket) this.#scheduled = null;
    });
  }

  async #waitThenRestart(ticket: { cancelled: boolean }): Promise<void> {
    const now = this.#deps.now ?? Date.now;
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + (this.#deps.maxWaitMs ?? 30 * 60_000);
    while (!ticket.cancelled && now() < deadline) {
      await sleep(this.#deps.pollMs ?? 2_000);
      if (ticket.cancelled) return;
      const running = await this.#deps
        .status()
        .then((s) => s.running)
        .catch(() => false);
      // Closed by the person meanwhile: the next start reads the settings anyway.
      if (!running) return;
      const busy = await this.#deps.busy().catch(() => null);
      if (busy === false) {
        await this.#deps.restart().catch(() => undefined);
        return;
      }
      // Lost sight of the heartbeat: never restart blindly.
      if (busy === null) return;
    }
  }
}
