import type {
  Rly0AccountsAddLoginCancelResult,
  Rly0AccountsAddLoginStatusResult,
} from "@codexhost/shared-contracts";

import {
  spawnOfficialAppServerConnection,
  type OfficialAppServerConnection,
} from "../official-app-server-connection.js";
import { Rly0AddAccountLogins } from "../rly0-core/add-account-login.js";
import { applyProxyEnvironment, type Rly0CoreBridge } from "../rly0-core/index.js";
import { locateOfficialCodex, type CodexLocation } from "./codex-locate.js";

export interface Rly0HubAddLoginOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly core: Pick<Rly0CoreBridge, "status" | "importFrom" | "getProxySettings">;
  /** Opens the official sign-in page in the system browser. */
  readonly openUrl: (url: string) => void;
  readonly locate?: () => Promise<CodexLocation | null>;
  /** Starts the private official app-server (defaults to spawning `stockCodexPath`). */
  readonly connectOfficial?: (input: {
    stockCodexPath: string;
    arguments: string[];
    environment: NodeJS.ProcessEnv;
    cwd: string;
  }) => OfficialAppServerConnection;
  readonly tempRoot?: string;
}

/** Official ChatGPT sign-in pages; anything else is returned for display but not opened. */
const OFFICIAL_AUTH_HOST = /(^|\.)(openai\.com|chatgpt\.com)$/iu;

function codeError(code: string): Error {
  return Object.assign(new Error(code), { code: -32000 });
}

/** The private app-server gets the Hub's proxy and its own CODEX_HOME, nothing else of ours. */
function loginEnvironment(environment: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const next = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !/^(CODEXHOST_|OPENAI_|CODEX_HOME$|CODEX_CLI_PATH$)/iu.test(name),
    ),
  );
  return { ...next, CODEX_HOME: codexHome };
}

/**
 * "添加其他 GPT 账号" from the Hub window. The same flow as the in-Codex accounts page
 * (`Rly0AddAccountLogins`): the official Codex app-server runs a browser login inside a throw-away
 * `CODEX_HOME`, rly0-core imports the result, and the live `~/.codex` login is never touched. The
 * Hub runs outside Codex, so it finds the official executable itself (`locateOfficialCodex`).
 */
export class Rly0HubAddLogin {
  readonly #options: Rly0HubAddLoginOptions;
  readonly #logins: Rly0AddAccountLogins;
  #codexPath: string | null = null;

  constructor(options: Rly0HubAddLoginOptions) {
    this.#options = options;
    const { core } = options;
    this.#logins = new Rly0AddAccountLogins({
      coreAvailable: async () => (await core.status()).available,
      importFrom: (params) => core.importFrom(params),
      spawnOfficial: (codexHome) => {
        if (!this.#codexPath) throw codeError("CODEX_NOT_FOUND");
        const connection = (options.connectOfficial ?? spawnOfficialAppServerConnection)({
          stockCodexPath: this.#codexPath,
          arguments: ["app-server"],
          environment: loginEnvironment(
            applyProxyEnvironment(options.environment, core.getProxySettings()),
            codexHome,
          ),
          cwd: codexHome,
        });
        // If the executable cannot start (EACCES, ENOENT), writing the first request fails with a
        // stream error; the login reports it, and the Hub service must not crash on it.
        connection.stdin.on("error", () => undefined);
        return connection;
      },
      ...(options.tempRoot ? { tempRoot: options.tempRoot } : {}),
    });
  }

  async start(params: { alias?: string | undefined }): Promise<{ id: string; url: string }> {
    const location = await (
      this.#options.locate ??
      (() =>
        locateOfficialCodex({
          environment: this.#options.environment,
          ...(this.#options.platform ? { platform: this.#options.platform } : {}),
        }))
    )().catch(() => null);
    if (!location) throw codeError("CODEX_NOT_FOUND");
    this.#codexPath = location.path;
    let started;
    try {
      started = await this.#logins.start(params);
    } catch (error) {
      // The executable was found but would not run (or exited before answering).
      const code = error instanceof Error ? error.message : "";
      throw codeError(code === "LOGIN_PROCESS_EXITED" ? "CODEX_START_FAILED" : code);
    }
    if (!started.available) throw codeError("RLY0_CORE_UNAVAILABLE");
    try {
      if (OFFICIAL_AUTH_HOST.test(new URL(started.authUrl).hostname)) {
        this.#options.openUrl(started.authUrl);
      }
    } catch {
      // The window still shows the link.
    }
    return { id: started.loginId, url: started.authUrl };
  }

  status(id: string): Rly0AccountsAddLoginStatusResult {
    return this.#logins.status({ loginId: id });
  }

  cancel(id: string): Promise<Rly0AccountsAddLoginCancelResult> {
    return this.#logins.cancel({ loginId: id });
  }

  close(): Promise<void> {
    return this.#logins.close();
  }
}
