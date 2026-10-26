import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { cleanAlertSettings, type Rly0AlertSettings } from "./alerts.js";
import {
  cleanAgentAutoSwitchMap,
  cleanAgentRecord,
  type Rly0AgentAutoSwitchSettings,
  type Rly0AutoSwitchAgent,
} from "./agent-auto-switch.js";
import { cleanAutoSwitchSettings, type Rly0AutoSwitchSettings } from "./auto-switch.js";

export const RLY0_HUB_STATE_FILE = "hub-desktop.json";

/** Small per-user state of the Hub window, kept in RLY/0 Hub's own data directory. */
export interface Rly0HubState {
  /** Autostart was turned on once on first run; later the person's choice wins. */
  readonly autostartDefaulted?: boolean;
  /** The first-run guide was finished or skipped. */
  readonly onboarded?: boolean;
  /**
   * The person turned on routing through RLY/0 Hub (统一渠道 + local proxy) from the required
   * first-run dialog. Cleared by 恢复纯净状态, so the dialog shows again next time.
   */
  readonly channelConsented?: boolean;
  /** A low-balance notice was shown and the balance has not recovered since. */
  readonly balanceLowNotified?: boolean;
  /** `resetsAt` of the Codex quota window a low-quota notice was shown for. */
  readonly quotaNotifiedFor?: number;
  /** Switch accounts before the current one runs out (off by default). */
  readonly autoSwitch?: Rly0AutoSwitchSettings;
  /** Account, window and reset time an auto-switch notice or switch was made for. */
  readonly autoSwitchHandledFor?: string;
  /** Claude / Grok auto-switch (agent-auto-switch.ts); each off until turned on and confirmed. */
  readonly agentAutoSwitch?: Partial<Record<Rly0AutoSwitchAgent, Rly0AgentAutoSwitchSettings>>;
  /** Per agent: credential, window and reset time a notice or switch was made for. */
  readonly agentAutoSwitchHandled?: Partial<Record<Rly0AutoSwitchAgent, string>>;
  /** Per agent: when the last automatic switch happened (ms), for the cooldown. */
  readonly agentAutoSwitchAt?: Partial<Record<Rly0AutoSwitchAgent, number>>;
  /** Tray-notice thresholds; defaults when absent. */
  readonly alerts?: Rly0AlertSettings;
  /** Hub version a tray "update available" notice was shown for. */
  readonly updateNotifiedFor?: string;
}

function clean(value: unknown): Rly0HubState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return {
    ...(raw.autostartDefaulted === true ? { autostartDefaulted: true } : {}),
    ...(raw.onboarded === true ? { onboarded: true } : {}),
    ...(raw.channelConsented === true ? { channelConsented: true } : {}),
    ...(raw.balanceLowNotified === true ? { balanceLowNotified: true } : {}),
    ...(typeof raw.quotaNotifiedFor === "number" && Number.isSafeInteger(raw.quotaNotifiedFor)
      ? { quotaNotifiedFor: raw.quotaNotifiedFor }
      : {}),
    ...(raw.autoSwitch !== undefined
      ? { autoSwitch: cleanAutoSwitchSettings(raw.autoSwitch) }
      : {}),
    ...(raw.agentAutoSwitch !== undefined
      ? { agentAutoSwitch: cleanAgentAutoSwitchMap(raw.agentAutoSwitch) }
      : {}),
    ...(raw.agentAutoSwitchHandled !== undefined
      ? {
          agentAutoSwitchHandled: cleanAgentRecord(
            raw.agentAutoSwitchHandled,
            (v): v is string => typeof v === "string" && v.length <= 200,
          ),
        }
      : {}),
    ...(raw.agentAutoSwitchAt !== undefined
      ? {
          agentAutoSwitchAt: cleanAgentRecord(
            raw.agentAutoSwitchAt,
            (v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
          ),
        }
      : {}),
    ...(raw.alerts !== undefined ? { alerts: cleanAlertSettings(raw.alerts) } : {}),
    ...(typeof raw.updateNotifiedFor === "string" && raw.updateNotifiedFor.length <= 40
      ? { updateNotifiedFor: raw.updateNotifiedFor }
      : {}),
    ...(typeof raw.autoSwitchHandledFor === "string" && raw.autoSwitchHandledFor.length <= 200
      ? { autoSwitchHandledFor: raw.autoSwitchHandledFor }
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
