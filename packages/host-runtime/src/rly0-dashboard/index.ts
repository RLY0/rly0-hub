import { promises as fs } from "node:fs";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import type {
  Rly0DashboardHealthResult,
  Rly0DashboardThreadStatsResult,
} from "@codexhost/shared-contracts";

import { resolveCodexHome } from "../rly0-mcp/file-io.js";
import { Rly0ThreadsManager, computeActivity, computeThreadStats } from "../rly0-threads/index.js";

export interface Rly0DashboardManagerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** Shared with the threads page so both see the same sessions root. */
  readonly threads?: Rly0ThreadsManager;
  /** Injectable clock for the activity heat map (tests). */
  readonly now?: () => Date;
}

async function statKind(candidate: string): Promise<"file" | "directory" | null> {
  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return null;
  } catch {
    return null;
  }
}

/**
 * Backs the dashboard page. The health check reports existence / parse-ability booleans only:
 * `auth.json` is only ever `stat`-ed (its content is never opened), and `config.toml` is parsed
 * just to learn whether it is valid TOML — neither content nor parse error text is returned.
 */
export class Rly0DashboardManager {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #threads: Rly0ThreadsManager;
  readonly #now: () => Date;

  constructor(options: Rly0DashboardManagerOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#threads = options.threads ?? new Rly0ThreadsManager({ environment: this.#environment });
    this.#now = options.now ?? (() => new Date());
  }

  async health(): Promise<Rly0DashboardHealthResult> {
    const codexHome = resolveCodexHome(this.#environment);
    const configPath = path.join(codexHome, "config.toml");
    const [homeKind, authKind, configKind, sessionsKind] = await Promise.all([
      statKind(codexHome),
      statKind(path.join(codexHome, "auth.json")),
      statKind(configPath),
      statKind(path.join(codexHome, "sessions")),
    ]);
    let configTomlParses: boolean | null = null;
    if (configKind === "file") {
      try {
        parseToml(await fs.readFile(configPath, "utf8"));
        configTomlParses = true;
      } catch {
        configTomlParses = false;
      }
    }
    return {
      codexHome,
      codexHomeExists: homeKind === "directory",
      authJsonExists: authKind === "file",
      configTomlExists: configKind === "file",
      configTomlParses,
      sessionsDirExists: sessionsKind === "directory",
    };
  }

  async threadStats(): Promise<Rly0DashboardThreadStatsResult> {
    const { rootExists, files } = await this.#threads.scanSessions();
    return {
      sessionsRoot: this.#threads.sessionsRoot(),
      rootExists,
      stats: computeThreadStats(files),
      activity: computeActivity(files, this.#now()),
    };
  }
}

/** Maps a rejected `Rly0DashboardManager` call to a JSON-RPC error without leaking detail. */
export function rly0DashboardRpcError(): { code: number; message: string } {
  return { code: -32000, message: "DASHBOARD_OPERATION_FAILED" };
}
