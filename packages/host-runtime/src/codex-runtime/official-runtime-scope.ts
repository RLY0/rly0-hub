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

/** Process ownership shared by all AppServerHost clients in one Host deployment. */
export class OfficialRuntimeScope {
  readonly owner: OfficialRuntimeOwner;
  readonly gate: OfficialWorkGate;
  readonly permanentHome: string;
  readonly #failure = Promise.withResolvers<Error>();
  #starting: Promise<void> | undefined;
  #started = false;
  #closed = false;
  #restarting: Promise<void> | undefined;
  #restartActive = false;

  constructor(input: Omit<OfficialRuntimeOwnerOptions, "gate"> & { permanentHome: string }) {
    this.permanentHome = input.permanentHome;
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
        this.#failure.resolve(new Error("Official Codex is unavailable"));
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
    if (this.#started) return Promise.resolve();
    if (this.owner.running) {
      this.#started = true;
      return Promise.resolve();
    }
    if (this.#starting) return this.#starting;
    const starting = this.owner.start().then(() => {
      if (this.#closed) throw new OfficialAdmissionError("unavailable");
      this.#started = true;
      this.gate.initialized();
    });
    this.#starting = starting;
    void starting.then(
      () => {
        this.#starting = undefined;
      },
      () => {
        this.#starting = undefined;
      },
    );
    return starting;
  }

  attach(output: CodexRuntimeOutput, onBackendStopped?: () => void): OfficialClientSession {
    return this.owner.attach(output, onBackendStopped);
  }
  failure(): Promise<Error> {
    return this.#failure.promise;
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
    this.#restartActive = true;
    const restarting = (async () => {
      await this.#starting?.catch(() => undefined);
      await this.owner.stop();
      if (this.#closed) throw new OfficialAdmissionError("unavailable");
      await this.owner.start();
      if (this.#closed) throw new OfficialAdmissionError("unavailable");
      this.#started = true;
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
    if (this.#started && this.gate.phase === "unavailable")
      this.#failure.resolve(new Error("Official Codex is unavailable"));
  }

  async close(): Promise<void> {
    this.#closed = true;
    // A failed close still owns a possibly live backend; allow stop retries.
    await this.owner.stop();
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
  failure(): Promise<Error> {
    return this.#scope.failure();
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
