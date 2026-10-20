import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  guestProjectPath,
  sameProject,
  sandboxEnvironment,
  SANDBOX_GUEST_GUARD,
  type SandboxBinding,
} from "@codexhost/sandbox-runtime";

export type IsolationLoginPhase =
  "idle" | "starting" | "waitingForCode" | "authorizing" | "succeeded" | "failed" | "cancelled";
export interface IsolationLoginStatus {
  phase: IsolationLoginPhase;
  id?: string;
  project?: string;
  error?: string;
  browserOpened?: boolean;
}
interface LoginFlow {
  status: IsolationLoginStatus;
  binding?: SandboxBinding;
  child?: ChildProcessWithoutNullStreams;
  timer?: ReturnType<typeof setTimeout>;
  url?: string;
  state?: string;
}
export interface IsolationLoginOptions {
  environment: NodeJS.ProcessEnv;
  resolve(project: string): Promise<SandboxBinding>;
  loggedIn(binding: SandboxBinding): Promise<boolean>;
  openUrl(url: string): void;
  spawnProcess?: typeof spawn;
  /** Whole-flow limit once the authorization link is shown (default 10 min). */
  timeoutMs?: number;
  /** Limit for resolving the sandbox, booting the microVM and printing the link (default 3 min). */
  startTimeoutMs?: number;
}

/** A cold microVM boot plus proxy check and CLI start-up routinely takes well over a minute. */
const DEFAULT_START_TIMEOUT_MS = 3 * 60_000;

/** Accept only the official CLI's complete OAuth authorization link, never help/error URLs. */
export function claudeIsolationLoginUrl(value: string): URL | null {
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

/** Browser authorization belongs to Claude. Only the one-time code passes through Hub stdin;
 * the CLI exchanges and stores its credentials inside the selected microVM. */
export class IsolationLogin {
  #flow: LoginFlow = { status: { phase: "idle" } };
  constructor(readonly options: IsolationLoginOptions) {}
  get active(): boolean {
    return ["starting", "waitingForCode", "authorizing"].includes(this.#flow.status.phase);
  }
  status(): IsolationLoginStatus {
    return { ...this.#flow.status };
  }

  async start(project: string): Promise<IsolationLoginStatus> {
    if (this.active) {
      if (!this.#flow.status.project || !sameProject(project, this.#flow.status.project))
        throw new Error("ISOLATION_LOGIN_BUSY");
      return this.status();
    }
    const flow: LoginFlow = { status: { phase: "starting", id: randomUUID(), project } };
    this.#flow = flow;
    flow.timer = setTimeout(
      () => this.#stop(flow, "failed", "ISOLATION_LOGIN_TIMEOUT"),
      this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    );
    flow.timer.unref?.();
    try {
      const binding = await this.options.resolve(project);
      if (this.#flow !== flow || !this.active) return this.status();
      flow.binding = binding;
      const child = (this.options.spawnProcess ?? spawn)(
        binding.command,
        [
          "exec",
          "-i",
          "-u",
          "root",
          "-w",
          guestProjectPath(binding.project.project),
          binding.project.name,
          "python3",
          "-c",
          SANDBOX_GUEST_GUARD,
          "--login",
          "/home/agent/.local/bin/claude",
          "auth",
          "login",
          "--claudeai",
        ],
        {
          env: sandboxEnvironment(this.options.environment, binding.settings),
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      flow.child = child;
      let output = "";
      const scan = (chunk: Buffer | string) => {
        if (this.#flow !== flow || flow.status.phase !== "starting") return;
        output = (output + chunk.toString()).slice(-32 * 1024);
        for (const match of output.matchAll(/(https:\/\/[^\s"'<>]+)\s/gu)) {
          const url = claudeIsolationLoginUrl(match[1] ?? "");
          if (!url) continue;
          flow.url = url.href;
          flow.state = url.searchParams.get("state") ?? "";
          flow.status = { ...flow.status, phase: "waitingForCode", browserOpened: false };
          clearTimeout(flow.timer);
          flow.timer = setTimeout(
            () => this.#stop(flow, "failed", "ISOLATION_LOGIN_TIMEOUT"),
            this.options.timeoutMs ?? 10 * 60_000,
          );
          flow.timer.unref?.();
          output = "";
          this.#open(flow);
          break;
        }
      };
      child.stdout.on("data", scan);
      child.stderr.on("data", scan);
      child.stdin.on("error", () => this.#stop(flow, "failed", "ISOLATION_LOGIN_FAILED"));
      child.once("error", () => this.#stop(flow, "failed", "ISOLATION_LOGIN_START_FAILED"));
      child.once("close", (code) => {
        void this.#complete(flow, code);
      });
    } catch {
      this.#stop(flow, "failed", "ISOLATION_LOGIN_START_FAILED");
    }
    return this.status();
  }

  #open(flow: LoginFlow): void {
    if (!flow.url) return;
    try {
      this.options.openUrl(flow.url);
      flow.status.browserOpened = true;
    } catch {
      flow.status.browserOpened = false;
    }
  }
  reopen(id: string): IsolationLoginStatus {
    const flow = this.#current(id);
    if (flow.status.phase !== "waitingForCode") throw new Error("ISOLATION_LOGIN_NOT_WAITING");
    this.#open(flow);
    return this.status();
  }

  async submit(id: string, code: string): Promise<IsolationLoginStatus> {
    const flow = this.#current(id);
    if (flow.status.phase !== "waitingForCode" || !flow.binding || !flow.child)
      throw new Error("ISOLATION_LOGIN_NOT_WAITING");
    if (!code || code.length > 4096 || /\s/u.test(code))
      throw new Error("ISOLATION_LOGIN_CODE_INVALID");
    const separator = code.indexOf("#");
    if (separator >= 0 && code.slice(separator + 1) !== flow.state)
      throw new Error("ISOLATION_LOGIN_CODE_MISMATCH");
    flow.status.phase = "authorizing";
    try {
      const current = await this.options.resolve(flow.binding.project.project);
      if (this.#flow !== flow || flow.status.phase !== "authorizing")
        throw new Error("ISOLATION_LOGIN_STALE");
      if (
        current.project.id !== flow.binding.project.id ||
        current.settings.runtimeRoot !== flow.binding.settings.runtimeRoot ||
        current.settings.proxy !== flow.binding.settings.proxy
      )
        throw new Error("ISOLATION_LOGIN_STALE");
      flow.child.stdin.write(`${code}\n`);
    } catch {
      this.#stop(flow, "failed", "ISOLATION_LOGIN_SUBMIT_FAILED");
    }
    return this.status();
  }

  #current(id: string): LoginFlow {
    if (this.#flow.status.id !== id || !this.active) throw new Error("ISOLATION_LOGIN_STALE");
    return this.#flow;
  }
  async #complete(flow: LoginFlow, code: number | null): Promise<void> {
    if (this.#flow !== flow || !this.active) return;
    if (code !== 0 || !flow.binding) {
      this.#stop(flow, "failed", "ISOLATION_LOGIN_FAILED");
      return;
    }
    try {
      const confirmed = await this.options.loggedIn(flow.binding);
      if (this.#flow !== flow || !this.active) return;
      this.#stop(
        flow,
        confirmed ? "succeeded" : "failed",
        confirmed ? undefined : "ISOLATION_LOGIN_NOT_CONFIRMED",
      );
    } catch {
      this.#stop(flow, "failed", "ISOLATION_LOGIN_NOT_CONFIRMED");
    }
  }

  cancel(id: string): IsolationLoginStatus {
    this.#stop(this.#current(id), "cancelled");
    return this.status();
  }
  close(): void {
    if (this.active) this.#stop(this.#flow, "cancelled");
  }
  #stop(flow: LoginFlow, phase: IsolationLoginPhase, error?: string): void {
    if (this.#flow !== flow || !this.active) return;
    flow.status = {
      phase,
      ...(flow.status.id ? { id: flow.status.id } : {}),
      ...(flow.status.project ? { project: flow.status.project } : {}),
      ...(error ? { error } : {}),
    };
    clearTimeout(flow.timer);
    delete flow.url;
    delete flow.state;
    flow.child?.stdin.end();
    if (flow.child && flow.child.exitCode === null) flow.child.kill();
  }
}
