import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

export const RLY0_HUB_STATE_FILE = "hub-desktop.json";

/** Small per-user state of the Hub window, kept in RLY/0 Hub's own data directory. */
export interface Rly0HubState {
  /** Autostart was turned on once on first run; later the person's choice wins. */
  readonly autostartDefaulted?: boolean;
  /** The first-run guide was finished or skipped. */
  readonly onboarded?: boolean;
  /** A low-balance notice was shown and the balance has not recovered since. */
  readonly balanceLowNotified?: boolean;
  /** `resetsAt` of the Codex quota window a low-quota notice was shown for. */
  readonly quotaNotifiedFor?: number;
}

function clean(value: unknown): Rly0HubState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return {
    ...(raw.autostartDefaulted === true ? { autostartDefaulted: true } : {}),
    ...(raw.onboarded === true ? { onboarded: true } : {}),
    ...(raw.balanceLowNotified === true ? { balanceLowNotified: true } : {}),
    ...(typeof raw.quotaNotifiedFor === "number" && Number.isSafeInteger(raw.quotaNotifiedFor)
      ? { quotaNotifiedFor: raw.quotaNotifiedFor }
      : {}),
  };
}

export class Rly0HubStateStore {
  readonly #file: string;

  constructor(environment: NodeJS.ProcessEnv) {
    this.#file = path.join(resolveRly0DataDir(environment), RLY0_HUB_STATE_FILE);
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.#file);
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<Rly0HubState> {
    try {
      return clean(JSON.parse(await fs.readFile(this.#file, "utf8")));
    } catch {
      return {};
    }
  }

  async update(change: Partial<Record<keyof Rly0HubState, unknown>>): Promise<Rly0HubState> {
    const next = clean({ ...(await this.read()), ...change });
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.#file);
    return next;
  }
}
