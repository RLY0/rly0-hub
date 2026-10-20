import { spawn } from "node:child_process";
import {
  guestProjectPath,
  sameProject,
  sandboxEnvironment,
  SANDBOX_GUEST_GUARD,
  type SandboxBinding,
} from "@codexhost/sandbox-runtime";
import {
  ClaudeWebLogin,
  claudeLoginUrl,
  type ClaudeWebLoginPhase,
  type ClaudeWebLoginStatus,
} from "./claude-web-login.js";

export type IsolationLoginPhase = ClaudeWebLoginPhase;
export interface IsolationLoginStatus {
  phase: IsolationLoginPhase;
  id?: string;
  project?: string;
  error?: string;
  browserOpened?: boolean;
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

/** Accept only the official CLI's complete OAuth authorization link, never help/error URLs. */
export const claudeIsolationLoginUrl = claudeLoginUrl;

function toIsolationStatus(status: ClaudeWebLoginStatus): IsolationLoginStatus {
  const { phase, id, scope, error, browserOpened } = status;
  return {
    phase,
    ...(id ? { id } : {}),
    ...(scope !== undefined ? { project: scope } : {}),
    ...(error ? { error } : {}),
    ...(browserOpened !== undefined ? { browserOpened } : {}),
  };
}

/** Browser authorization belongs to Claude. Only the one-time code passes through Hub stdin;
 * the CLI exchanges and stores its credentials inside the selected microVM. */
export class IsolationLogin {
  readonly #login: ClaudeWebLogin<SandboxBinding>;
  constructor(readonly options: IsolationLoginOptions) {
    this.#login = new ClaudeWebLogin<SandboxBinding>({
      errorPrefix: "ISOLATION_LOGIN",
      sameScope: sameProject,
      prepare: (project) => options.resolve(project),
      spawn: (binding) =>
        (options.spawnProcess ?? spawn)(
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
            env: sandboxEnvironment(options.environment, binding.settings),
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        ),
      // The microVM must still be the one the link was issued for.
      beforeSubmit: async (binding) => {
        const current = await options.resolve(binding.project.project);
        if (
          current.project.id !== binding.project.id ||
          current.settings.runtimeRoot !== binding.settings.runtimeRoot ||
          current.settings.proxy !== binding.settings.proxy
        )
          throw new Error("ISOLATION_LOGIN_STALE");
      },
      confirm: async (binding) => ((await options.loggedIn(binding)) ? {} : null),
      openUrl: (url) => options.openUrl(url),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.startTimeoutMs !== undefined ? { startTimeoutMs: options.startTimeoutMs } : {}),
    });
  }
  get active(): boolean {
    return this.#login.active;
  }
  status(): IsolationLoginStatus {
    return toIsolationStatus(this.#login.status());
  }
  async start(project: string): Promise<IsolationLoginStatus> {
    return toIsolationStatus(await this.#login.start(project));
  }
  reopen(id: string): IsolationLoginStatus {
    return toIsolationStatus(this.#login.reopen(id));
  }
  async submit(id: string, code: string): Promise<IsolationLoginStatus> {
    return toIsolationStatus(await this.#login.submit(id, code));
  }
  cancel(id: string): IsolationLoginStatus {
    return toIsolationStatus(this.#login.cancel(id));
  }
  close(): void {
    this.#login.close();
  }
}
