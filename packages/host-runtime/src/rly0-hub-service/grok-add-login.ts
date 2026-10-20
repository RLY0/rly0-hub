import type { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { commandExists } from "../rly0-agents/claude-code-auth.js";
import { applyProxyEnvironment, type Rly0CoreBridge } from "../rly0-core/index.js";
import { spawnLoginCli } from "./claude-add-login.js";
import { ClaudeWebLogin, type ClaudeWebLoginStatus } from "./claude-web-login.js";

export interface GrokAddLoginOptions {
  /** The environment to find `grok` in (PATH as Windows has it now, plus known install paths). */
  readonly environment: () => Promise<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
  readonly core: Pick<Rly0CoreBridge, "grokAccounts" | "getProxySettings">;
  readonly openUrl: (url: string) => void;
  readonly spawnProcess?: typeof spawn;
  readonly fileExists?: (file: string) => boolean;
  /** Where the throw-away GROK_HOME folders go (tests); the system temp folder otherwise. */
  readonly tempRoot?: string;
  readonly timeoutMs?: number;
}

interface GrokLoginContext {
  readonly dir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly alias: string;
}

/**
 * Ways the person's own setup could make the CLI use something other than a fresh login in the
 * throw-away folder. An enterprise issuer (`GROK_OIDC_*`) is kept: that is how such a login works.
 */
const FOREIGN_LOGIN = /^(XAI_API_KEY|GROK_API_KEY|GROK_TOKEN|GROK_HOME|CODEXHOST_.*)$/iu;

export function grokLoginEnvironment(
  environment: NodeJS.ProcessEnv,
  dir: string,
): NodeJS.ProcessEnv {
  const next = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !FOREIGN_LOGIN.test(name)),
  );
  return { ...next, GROK_HOME: dir };
}

/**
 * The xAI sign-in page the CLI prints (browser OIDC or a device code page). Only an https page on
 * xAI's own domains is ever opened from here.
 */
export function grokLoginUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const host = url.hostname;
    const official = ["x.ai", "grok.com"].some((d) => host === d || host.endsWith(`.${d}`));
    if (
      value.length > 8192 ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !official
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * "添加 Grok 账号" without signing the current one out: the official `grok login` runs in a
 * throw-away `GROK_HOME` (the CLI's documented home for config and auth); the CLI opens the xAI
 * page in the browser and finishes on its own. Once it exits successfully, rly0-core saves the
 * login it wrote there (`grok/importFrom`) and the folder is deleted.
 */
export class GrokAddLogin {
  readonly #login: ClaudeWebLogin<GrokLoginContext>;

  constructor(options: GrokAddLoginOptions) {
    const platform = options.platform ?? process.platform;
    this.#login = new ClaudeWebLogin<GrokLoginContext>({
      errorPrefix: "GROK_ADD_LOGIN",
      sameScope: () => true,
      loginUrl: grokLoginUrl,
      prepare: async (alias) => {
        const base = await options.environment();
        if (!commandExists("grok", base, platform, options.fileExists))
          throw new Error("GROK_NOT_INSTALLED");
        const dir = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "rly0-grok-login-"));
        const environment = grokLoginEnvironment(
          applyProxyEnvironment(base, options.core.getProxySettings()),
          dir,
        );
        return { dir, environment, alias };
      },
      spawn: (context) =>
        spawnLoginCli("grok", ["login"], {
          cwd: context.dir,
          environment: context.environment,
          platform,
          ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
        }),
      confirm: async (context) => {
        const saved = await options.core.grokAccounts("importFrom", {
          grokHome: context.dir,
          ...(context.alias ? { alias: context.alias } : {}),
        });
        if (!saved) throw new Error("RLY0_CORE_UNAVAILABLE");
        return {
          id: saved.id,
          ...(typeof saved.email === "string" ? { email: saved.email } : {}),
        };
      },
      cleanup: async (context) => {
        await rm(context.dir, { recursive: true, force: true, maxRetries: 3 }).catch(
          () => undefined,
        );
      },
      openUrl: (url) => options.openUrl(url),
      // The CLI opens the browser itself; the link is only offered again on request.
      autoOpen: false,
      // The CLI may not print its link before the browser round trip, so the start limit is the
      // whole login's.
      startTimeoutMs: options.timeoutMs ?? 10 * 60_000,
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
 * "从文件导入" on the Grok tab: a Grok CLI `auth.json` becomes a saved account (rly0-core checks
 * its shape and whose it is). A file with an xAI API key instead (a Sub2API export, say) is kept
 * as the official key by `saveKeyFile`; when that fails too, the account error stands.
 */
export async function importGrokAccountFile(
  core: Pick<Rly0CoreBridge, "grokAccounts">,
  content: string,
  options: { alias?: string; saveKeyFile: (content: string) => Promise<unknown> },
): Promise<Record<string, unknown>> {
  let saved: Record<string, unknown> | null;
  try {
    saved = await core.grokAccounts("importFile", {
      content,
      ...(options.alias ? { alias: options.alias } : {}),
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code !== "GROK_FILE_NO_LOGIN" && code !== "GROK_FILE_API_KEY") throw error;
    try {
      await options.saveKeyFile(content);
    } catch {
      throw error;
    }
    return { ok: true, key: true };
  }
  if (!saved) throw new Error("RLY0_CORE_UNAVAILABLE");
  const pick = (key: string) =>
    typeof saved[key] === "string" || typeof saved[key] === "boolean" ? { [key]: saved[key] } : {};
  return {
    ok: true,
    ...pick("id"),
    ...pick("email"),
    ...pick("alreadyCurrent"),
    ...pick("expired"),
  };
}
