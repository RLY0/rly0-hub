import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * The official `claude auth login --claudeai` driven from the Hub window: Claude Code prints its
 * authorization link, the person signs in in the browser, and the one-time code (when the page
 * shows one) goes to the CLI's stdin. Claude Code exchanges and stores the credentials itself.
 * Shared by the isolated microVM login (`isolation-login.ts`) and "add another Claude account"
 * on this computer (`claude-add-login.ts`), which differ only in where the CLI runs and what
 * happens once it succeeds.
 */
export type ClaudeWebLoginPhase =
  "idle" | "starting" | "waitingForCode" | "authorizing" | "succeeded" | "failed" | "cancelled";
export interface ClaudeWebLoginStatus {
  phase: ClaudeWebLoginPhase;
  id?: string;
  /** What this login is for (the isolated project, or the alias of the account to add). */
  scope?: string;
  error?: string;
  browserOpened?: boolean;
  /** What `confirm` returned on success (display fields only, never secrets). */
  result?: Record<string, unknown>;
}

export interface ClaudeWebLoginHooks<Context> {
  /** Error code prefix, e.g. `ISOLATION_LOGIN` → `ISOLATION_LOGIN_TIMEOUT`. */
  readonly errorPrefix: string;
  /** Resolves where the CLI runs; throwing fails with `_START_FAILED` (or the thrown code). */
  prepare(scope: string): Promise<Context>;
  spawn(context: Context): ChildProcessWithoutNullStreams;
  /** Checked right before a code is passed on; throwing refuses it (`_SUBMIT_FAILED`). */
  beforeSubmit?(context: Context): Promise<void>;
  /** After the CLI exited 0: whether the login really is there, and what to report. */
  confirm(context: Context): Promise<Record<string, unknown> | null>;
  /** Runs once whenever the flow ends, whatever the outcome. */
  cleanup?(context: Context): Promise<void>;
  /** Opens the official page (on request; and as soon as it is known unless `autoOpen` is false). */
  openUrl?(url: string): void;
  /** False when the CLI opens the browser itself, so the page is not opened twice. */
  autoOpen?: boolean;
  sameScope?(a: string, b: string): boolean;
  /** Whole-flow limit once the authorization link is shown (default 10 min). */
  timeoutMs?: number;
  /** Limit for preparing, starting the CLI and printing the link (default 3 min). */
  startTimeoutMs?: number;
}

interface Flow<Context> {
  status: ClaudeWebLoginStatus;
  context?: Context;
  child?: ChildProcessWithoutNullStreams;
  timer?: ReturnType<typeof setTimeout>;
  url?: string;
  state?: string;
  cleaned?: boolean;
}

/** A cold microVM boot plus proxy check and CLI start-up routinely takes well over a minute. */
const DEFAULT_START_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,80}$/u;

/** Accept only the official CLI's complete OAuth authorization link, never help/error URLs. */
export function claudeLoginUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      value.length > 8192 ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"].includes(
        url.hostname,
      ) ||
      !["/oauth/authorize", "/cai/oauth/authorize"].includes(url.pathname)
    )
      return null;
    const state = url.searchParams.get("state") ?? "";
    if (
      !/^[A-Za-z0-9_-]{8,512}$/u.test(state) ||
      !url.searchParams.get("client_id") ||
      !url.searchParams.get("code_challenge")
    )
      return null;
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    if (
      redirect.protocol !== "https:" ||
      !["platform.claude.com", "console.anthropic.com", "claude.ai"].includes(redirect.hostname) ||
      redirect.pathname !== "/oauth/code/callback" ||
      redirect.username ||
      redirect.password ||
      redirect.port
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

// Terminal hyperlinks (OSC 8) and colours, which a CLI may wrap around the link.
const HYPERLINK = /\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
const STYLE = /\u001b\[[0-9;?]*[A-Za-z]/gu;
function plainText(output: string): string {
  return output.replace(HYPERLINK, " ").replace(STYLE, "");
}

export class ClaudeWebLogin<Context> {
  #flow: Flow<Context> = { status: { phase: "idle" } };
  constructor(readonly hooks: ClaudeWebLoginHooks<Context>) {}

  get active(): boolean {
    return ["starting", "waitingForCode", "authorizing"].includes(this.#flow.status.phase);
  }
  status(): ClaudeWebLoginStatus {
    return { ...this.#flow.status };
  }
  get #autoOpen(): boolean {
    return this.hooks.autoOpen !== false && this.hooks.openUrl !== undefined;
  }
  #code(suffix: string): string {
    return `${this.hooks.errorPrefix}_${suffix}`;
  }

  async start(scope: string): Promise<ClaudeWebLoginStatus> {
    if (this.active) {
      const same = this.hooks.sameScope ?? ((a: string, b: string) => a === b);
      if (this.#flow.status.scope === undefined || !same(scope, this.#flow.status.scope))
        throw new Error(this.#code("BUSY"));
      return this.status();
    }
    const flow: Flow<Context> = { status: { phase: "starting", id: randomUUID(), scope } };
    this.#flow = flow;
    flow.timer = setTimeout(
      () => this.#stop(flow, "failed", this.#code("TIMEOUT")),
      this.hooks.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    );
    flow.timer.unref?.();
    try {
      const context = await this.hooks.prepare(scope);
      flow.context = context;
      if (this.#flow !== flow || !this.active) {
        void this.#cleanup(flow);
        return this.status();
      }
      const child = this.hooks.spawn(context);
      flow.child = child;
      let output = "";
      const scan = (chunk: Buffer | string) => {
        if (this.#flow !== flow || flow.status.phase !== "starting") return;
        output = (output + chunk.toString()).slice(-32 * 1024);
        for (const match of plainText(output).matchAll(/(https:\/\/[^\s"'<>]+)\s/gu)) {
          const url = claudeLoginUrl(match[1] ?? "");
          if (!url) continue;
          flow.url = url.href;
          flow.state = url.searchParams.get("state") ?? "";
          flow.status = {
            ...flow.status,
            phase: "waitingForCode",
            ...(this.#autoOpen ? { browserOpened: false } : {}),
          };
          clearTimeout(flow.timer);
          flow.timer = setTimeout(
            () => this.#stop(flow, "failed", this.#code("TIMEOUT")),
            this.hooks.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          );
          flow.timer.unref?.();
          output = "";
          if (this.#autoOpen) this.#open(flow);
          break;
        }
      };
      child.stdout.on("data", scan);
      child.stderr.on("data", scan);
      child.stdin.on("error", () => this.#stop(flow, "failed", this.#code("FAILED")));
      child.once("error", () => this.#stop(flow, "failed", this.#code("START_FAILED")));
      child.once("close", (code) => {
        void this.#complete(flow, code);
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      this.#stop(flow, "failed", CODE_PATTERN.test(code) ? code : this.#code("START_FAILED"));
    }
    return this.status();
  }

  #open(flow: Flow<Context>): void {
    if (!flow.url) return;
    try {
      (
        this.hooks.openUrl ??
        (() => {
          throw new Error("BROWSER_UNAVAILABLE");
        })
      )(flow.url);
      flow.status.browserOpened = true;
    } catch {
      flow.status.browserOpened = false;
    }
  }
  reopen(id: string): ClaudeWebLoginStatus {
    const flow = this.#current(id);
    if (flow.status.phase !== "waitingForCode") throw new Error(this.#code("NOT_WAITING"));
    this.#open(flow);
    return this.status();
  }

  async submit(id: string, code: string): Promise<ClaudeWebLoginStatus> {
    const flow = this.#current(id);
    if (flow.status.phase !== "waitingForCode" || flow.context === undefined || !flow.child)
      throw new Error(this.#code("NOT_WAITING"));
    if (!code || code.length > 4096 || /\s/u.test(code))
      throw new Error(this.#code("CODE_INVALID"));
    // The CLI expects `code#state`; the page shows exactly that.
    const separator = code.indexOf("#");
    if (separator < 0) throw new Error(this.#code("CODE_INVALID"));
    if (code.slice(separator + 1) !== flow.state) throw new Error(this.#code("CODE_MISMATCH"));
    flow.status.phase = "authorizing";
    try {
      await this.hooks.beforeSubmit?.(flow.context);
      if (this.#flow !== flow || flow.status.phase !== "authorizing")
        throw new Error(this.#code("STALE"));
      flow.child.stdin.write(`${code}\n`);
    } catch {
      this.#stop(flow, "failed", this.#code("SUBMIT_FAILED"));
    }
    return this.status();
  }

  #current(id: string): Flow<Context> {
    if (this.#flow.status.id !== id || !this.active) throw new Error(this.#code("STALE"));
    return this.#flow;
  }
  async #complete(flow: Flow<Context>, code: number | null): Promise<void> {
    if (this.#flow !== flow || !this.active) return;
    if (code !== 0 || flow.context === undefined) {
      this.#stop(flow, "failed", this.#code("FAILED"));
      return;
    }
    // The CLI may finish on its own (browser callback on this computer) without a pasted code.
    flow.status.phase = "authorizing";
    try {
      const result = await this.hooks.confirm(flow.context);
      if (this.#flow !== flow || !this.active) return;
      if (result) this.#stop(flow, "succeeded", undefined, result);
      else this.#stop(flow, "failed", this.#code("NOT_CONFIRMED"));
    } catch (error) {
      const thrown = error instanceof Error ? error.message : "";
      this.#stop(flow, "failed", CODE_PATTERN.test(thrown) ? thrown : this.#code("NOT_CONFIRMED"));
    }
  }

  cancel(id: string): ClaudeWebLoginStatus {
    this.#stop(this.#current(id), "cancelled");
    return this.status();
  }
  close(): void {
    if (this.active) this.#stop(this.#flow, "cancelled");
  }
  async #cleanup(flow: Flow<Context>): Promise<void> {
    if (flow.cleaned || flow.context === undefined) return;
    flow.cleaned = true;
    await this.hooks.cleanup?.(flow.context).catch(() => undefined);
  }
  #stop(
    flow: Flow<Context>,
    phase: ClaudeWebLoginPhase,
    error?: string,
    result?: Record<string, unknown>,
  ): void {
    if (this.#flow !== flow || !this.active) return;
    flow.status = {
      phase,
      ...(flow.status.id ? { id: flow.status.id } : {}),
      ...(flow.status.scope !== undefined ? { scope: flow.status.scope } : {}),
      ...(error ? { error } : {}),
      ...(result ? { result } : {}),
    };
    clearTimeout(flow.timer);
    delete flow.url;
    delete flow.state;
    flow.child?.stdin.end();
    const child = flow.child;
    if (child && child.exitCode === null) {
      child.kill();
      // Clean up only once the CLI is gone, so it cannot write the login back afterwards.
      child.once("close", () => void this.#cleanup(flow));
      setTimeout(() => void this.#cleanup(flow), 5_000).unref?.();
    } else void this.#cleanup(flow);
  }
}
