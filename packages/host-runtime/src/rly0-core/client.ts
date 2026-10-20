import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locates the closed-source `rly0-core` binary. Discovery order: an explicit `RLY0_CORE_PATH`
 * environment override, then a binary next to the running Node/Electron executable, then a
 * binary sitting next to this package's own root (the layout used by local dev and packaging).
 * Returns `null` when none of the candidates exist so callers can degrade gracefully instead of
 * crashing.
 */
export function resolveRly0CoreBinaryPath(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const names = process.platform === "win32" ? ["rly0-core.exe"] : ["rly0-core"];
  const candidates: string[] = [];
  const envPath = environment.RLY0_CORE_PATH?.trim();
  if (envPath) candidates.push(envPath);
  const execDir = path.dirname(process.execPath);
  for (const name of names) candidates.push(path.join(execDir, name));
  // packages/host-runtime/{src,dist}/rly0-core/client.{ts,js} -> packages/host-runtime
  const packageRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  for (const name of names) candidates.push(path.join(packageRoot, name));
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export interface Rly0CoreClientOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: typeof spawn;
  /** Test-only escape hatch: force a specific binary path (or force "not found" with null). */
  readonly binaryPath?: string | null;
  readonly timeoutMs?: number;
  /** Keep disk-only account/relay metadata independent of slow network requests. */
  readonly separateLocalReads?: boolean;
  /**
   * Called each time the child is spawned to derive its environment (e.g. to apply the user's
   * outbound proxy choice). Receives a copy of the base environment.
   */
  readonly prepareEnvironment?: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

export interface Rly0CoreRequestOptions {
  /** Overrides the client-wide timeout for this request only (e.g. slow usage lookups). */
  readonly timeoutMs?: number;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly complete: () => void;
}

export type Rly0CoreResponse<T> = { available: true; result: T } | { available: false };

const DEFAULT_TIMEOUT_MS = 10_000;

const LOCAL_READS = new Set([
  "accounts/list",
  "accounts/current",
  "claude/list",
  "grok/list",
  "relay/list",
]);
const NETWORK_READS = new Set([
  "core/hello",
  "filters/get",
  "proxy/status",
  "accounts/usage",
  "accounts/usageAll",
  "accounts/usageCurrent",
  "claude/usage",
  "claude/usageAll",
  "claude/keyInfo",
  "grok/usage",
  "grok/usageAll",
  "relay/test",
  "relay/balance",
]);

/**
 * Correlates newline-delimited JSON-RPC 2.0 requests with a lazily-spawned `rly0-core` child
 * process. The child is only started on the first request; if the binary cannot be found,
 * `request()` resolves to `{ available: false }` rather than throwing. A crashed or exited child
 * is not proactively restarted, but the next `request()` call transparently respawns it.
 */
export class Rly0CoreClient {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #spawnImpl: typeof spawn;
  readonly #explicitBinaryPath: string | null | undefined;
  readonly #timeoutMs: number;
  readonly #prepareEnvironment: ((environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv) | undefined;
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  #disposed = false;
  #generation = 0;
  readonly #localReader: Rly0CoreClient | null;
  readonly #mutations = new Set<Promise<void>>();

  constructor(options: Rly0CoreClientOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#spawnImpl = options.spawn ?? spawn;
    this.#explicitBinaryPath = options.binaryPath;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#prepareEnvironment = options.prepareEnvironment;
    this.#localReader = options.separateLocalReads
      ? new Rly0CoreClient({ ...options, separateLocalReads: false })
      : null;
  }

  #resolveBinary(): string | null {
    if (this.#explicitBinaryPath !== undefined) return this.#explicitBinaryPath;
    return resolveRly0CoreBinaryPath(this.#environment);
  }

  #failAllPending(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.complete();
      entry.reject(error);
    }
  }

  #ensureChild(): ChildProcessWithoutNullStreams | null {
    if (this.#disposed) return null;
    if (this.#child) return this.#child;
    const binary = this.#resolveBinary();
    if (!binary) return null;
    let environment: NodeJS.ProcessEnv = { ...this.#environment };
    if (this.#environment.CODEX_HOME) environment.CODEX_HOME = this.#environment.CODEX_HOME;
    if (this.#prepareEnvironment) environment = this.#prepareEnvironment(environment);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawnImpl(binary, [], {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch {
      return null;
    }
    this.#child = child;
    this.#buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.#child === child) this.#onStdout(chunk);
    });
    // rly0-core's stderr may carry diagnostics but must never be logged: it could echo back
    // fragments of request params. Drain it so the pipe never backs up.
    child.stderr.on("data", () => undefined);
    const onExit = (): void => {
      // A child replaced by restart()/dispose() already failed its own requests; its late exit
      // must not reject requests addressed to the replacement child.
      if (this.#child !== child) return;
      this.#child = null;
      this.#failAllPending(new Error("RLY0_CORE_EXITED"));
    };
    child.once("exit", onExit);
    child.once("error", onExit);
    return child;
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf("\n");
      if (!line) continue;
      this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || !("id" in message)) return;
    const id = (message as { id: unknown }).id;
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.complete();
    const record = message as { result?: unknown; error?: { code: number; message: string } };
    if (record.error) {
      pending.reject(Object.assign(new Error(record.error.message), { code: record.error.code }));
    } else {
      pending.resolve(record.result);
    }
  }

  /**
   * Sends one JSON-RPC request. Resolves `{ available: false }` when `rly0-core` cannot be
   * found or spawned at all. Once a process is running, a business error from the core (for
   * example `CODEX_NOT_LOGGED_IN`) rejects the returned promise instead, so callers can surface
   * the specific error code rather than a generic "unavailable" state.
   */
  async request<T>(
    method: string,
    params: unknown,
    options: Rly0CoreRequestOptions = {},
  ): Promise<Rly0CoreResponse<T>> {
    if (this.#localReader && LOCAL_READS.has(method)) {
      const generation = this.#generation;
      // A read issued after a save/switch/remove must observe that operation's completion.
      // Network quota requests may update their atomic cache in the meantime; lists report
      // whichever completed snapshot is available, including its original fetchedAt.
      const deadline = Date.now() + (options.timeoutMs ?? this.#timeoutMs);
      while (this.#mutations.size) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all(this.#mutations),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("RLY0_CORE_BUSY")),
                Math.max(1, deadline - Date.now()),
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      if (generation !== this.#generation)
        throw new Error(this.#disposed ? "RLY0_CORE_DISPOSED" : "RLY0_CORE_RESTARTED");
      return this.#localReader.request<T>(method, params, options);
    }
    return this.#request<T>(method, params, options);
  }

  async #request<T>(
    method: string,
    params: unknown,
    options: Rly0CoreRequestOptions,
  ): Promise<Rly0CoreResponse<T>> {
    const child = this.#ensureChild();
    if (!child) return { available: false };
    const id = this.#nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    const mutation =
      Boolean(this.#localReader) && !NETWORK_READS.has(method) && !LOCAL_READS.has(method);
    let complete = () => {};
    if (mutation) {
      let settle = () => {};
      const finished = new Promise<void>((resolve) => {
        settle = resolve;
      });
      this.#mutations.add(finished);
      complete = () => {
        this.#mutations.delete(finished);
        settle();
      };
    }
    return new Promise<Rly0CoreResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Timing out the caller does not cancel a queued mutation. Keep its ordering fence
        // until the wire reply or process exit confirms the actual operation has finished.
        if (!mutation) this.#pending.delete(id);
        reject(new Error("RLY0_CORE_TIMEOUT"));
      }, options.timeoutMs ?? this.#timeoutMs);
      this.#pending.set(id, {
        resolve: (result) => resolve({ available: true, result: result as T }),
        reject,
        timer,
        complete,
      });
      child.stdin.write(payload, (error) => {
        if (!error) return;
        if (this.#pending.delete(id)) clearTimeout(timer);
        complete();
        reject(error);
      });
    });
  }

  /** Whether a child process is currently spawned (not whether the binary exists). */
  get isRunning(): boolean {
    return this.#child !== null;
  }

  /**
   * Stops the running child (if any) without disposing the client; the next request respawns it
   * with a freshly prepared environment. In-flight requests reject with `RLY0_CORE_RESTARTED`.
   * Returns whether a child was running.
   */
  restart(): boolean {
    ++this.#generation;
    const localRunning = this.#localReader?.restart() ?? false;
    const child = this.#child;
    this.#child = null;
    this.#failAllPending(new Error("RLY0_CORE_RESTARTED"));
    if (!child) return localRunning;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return true;
  }

  /** Kills the child (if any) and rejects every in-flight request. Safe to call more than once. */
  async dispose(): Promise<void> {
    ++this.#generation;
    this.#disposed = true;
    await this.#localReader?.dispose();
    const child = this.#child;
    this.#child = null;
    this.#failAllPending(new Error("RLY0_CORE_DISPOSED"));
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
}
