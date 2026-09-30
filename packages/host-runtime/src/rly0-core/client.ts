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
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type Rly0CoreResponse<T> = { available: true; result: T } | { available: false };

const DEFAULT_TIMEOUT_MS = 10_000;

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
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  #disposed = false;

  constructor(options: Rly0CoreClientOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#spawnImpl = options.spawn ?? spawn;
    this.#explicitBinaryPath = options.binaryPath;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      entry.reject(error);
    }
  }

  #ensureChild(): ChildProcessWithoutNullStreams | null {
    if (this.#disposed) return null;
    if (this.#child) return this.#child;
    const binary = this.#resolveBinary();
    if (!binary) return null;
    const environment: NodeJS.ProcessEnv = { ...this.#environment };
    if (this.#environment.CODEX_HOME) environment.CODEX_HOME = this.#environment.CODEX_HOME;
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
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    // rly0-core's stderr may carry diagnostics but must never be logged: it could echo back
    // fragments of request params. Drain it so the pipe never backs up.
    child.stderr.on("data", () => undefined);
    const onExit = (): void => {
      if (this.#child === child) this.#child = null;
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
  async request<T>(method: string, params: unknown): Promise<Rly0CoreResponse<T>> {
    const child = this.#ensureChild();
    if (!child) return { available: false };
    const id = this.#nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<Rly0CoreResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("RLY0_CORE_TIMEOUT"));
      }, this.#timeoutMs);
      this.#pending.set(id, {
        resolve: (result) => resolve({ available: true, result: result as T }),
        reject,
        timer,
      });
      child.stdin.write(payload, (error) => {
        if (!error) return;
        if (this.#pending.delete(id)) clearTimeout(timer);
        reject(error);
      });
    });
  }

  /** Kills the child (if any) and rejects every in-flight request. Safe to call more than once. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const child = this.#child;
    this.#child = null;
    this.#failAllPending(new Error("RLY0_CORE_DISPOSED"));
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
}
