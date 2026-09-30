import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import type {
  Rly0AccountsAddLoginCancelResult,
  Rly0AccountsAddLoginStartResult,
  Rly0AccountsAddLoginStatusResult,
  Rly0AccountsImportCurrentResult,
} from "@codexhost/shared-contracts";

import type { OfficialAppServerConnection } from "../official-app-server-connection.js";

/** What an add-account login needs from the rest of the Host. */
export interface Rly0AddAccountLoginDeps {
  /** Spawns a private official app-server whose `CODEX_HOME` is `codexHome`. */
  spawnOfficial(codexHome: string): OfficialAppServerConnection;
  /** rly0-core `accounts/importFrom`: saves the login found in `codexHome`. */
  importFrom(params: {
    codexHome: string;
    alias?: string;
  }): Promise<Rly0AccountsImportCurrentResult>;
  /** Whether rly0-core is present at all. */
  coreAvailable(): Promise<boolean>;
  tempRoot?: string;
  requestTimeoutMs?: number;
  loginTimeoutMs?: number;
}

type LoginState =
  | { state: "pending" }
  | { state: "completed"; id: string }
  | { state: "failed"; error: string }
  | { state: "cancelled" };

interface ActiveLogin {
  readonly loginId: string;
  readonly nativeLoginId: string;
  readonly home: string;
  readonly connection: OfficialAppServerConnection;
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  result: LoginState;
  cleanup: Promise<void> | null;
  timer: NodeJS.Timeout | null;
}

const REQUEST_TIMEOUT_MS = 20_000;
/** The official login page stays valid for a while; give the user time to finish it. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const FINISHED_KEPT = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(message) ? message : fallback;
}

/**
 * "Add account" for the saved-account list: runs the official ChatGPT browser login inside a
 * throw-away `CODEX_HOME`, so the user's live Codex login is never touched. When the official
 * app-server reports success, rly0-core copies the new login into its store and the temporary
 * directory is deleted. Tokens never pass through this class: they stay inside the temporary
 * directory until rly0-core reads them.
 */
export class Rly0AddAccountLogins {
  readonly #deps: Rly0AddAccountLoginDeps;
  #active: ActiveLogin | null = null;
  readonly #finished = new Map<string, LoginState>();
  /** Keyed by the official login id; resolved by `account/login/completed`. */
  readonly #pendingCompletion = new Map<string, (success: boolean) => void>();

  constructor(deps: Rly0AddAccountLoginDeps) {
    this.#deps = deps;
  }

  async start(params: { alias?: string | undefined }): Promise<Rly0AccountsAddLoginStartResult> {
    if (!(await this.#deps.coreAvailable())) return { available: false };
    // The official login callback listens on one fixed local port, so only one login at a time.
    if (this.#active) await this.#finish(this.#active, { state: "cancelled" }, true);

    const root = await realpath(this.#deps.tempRoot ?? tmpdir());
    const home = await mkdtemp(path.join(root, "rly0-login-"));
    let connection: OfficialAppServerConnection | null = null;
    try {
      connection = this.#deps.spawnOfficial(home);
      // Official stderr may carry credential-bearing errors; drain it without keeping it.
      connection.stderr.resume();
      const request = this.#client(connection);
      await request("initialize", {
        clientInfo: { name: "rly0_add_account", version: "1" },
        capabilities: { experimentalApi: true },
      });
      connection.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const started = await request("account/login/start", { type: "chatgpt" });
      if (
        !isRecord(started) ||
        typeof started.loginId !== "string" ||
        typeof started.authUrl !== "string" ||
        !/^https:\/\//u.test(started.authUrl)
      ) {
        throw new Error("LOGIN_START_FAILED");
      }
      const loginId = randomBytes(8).toString("hex");
      const active: ActiveLogin = {
        loginId,
        nativeLoginId: started.loginId,
        home,
        connection,
        request,
        result: { state: "pending" },
        cleanup: null,
        timer: null,
      };
      this.#active = active;
      active.timer = setTimeout(() => {
        void this.#finish(active, { state: "failed", error: "LOGIN_TIMEOUT" }, true);
      }, this.#deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
      active.timer.unref?.();
      void connection.closed.then(() => {
        if (active.result.state === "pending") {
          void this.#finish(active, { state: "failed", error: "LOGIN_PROCESS_EXITED" }, false);
        }
      });
      this.#pendingCompletion.set(started.loginId, (success) => {
        if (active.result.state !== "pending") return;
        if (!success) {
          void this.#finish(active, { state: "failed", error: "LOGIN_FAILED" }, false);
          return;
        }
        void this.#import(active, params.alias);
      });
      return { available: true, loginId, authUrl: started.authUrl };
    } catch (error) {
      connection?.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
      throw Object.assign(new Error(errorCode(error, "LOGIN_START_FAILED")), { code: -32000 });
    }
  }

  status(params: { loginId: string }): Rly0AccountsAddLoginStatusResult {
    const active = this.#active;
    const state =
      active && active.loginId === params.loginId
        ? active.result
        : (this.#finished.get(params.loginId) ?? { state: "failed", error: "LOGIN_UNKNOWN" });
    return { available: true, ...state };
  }

  async cancel(params: { loginId: string }): Promise<Rly0AccountsAddLoginCancelResult> {
    const active = this.#active;
    if (!active || active.loginId !== params.loginId || active.result.state !== "pending") {
      return { available: true, cancelled: false };
    }
    await this.#finish(active, { state: "cancelled" }, true);
    return { available: true, cancelled: true };
  }

  /** Stops any login in progress (Host shutdown). */
  async close(): Promise<void> {
    if (this.#active) await this.#finish(this.#active, { state: "cancelled" }, true);
  }

  async #import(active: ActiveLogin, alias: string | undefined): Promise<void> {
    try {
      const imported = await this.#deps.importFrom({
        codexHome: active.home,
        ...(alias ? { alias } : {}),
      });
      await this.#finish(
        active,
        imported.available
          ? { state: "completed", id: imported.id }
          : { state: "failed", error: "RLY0_CORE_UNAVAILABLE" },
        false,
      );
    } catch (error) {
      await this.#finish(
        active,
        { state: "failed", error: errorCode(error, "IMPORT_FAILED") },
        false,
      );
    }
  }

  async #finish(active: ActiveLogin, result: LoginState, cancelNative: boolean): Promise<void> {
    if (active.cleanup) return active.cleanup;
    active.result = result;
    if (active.timer) clearTimeout(active.timer);
    this.#pendingCompletion.delete(active.nativeLoginId);
    active.cleanup = (async () => {
      if (cancelNative) {
        await Promise.race([
          active.request("account/login/cancel", { loginId: active.nativeLoginId }).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 2_000).unref?.()),
        ]);
      }
      active.connection.close();
      await Promise.race([
        active.connection.closed,
        new Promise((resolve) => setTimeout(resolve, 5_000).unref?.()),
      ]);
      // The process may still hold files for a moment on Windows; retry the delete briefly.
      await rm(active.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    })();
    if (this.#active === active) this.#active = null;
    this.#finished.set(active.loginId, result);
    while (this.#finished.size > FINISHED_KEPT) {
      const oldest = this.#finished.keys().next().value;
      if (oldest === undefined) break;
      this.#finished.delete(oldest);
    }
    return active.cleanup;
  }

  /** A minimal LF-delimited JSON-RPC client over one private official connection. */
  #client(
    connection: OfficialAppServerConnection,
  ): (method: string, params: unknown) => Promise<unknown> {
    let nextId = 1;
    const waiting = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    const lines = createInterface({ input: connection.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (typeof message.id === "number" && !("method" in message)) {
        const pending = waiting.get(message.id);
        if (!pending) return;
        waiting.delete(message.id);
        if ("error" in message) pending.reject(new Error("OFFICIAL_REQUEST_FAILED"));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === "account/login/completed" && isRecord(message.params)) {
        const nativeId = message.params.loginId;
        const done =
          typeof nativeId === "string"
            ? this.#pendingCompletion.get(nativeId)
            : this.#pendingCompletion.size === 1
              ? [...this.#pendingCompletion.values()][0]
              : undefined;
        done?.(message.params.success === true);
      }
    });
    void connection.closed.then(() => {
      for (const pending of waiting.values()) pending.reject(new Error("LOGIN_PROCESS_EXITED"));
      waiting.clear();
      lines.close();
    });
    return (method, params) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error("OFFICIAL_REQUEST_TIMEOUT"));
        }, this.#deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
        timer.unref?.();
        waiting.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        connection.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (!error) return;
          waiting.delete(id);
          clearTimeout(timer);
          reject(new Error("LOGIN_PROCESS_EXITED"));
        });
      });
  }
}
