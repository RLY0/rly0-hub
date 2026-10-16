import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { Rly0AgentAuthStatus } from "@codexhost/shared-contracts";

/** Claude Code's own login, driven through its CLI (`claude auth status|login|logout`). */
export interface ClaudeCodeAuthOptions {
  readonly environment: NodeJS.ProcessEnv;
  /** Saved custom entrypoint from the Connections page, if any; otherwise `claude` on PATH. */
  readonly command?: () => Promise<string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawn;
  readonly fileExists?: (file: string) => boolean;
}

/**
 * PATH plus the folders Claude Code's own installers use. A freshly installed Claude Code is often
 * missing from the PATH Codex started with, though its installer already updated the user's PATH.
 */
export function withClaudeCodeInstallPaths(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const home = environment.USERPROFILE ?? environment.HOME ?? "";
  const extra = windows
    ? [
        home ? pathApi.join(home, ".local", "bin") : "",
        environment.APPDATA ? pathApi.join(environment.APPDATA, "npm") : "",
      ]
    : [
        home ? pathApi.join(home, ".local", "bin") : "",
        home ? pathApi.join(home, ".claude", "local") : "",
        home ? pathApi.join(home, ".npm-global", "bin") : "",
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ];
  const current = environment.PATH ?? environment.Path ?? "";
  const next: NodeJS.ProcessEnv = { ...environment };
  delete next.Path;
  next.PATH = [current, ...extra.filter(Boolean)].filter(Boolean).join(pathApi.delimiter);
  return next;
}

/** Whether `command` names an existing file, directly or through PATH (and PATHEXT on Windows). */
export function commandExists(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fileExists: (file: string) => boolean = existsSync,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const extensions =
    platform === "win32"
      ? ["", ...(environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  const candidates = (base: string): string[] =>
    extensions.flatMap((extension) => [base + extension, base + extension.toLowerCase()]);
  if (command.includes("/") || command.includes("\\")) {
    return candidates(command).some((file) => fileExists(file));
  }
  const searchPath = environment.PATH ?? environment.Path ?? "";
  return searchPath
    .split(pathApi.delimiter)
    .filter(Boolean)
    .some((directory) =>
      candidates(pathApi.join(directory, command)).some((file) => fileExists(file)),
    );
}

const STATUS_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 64 * 1024;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return undefined;
}

/** Reads `claude auth status --json` defensively: only a few display fields are kept. */
export function parseClaudeAuthStatus(output: string): Rly0AgentAuthStatus {
  let value: unknown;
  try {
    const start = output.indexOf("{");
    value = JSON.parse(start >= 0 ? output.slice(start) : output);
  } catch {
    return { installed: true, loggedIn: false, error: "STATUS_UNREADABLE" };
  }
  if (!isRecord(value)) return { installed: true, loggedIn: false, error: "STATUS_UNREADABLE" };
  const account = isRecord(value.account) ? value.account : {};
  const method = firstString(value, ["authMethod", "method"]);
  const email =
    firstString(value, ["email", "emailAddress"]) ??
    firstString(account, ["email", "emailAddress"]);
  const plan =
    firstString(value, ["subscriptionType", "plan", "subscription"]) ??
    firstString(account, ["subscriptionType", "plan"]);
  return {
    installed: true,
    loggedIn: value.loggedIn === true,
    ...(method && method !== "none" ? { method } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

/**
 * Status, login and logout for Claude Code's own account. Login opens Claude Code's browser
 * sign-in; RLY/0 Hub never sees the credentials, only the status Claude Code reports.
 */
export class ClaudeCodeAuth {
  readonly #options: ClaudeCodeAuthOptions;
  #login: { child: ChildProcess; url?: string; startedAt: number } | null = null;

  constructor(options: ClaudeCodeAuthOptions) {
    this.#options = options;
  }

  async #command(): Promise<string> {
    return (await this.#options.command?.())?.trim() || "claude";
  }

  #spawn(command: string, args: readonly string[]): ChildProcess {
    const spawnProcess = this.#options.spawnProcess ?? spawn;
    const windows = (this.#options.platform ?? process.platform) === "win32";
    // npm installs `claude` as a .cmd shim on Windows, which needs a shell. The arguments are fixed
    // literals here and the command comes from PATH or the person's own saved setting.
    return spawnProcess(windows ? `"${command}"` : command, [...args], {
      env: this.#environment(),
      shell: windows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  #environment(): NodeJS.ProcessEnv {
    return withClaudeCodeInstallPaths(
      this.#options.environment,
      this.#options.platform ?? process.platform,
    );
  }

  #installed(command: string): boolean {
    return commandExists(
      command,
      this.#environment(),
      this.#options.platform ?? process.platform,
      this.#options.fileExists,
    );
  }

  async status(): Promise<Rly0AgentAuthStatus> {
    const command = await this.#command();
    if (!this.#installed(command)) return { installed: false, loggedIn: false };
    return await new Promise<Rly0AgentAuthStatus>((resolve) => {
      let output = "";
      let settled = false;
      const finish = (result: Rly0AgentAuthStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ...result, ...(this.#login ? { loginInProgress: true } : {}) });
      };
      let child: ChildProcess;
      try {
        child = this.#spawn(command, ["auth", "status", "--json"]);
      } catch {
        finish({ installed: false, loggedIn: false });
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        finish({ installed: true, loggedIn: false, error: "STATUS_TIMEOUT" });
      }, STATUS_TIMEOUT_MS);
      const collect = (chunk: Buffer | string): void => {
        if (output.length < MAX_OUTPUT) output += chunk.toString();
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", () => finish({ installed: false, loggedIn: false }));
      child.on("close", (code) => {
        if (code !== 0 && !output.includes("{")) {
          // A missing command exits non-zero with only an error message.
          finish(
            /not recognized|not found|ENOENT|无法将|不是内部或外部命令/iu.test(output)
              ? { installed: false, loggedIn: false }
              : { installed: true, loggedIn: false, error: "STATUS_FAILED" },
          );
          return;
        }
        finish(parseClaudeAuthStatus(output));
      });
    });
  }

  /** Starts Claude Code's browser sign-in; resolves with the sign-in link once it is known. */
  async login(mode: "claudeai" | "console"): Promise<{ started: boolean; url?: string }> {
    if (this.#login) return { started: true, ...(this.#login.url ? { url: this.#login.url } : {}) };
    const command = await this.#command();
    if (!this.#installed(command)) return { started: false };
    let child: ChildProcess;
    try {
      child = this.#spawn(command, [
        "auth",
        "login",
        mode === "console" ? "--console" : "--claudeai",
      ]);
    } catch {
      return { started: false };
    }
    const login: { child: ChildProcess; url?: string; startedAt: number } = {
      child,
      startedAt: Date.now(),
    };
    this.#login = login;
    const timer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);
    timer.unref?.();
    const done = (): void => {
      clearTimeout(timer);
      if (this.#login === login) this.#login = null;
    };
    child.on("close", done);
    child.on("error", done);
    return await new Promise((resolve) => {
      let output = "";
      const wait = setTimeout(() => resolve({ started: this.#login === login }), 5_000);
      const scan = (chunk: Buffer | string): void => {
        if (output.length < MAX_OUTPUT) output += chunk.toString();
        const url = URL_PATTERN.exec(output)?.[0];
        if (url && !login.url) {
          login.url = url.slice(0, 2048);
          clearTimeout(wait);
          resolve({ started: true, url: login.url });
        }
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
      child.on("error", () => {
        clearTimeout(wait);
        resolve({ started: false });
      });
    });
  }

  cancelLogin(): void {
    this.#login?.child.kill();
    this.#login = null;
  }

  async logout(): Promise<boolean> {
    this.cancelLogin();
    const command = await this.#command();
    return await new Promise<boolean>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.#spawn(command, ["auth", "logout"]);
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, STATUS_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }
}
