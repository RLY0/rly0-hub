import type { Writable } from "node:stream";

import { parseJsonFrame, type JsonObject } from "@codexhost/protocol-core";

import type { OfficialAppServerConnection } from "../official-app-server-connection.js";
import type { CodexRuntimeOutput } from "./codex-runtime.js";
import {
  OfficialRuntimeOwner,
  type OfficialClientSession,
  type OwnedOfficialBackend,
  type OfficialRuntimeOwnerOptions,
} from "./official-runtime-owner.js";
import { OfficialAdmissionError, OfficialWorkGate } from "./official-work-gate.js";

/** Automatic replacement of a failed official generation for long-lived Host deployments. */
export interface OfficialRuntimeRecoveryOptions {
  /** Backoff before each consecutive restart attempt; the last delay repeats. */
  delaysMs?: readonly number[];
  /** A generation that stayed ready this long resets the backoff. */
  stableMs?: number;
}

const DEFAULT_RECOVERY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const DEFAULT_RECOVERY_STABLE_MS = 60_000;

/**
 * How long Host startup waits for the official backend before continuing without it. Desktop's
 * initialize handshake waits on Host startup, so this stays close to the previous 10s readiness
 * limit while the start itself may take longer in the background.
 */
export const OFFICIAL_START_GRACE_MS = 8_000;

export type OfficialStartOutcome =
  { status: "ready" } | { status: "starting" } | { status: "failed"; error: unknown };

/** Waits at most `graceMs` for `starting`; never rejects and never cancels the start. */
export async function officialStartWithin(
  starting: Promise<void>,
  graceMs: number,
): Promise<OfficialStartOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<OfficialStartOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "starting" }), graceMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      starting.then(
        (): OfficialStartOutcome => ({ status: "ready" }),
        (error: unknown): OfficialStartOutcome => ({ status: "failed", error }),
      ),
      pending,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The startup failure chain without stack traces; never includes native stderr. */
export function officialStartFailureMessage(error: unknown): string {
  const messages: string[] = [];
  for (let cause = error; cause instanceof Error && messages.length < 4; cause = cause.cause) {
    if (!messages.includes(cause.message)) messages.push(cause.message);
  }
  return messages.length > 0 ? messages.join(": ") : String(error);
}

/** Process ownership shared by all AppServerHost clients in one Host deployment. */
export class OfficialRuntimeScope {
  readonly owner: OfficialRuntimeOwner;
  readonly gate: OfficialWorkGate;
  readonly permanentHome: string;
  readonly #diagnosticOutput: Writable;
  readonly #recovery: { delaysMs: readonly number[]; stableMs: number } | undefined;
  #starting: Promise<void> | undefined;
  #started = false;
  #closed = false;
  #restarting: Promise<void> | undefined;
  #restartActive = false;
  #readyAt = 0;
  #recoveryAttempt = 0;
  #recoveryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    input: Omit<OfficialRuntimeOwnerOptions, "gate"> & {
      permanentHome: string;
      /** Only long-lived deployments opt in; others keep one generation per Scope start. */
      recovery?: OfficialRuntimeRecoveryOptions;
    },
  ) {
    this.permanentHome = input.permanentHome;
    this.#diagnosticOutput = input.diagnosticOutput;
    const delaysMs = input.recovery?.delaysMs ?? DEFAULT_RECOVERY_DELAYS_MS;
    if (input.recovery && delaysMs.length === 0)
      throw new Error("Official runtime recovery requires at least one delay");
    this.#recovery = input.recovery
      ? { delaysMs, stableMs: input.recovery.stableMs ?? DEFAULT_RECOVERY_STABLE_MS }
      : undefined;
    this.gate = new OfficialWorkGate();
    this.owner = new OfficialRuntimeOwner({
      createBackend: () => {
        if (this.#closed) throw new OfficialAdmissionError("unavailable");
        return input.createBackend();
      },
      diagnosticOutput: input.diagnosticOutput,
      gate: this.gate,
    });
    this.gate.subscribe(() => {
      if (this.#started && !this.#restartActive && this.gate.phase === "unavailable")
        this.#generationFailed();
    });
  }

  get restarting(): boolean {
    return this.#restartActive;
  }

  get closed(): boolean {
    return this.#closed;
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Official Codex is unavailable"));
    if (this.#restarting) return this.#restarting;
    if (this.#starting) return this.#starting;
    if (this.#started && (!this.#recovery || this.owner.running)) return Promise.resolve();
    if (!this.#started && this.owner.running) {
      this.#started = true;
      return Promise.resolve();
    }
    // A caller that needs Codex now (for example a reconnecting Desktop) skips
    // the remaining backoff; the attempt itself still proves the old exit first.
    this.#clearRecoveryTimer();
    const starting = (async () => {
      if (this.#recovery) await this.owner.stop();
      await this.owner.start();
      if (this.#closed) throw new OfficialAdmissionError("unavailable");
      this.#started = true;
      this.#readyAt = Date.now();
      this.gate.initialized();
    })();
    this.#starting = starting;
    void starting.then(
      () => {
        if (this.#starting === starting) this.#starting = undefined;
        // The generation may already have failed while this start was settling.
        if (this.gate.phase === "unavailable") this.#scheduleRecovery();
      },
      () => {
        if (this.#starting === starting) this.#starting = undefined;
        // Prove the failed generation's exit now rather than at the next attempt.
        if (!this.#closed) void this.owner.stop().catch(() => undefined);
        this.#scheduleRecovery();
      },
    );
    return starting;
  }

  /**
   * Starts the official backend without making its failure fatal to the caller. Waits at most
   * `graceMs`; a slower start keeps running in the background, and a failed one is retried by
   * the recovery policy (when configured). External Harnesses and relay models do not depend on
   * the official backend, so Host startup continues in every case.
   */
  async startWithin(graceMs: number): Promise<OfficialStartOutcome> {
    const startedAt = Date.now();
    const starting = this.start();
    const outcome = await officialStartWithin(starting, graceMs);
    const write = (message: string): void => {
      this.#diagnosticOutput.write(`codexhost: ${message}\n`);
    };
    const continuing = "other Agents and relay models stay available";
    if (outcome.status === "starting") {
      write(
        `official Codex is still starting after ${String(graceMs)}ms; ${continuing} while it finishes in the background`,
      );
      void starting.then(
        () => write(`official Codex became ready after ${String(Date.now() - startedAt)}ms`),
        (error: unknown) =>
          write(`official Codex failed to start: ${officialStartFailureMessage(error)}`),
      );
    } else if (outcome.status === "failed") {
      write(
        `official Codex failed to start: ${officialStartFailureMessage(outcome.error)}; ${continuing}${this.#recovery ? " and it is retried in the background" : ""}`,
      );
    }
    return outcome;
  }

  attach(output: CodexRuntimeOutput, onBackendStopped?: () => void): OfficialClientSession {
    return this.owner.attach(output, onBackendStopped);
  }

  /**
   * Replaces the official app-server process in place so a freshly switched account
   * (`auth.json`) or relay provider (`config.toml`) takes effect without restarting the
   * Desktop window. Attached clients keep their connection; the owner re-initializes them
   * and lazily resumes remembered threads. Rejects with `busy` while official work is active.
   */
  restartBackend(): Promise<void> {
    if (this.#closed) return Promise.reject(new OfficialAdmissionError("unavailable"));
    if (this.#restarting) return this.#restarting;
    if (this.gate.busy) return Promise.reject(new OfficialAdmissionError("busy"));
    // Must be set before owner.stop() synchronously marks the gate unavailable.
    this.#clearRecoveryTimer();
    this.#restartActive = true;
    const restarting = (async () => {
      await this.#starting?.catch(() => undefined);
      await this.owner.stop();
      if (this.#closed) throw new OfficialAdmissionError("unavailable");
      await this.owner.start();
      if (this.#closed) throw new OfficialAdmissionError("unavailable");
      this.#started = true;
      this.#readyAt = Date.now();
      this.gate.initialized();
    })();
    this.#restarting = restarting;
    void restarting.then(
      () => this.#finishRestart(),
      () => this.#finishRestart(),
    );
    return restarting;
  }

  #finishRestart(): void {
    this.#restartActive = false;
    this.#restarting = undefined;
    if (this.#started && this.gate.phase === "unavailable") this.#generationFailed();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#clearRecoveryTimer();
    // A failed close still owns a possibly live backend; allow stop retries.
    await this.owner.stop();
  }

  /** One ready generation became unavailable. The Scope, not each client, owns the response. */
  #generationFailed(): void {
    // Prove exit without closing the Scope or detaching clients: a transport
    // failure can leave the process alive, and a replacement needs it gone.
    // Deferred because the owner publishes unavailable from inside stop()
    // before that stop becomes joinable.
    queueMicrotask(() => {
      if (!this.#closed && this.gate.phase === "unavailable")
        void this.owner.stop().catch(() => undefined);
    });
    if (!this.#recovery || this.#closed) return;
    if (Date.now() - this.#readyAt >= this.#recovery.stableMs) this.#recoveryAttempt = 0;
    this.#scheduleRecovery();
  }

  #scheduleRecovery(): void {
    if (
      !this.#recovery ||
      this.#closed ||
      this.#restartActive ||
      this.#recoveryTimer ||
      this.#starting
    )
      return;
    const { delaysMs } = this.#recovery;
    const delay = delaysMs[Math.min(this.#recoveryAttempt, delaysMs.length - 1)] ?? 0;
    this.#recoveryAttempt++;
    this.#diagnosticOutput.write(
      `codexhost: official Codex is unavailable; restarting in ${String(delay)}ms\n`,
    );
    const timer = setTimeout(() => {
      this.#recoveryTimer = undefined;
      // Failure schedules the next attempt through start().
      this.start().catch(() => undefined);
    }, delay);
    timer.unref();
    this.#recoveryTimer = timer;
  }

  #clearRecoveryTimer(): void {
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
  }
}

/** Per-Desktop client facade. Account count never changes process count or Thread routing. */
export class OfficialRuntimeClient {
  readonly #scope: OfficialRuntimeScope;
  readonly #session: OfficialClientSession;
  #closed = false;

  constructor(input: {
    scope: OfficialRuntimeScope;
    output: CodexRuntimeOutput;
    onBackendStopped?: () => void;
  }) {
    this.#scope = input.scope;
    this.#session = input.scope.attach(input.output, input.onBackendStopped);
  }

  initialize(): Promise<void> {
    return this.#scope.start();
  }
  async initializeProtocol(params: JsonObject): Promise<JsonObject> {
    if (this.#closed || this.#scope.closed) throw new OfficialAdmissionError("unavailable");
    // Desktop initializes the Host transport, not backend readiness. Retain its
    // native negotiation while backend admission is unavailable.
    this.#session.configure(params);
    if (this.#scope.gate.phase === "ready") {
      try {
        return await this.#session.initialize(params);
      } catch (error) {
        if (this.#closed || this.#scope.closed || this.#scope.gate.phase === "ready") throw error;
      }
    }
    // These are Host-owned transport facts (InitializeResponse), not a fabricated
    // native capability or authentication result. Native requests remain gated.
    return {
      result: {
        userAgent: "codexhost",
        codexHome: this.#scope.permanentHome,
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs:
          process.platform === "darwin"
            ? "macos"
            : process.platform === "win32"
              ? "windows"
              : process.platform,
      },
    };
  }
  request(method: string, params: JsonObject): Promise<JsonObject> {
    return this.#session.request(method, params);
  }
  send(value: JsonObject): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Official Codex is unavailable"));
    return this.#session.send(value);
  }
  async sendFrame(frame: Buffer<ArrayBufferLike>): Promise<void> {
    if (this.#closed) throw new Error("Official Codex is unavailable");
    const value = parseJsonFrame(frame);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Official protocol frame must be an object");
    await this.#session.send(value);
  }
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#session.close();
    }
    return Promise.resolve();
  }
}

export function createOwnedConnectionBackend(
  factory: () => OfficialAppServerConnection | Promise<OfficialAppServerConnection>,
): OwnedOfficialBackend {
  const closed = Promise.withResolvers<Awaited<OfficialAppServerConnection["closed"]>>();
  let connection: OfficialAppServerConnection | undefined;
  let claimed = false;
  return {
    get processId() {
      return connection?.processId;
    },
    closed: closed.promise,
    async start() {
      connection = await factory();
      void connection.closed.then(closed.resolve);
    },
    async connect() {
      if (!connection || claimed) throw new Error("Official connection is unavailable");
      claimed = true;
      return connection;
    },
    async stop() {
      if (!connection) {
        closed.resolve({ code: 0, signal: null });
        return;
      }
      if (connection.stopProcess) await connection.stopProcess();
      else {
        connection.close();
        await connection.closed;
      }
    },
  };
}
