import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ClaudeCodeAuth,
  commandExists,
  withClaudeCodeInstallPaths,
} from "../rly0-agents/claude-code-auth.js";
import { applyProxyEnvironment, type Rly0CoreBridge } from "../rly0-core/index.js";
import { parseClaudeImport } from "./claude-official.js";
import { ClaudeWebLogin, type ClaudeWebLoginStatus } from "./claude-web-login.js";

export interface ClaudeAddLoginOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly core: Pick<Rly0CoreBridge, "claudeAccounts" | "getProxySettings">;
  readonly openUrl: (url: string) => void;
  readonly spawnProcess?: typeof spawn;
  readonly fileExists?: (file: string) => boolean;
  /** Where the throw-away config folders go (tests); the system temp folder otherwise. */
  readonly tempRoot?: string;
  readonly timeoutMs?: number;
}

interface AddLoginContext {
  readonly dir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly alias: string;
}

/**
 * Starts an agent's official login command. npm installs CLIs as .cmd shims on Windows, which
 * need a shell; the arguments are fixed. Under cmd.exe, `kill` would stop only the shell and leave
 * the CLI waiting for the browser, so stopping the login stops the whole tree.
 */
export function spawnLoginCli(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    spawnProcess?: typeof spawn;
  },
): ChildProcessWithoutNullStreams {
  const windows = options.platform === "win32";
  const child = (options.spawnProcess ?? spawn)(windows ? `"${command}"` : command, [...args], {
    cwd: options.cwd,
    env: options.environment,
    shell: windows,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  if (windows && !options.spawnProcess) {
    const kill = child.kill.bind(child);
    child.kill = ((signal?: NodeJS.Signals | number) => {
      if (child.pid === undefined) return kill(signal);
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => kill(signal));
      return true;
    }) as typeof child.kill;
  }
  return child;
}

/** Ways the person's own setup could point the login elsewhere; the throw-away folder is all. */
const FOREIGN_LOGIN =
  /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_OAUTH_(TOKEN|REFRESH_TOKEN|CLIENT_ID)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|CODEXHOST_.*)$/iu;

/** Claude Code's environment for one throw-away login: its own config folder and secure storage. */
export function claudeLoginEnvironment(
  environment: NodeJS.ProcessEnv,
  dir: string,
): NodeJS.ProcessEnv {
  const next = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !FOREIGN_LOGIN.test(name)),
  );
  // Both, so Claude Code's Credential Manager entry is this folder's own and never the live one.
  return { ...next, CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir };
}

/**
 * "添加 Claude 账号" without signing the current one out: the official `claude auth login
 * --claudeai` runs on this computer inside a throw-away `CLAUDE_CONFIG_DIR`; Claude Code opens the
 * browser itself and normally finishes on its own (a code from the page can be pasted instead).
 * Once `claude auth status` confirms the login there, rly0-core saves it as an account
 * (`claude/importFrom`), and the folder and its Credential Manager entry are deleted.
 */
export class ClaudeAddLogin {
  readonly #login: ClaudeWebLogin<AddLoginContext>;

  constructor(options: ClaudeAddLoginOptions) {
    const platform = options.platform ?? process.platform;
    this.#login = new ClaudeWebLogin<AddLoginContext>({
      errorPrefix: "CLAUDE_ADD_LOGIN",
      sameScope: () => true,
      prepare: async (alias) => {
        const base = withClaudeCodeInstallPaths(options.environment, platform);
        if (!commandExists("claude", base, platform, options.fileExists))
          throw new Error("CLAUDE_NOT_INSTALLED");
        const dir = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "rly0-claude-login-"));
        const environment = claudeLoginEnvironment(
          applyProxyEnvironment(base, options.core.getProxySettings()),
          dir,
        );
        return { dir, environment, alias };
      },
      spawn: (context) =>
        spawnLoginCli("claude", ["auth", "login", "--claudeai"], {
          cwd: context.dir,
          environment: context.environment,
          platform,
          ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
        }),
      confirm: async (context) => {
        const status = await new ClaudeCodeAuth({
          environment: context.environment,
          platform,
          ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
          ...(options.fileExists ? { fileExists: options.fileExists } : {}),
        }).status();
        if (!status.loggedIn) return null;
        const saved = await options.core.claudeAccounts("importFrom", {
          configDir: context.dir,
          ...(context.alias ? { alias: context.alias } : {}),
        });
        if (!saved) throw new Error("RLY0_CORE_UNAVAILABLE");
        return {
          id: saved.id,
          ...(typeof saved.email === "string" ? { email: saved.email } : {}),
          ...(typeof saved.plan === "string" ? { plan: saved.plan } : {}),
        };
      },
      cleanup: async (context) => {
        await options.core
          .claudeAccounts("forgetLogin", { configDir: context.dir })
          .catch(() => undefined);
        await rm(context.dir, { recursive: true, force: true, maxRetries: 3 }).catch(
          () => undefined,
        );
      },
      openUrl: (url) => options.openUrl(url),
      autoOpen: false,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  get active(): boolean {
    return this.#login.active;
  }
  status(): ClaudeWebLoginStatus {
    return this.#login.status();
  }
  start(alias?: string): Promise<ClaudeWebLoginStatus> {
    return this.#login.start(alias ?? "");
  }
  submit(id: string, code: string): Promise<ClaudeWebLoginStatus> {
    return this.#login.submit(id, code);
  }
  reopen(id: string): ClaudeWebLoginStatus {
    return this.#login.reopen(id);
  }
  cancel(id: string): ClaudeWebLoginStatus {
    return this.#login.cancel(id);
  }
  close(): void {
    this.#login.close();
  }
}

/**
 * "从文件导入": a Claude Code credentials file becomes a saved account (rly0-core checks its
 * shape and who it belongs to) without touching the live login. A Sub2API export carrying a
 * subscription token is a token, not an account: `saveToken` keeps it as the official key.
 */
export async function importClaudeAccountFile(
  core: Pick<Rly0CoreBridge, "claudeAccounts">,
  content: string,
  options: { alias?: string; saveToken: (token: string) => Promise<void> },
): Promise<Record<string, unknown>> {
  let parsed: ReturnType<typeof parseClaudeImport> | null = null;
  try {
    parsed = parseClaudeImport(content);
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_FILE_INVALID")
      throw new Error("CLAUDE_FILE_NOT_JSON");
  }
  if (parsed?.kind === "token") {
    await options.saveToken(parsed.token);
    return { ok: true, token: true };
  }
  const saved = await core.claudeAccounts("importFile", {
    content,
    ...(options.alias ? { alias: options.alias } : {}),
  });
  if (!saved) throw new Error("RLY0_CORE_UNAVAILABLE");
  const pick = (key: string) =>
    typeof saved[key] === "string" || typeof saved[key] === "boolean" ? { [key]: saved[key] } : {};
  return {
    ok: true,
    ...pick("id"),
    ...pick("email"),
    ...pick("plan"),
    ...pick("alreadyCurrent"),
    ...pick("renewed"),
  };
}
