import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sameDesktopVersion } from "@codexhost/shared-contracts";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { getUpdateJson, type UpdateHttpGet } from "./hub-update-net.js";

/**
 * Windows: the Microsoft Store updates Codex on its own and cannot hold one app. While the Store
 * offers a Codex build the Hub has not verified, the Hub turns off the Store's own "app updates"
 * switch (AppInstallManager.AutoUpdateSetting, the setting behind Store settings -> app updates;
 * the AutoDownload policy is ignored on Windows 11 Home, trial 2026-11-13) and turns it back on
 * once the offered build is verified or management is switched off.
 *
 * The switch is Windows-wide: while held, no Store app updates on its own (the settings page says
 * so). The original value is journaled before the first change, so a crash at any point is undone
 * by the next check (and by the uninstaller, scripts/release/windows/restore-store-updates.ps1).
 * Only the Hub's own change is undone. When the person turns the switch back on during a hold,
 * their choice wins for that offered build: the journal records it and the Hub does not turn the
 * switch off again until the Store offers another unverified build. A switch that was already off
 * before the Hub acted is reported as `user-off` and never touched.
 *
 * A canary marker in the Hub data directory (the project's own test PC) exempts the machine: it
 * always follows the Store, so new Codex builds show up there first.
 */
export const STORE_SETTING_VALUES = [
  "Disabled",
  "Enabled",
  "DisabledByPolicy",
  "EnabledByPolicy",
] as const;
export type StoreUpdateSetting = (typeof STORE_SETTING_VALUES)[number];
export interface StoreUpdateDriver {
  readSetting(): Promise<StoreUpdateSetting>;
  writeSetting(value: "Disabled" | "Enabled"): Promise<void>;
  /** Codex build the Store currently offers (`26.1117.4957.0`); throws when unreachable. */
  offeredVersion(): Promise<string>;
}
/**
 * `holding`: the Hub turned Store updates off. `user-off`: they were off already (person or policy).
 * `user-on`: the person turned them back on during a hold; kept for that offered build.
 */
export type StoreHoldMode = "holding" | "following" | "canary" | "user-off" | "user-on";
/**
 * `applied` is written only after the switch was turned off and read back as off: a journal
 * without it (write failed, crash between journal and switch, damaged file) never counts as the
 * person turning updates back on.
 */
type StoreHoldJournal =
  | { originalValue: StoreUpdateSetting; applied: boolean; offeredAtApply: string | null }
  | { userEnabledFor: string };
export interface StoreHoldState {
  mode: StoreHoldMode;
  /** The Store switch as last read; null when it could not be read. */
  setting: StoreUpdateSetting | null;
}
export const STORE_CANARY_FILE = "codex-update-canary.json";
export const STORE_HOLD_JOURNAL = "codex-store-hold.json";
export const WINDOWS_STORE_UPDATE_URL =
  "https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json";

export class CodexStoreHold {
  readonly #directory: string;
  constructor(
    readonly options: {
      environment: NodeJS.ProcessEnv;
      driver: StoreUpdateDriver;
      now?: () => number;
    },
  ) {
    this.#directory = resolveRly0DataDir(options.environment);
  }
  get journalFile(): string {
    return path.join(this.#directory, STORE_HOLD_JOURNAL);
  }
  get canaryFile(): string {
    return path.join(this.#directory, STORE_CANARY_FILE);
  }
  async isCanary(): Promise<boolean> {
    try {
      await fs.access(this.canaryFile);
      return true;
    } catch {
      return false;
    }
  }
  offeredVersion(): Promise<string> {
    return this.options.driver.offeredVersion();
  }
  async #journal(): Promise<StoreHoldJournal | null> {
    let text: string;
    try {
      text = await fs.readFile(this.journalFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (
        typeof value === "object" &&
        value !== null &&
        "originalValue" in value &&
        STORE_SETTING_VALUES.includes(value.originalValue as StoreUpdateSetting)
      )
        return {
          originalValue: value.originalValue as StoreUpdateSetting,
          applied: "applied" in value && value.applied === true,
          offeredAtApply:
            "offeredAtApply" in value && typeof value.offeredAtApply === "string"
              ? value.offeredAtApply
              : null,
        };
      if (
        typeof value === "object" &&
        value !== null &&
        "userEnabledFor" in value &&
        typeof value.userEnabledFor === "string"
      )
        return { userEnabledFor: value.userEnabledFor };
    } catch {
      /* fall through */
    }
    // A damaged journal still proves the Hub turned updates off: restore the Store default. It is
    // never proof that the person turned them back on (not applied).
    return { originalValue: "Enabled", applied: false, offeredAtApply: null };
  }
  async #writeJournal(value: Record<string, unknown>): Promise<void> {
    await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.journalFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temporary, this.journalFile);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  /** Store updates off while an unverified build is offered. Journal first, then the switch. */
  async hold(offered: string | null): Promise<StoreHoldState> {
    const setting = await this.options.driver.readSetting();
    let journal = await this.#journal();
    // Turned on by policy: a per-user write cannot override it.
    if (setting === "EnabledByPolicy") throw new Error("CODEX_STORE_POLICY");
    if (journal && "userEnabledFor" in journal) {
      // The person's choice covers the build it was made for; another unverified build is held.
      if (offered === null || sameDesktopVersion(journal.userEnabledFor, offered))
        return { mode: setting === "Enabled" ? "user-on" : "user-off", setting };
      await fs.rm(this.journalFile, { force: true });
      journal = null;
    }
    if (journal && journal.applied && setting === "Enabled") {
      // Turned back on by hand after our hold took effect: respect it for this offered build.
      await this.#writeJournal({
        userEnabledFor: offered ?? journal.offeredAtApply ?? "",
        at: new Date((this.options.now ?? Date.now)()).toISOString(),
      });
      return { mode: "user-on", setting };
    }
    // Already off (by the person or by policy) and not by us: nothing to hold, nothing to undo.
    if (!journal && setting !== "Enabled") return { mode: "user-off", setting };
    const at = new Date((this.options.now ?? Date.now)()).toISOString();
    // Journal first (not applied yet), so a crash after the switch write is still undone.
    const record = {
      originalValue: journal ? journal.originalValue : setting,
      appliedAt: at,
      offeredAtApply: offered,
    };
    if (!journal || !journal.applied) await this.#writeJournal({ ...record, applied: false });
    if (setting === "Enabled") await this.options.driver.writeSetting("Disabled"); // reads back
    if (!journal || !journal.applied) await this.#writeJournal({ ...record, applied: true });
    return { mode: "holding", setting: setting === "DisabledByPolicy" ? setting : "Disabled" };
  }
  /** Undo only the Hub's own change; idempotent, so a crash between steps repeats it safely. */
  async release(mode: "following" | "canary" = "following"): Promise<StoreHoldState> {
    const journal = await this.#journal();
    if (!journal) return { mode, setting: null }; // Nothing of ours to undo; no Store call.
    if ("userEnabledFor" in journal) {
      // The person's own choice: nothing of ours to undo.
      await fs.rm(this.journalFile, { force: true });
      return { mode, setting: null };
    }
    const setting = await this.options.driver.readSetting();
    let now: StoreUpdateSetting = setting;
    if (setting === "Disabled" && journal.originalValue === "Enabled") {
      await this.options.driver.writeSetting("Enabled");
      now = "Enabled";
    }
    await fs.rm(this.journalFile, { force: true });
    return { mode, setting: now };
  }
  /** What a journal on disk says without asking the Store (feed offline after a Hub restart). */
  async recorded(): Promise<"holding" | "user-on" | null> {
    const journal = await this.#journal();
    if (!journal) return null;
    return "userEnabledFor" in journal ? "user-on" : "holding";
  }
  /** True while the Hub's own hold is in place (not the person's recorded choice). */
  async holding(): Promise<boolean> {
    const journal = await this.#journal();
    return journal !== null && "originalValue" in journal;
  }
  /** Any journal file at all, the person's recorded choice included (cleaned up on release). */
  async hasJournal(): Promise<boolean> {
    return (await this.#journal()) !== null;
  }
}

/** Same isolation as the macOS control: never touch the real Store from tests or a dev Hub. */
export function codexStoreControlAllowed(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  realHome = os.userInfo().homedir,
): boolean {
  if (platform !== "win32") return false;
  if (
    environment.RLY0_CODEX_UPDATE_CONTROL === "0" ||
    environment.VITEST ||
    environment.NODE_ENV === "test"
  )
    return false;
  return path.resolve(resolveRly0DataDir(environment)) === path.resolve(realHome, ".rly0-hub");
}

const PS_HEADER = [
  "$ErrorActionPreference = 'Stop'",
  "[void][Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager, Windows.ApplicationModel.Store.Preview, ContentType = WindowsRuntime]",
  "$m = New-Object Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager",
];
export function storeSettingScript(write?: "Disabled" | "Enabled"): string {
  return [
    ...PS_HEADER,
    ...(write
      ? [
          `$m.AutoUpdateSetting = [Windows.ApplicationModel.Store.Preview.InstallControl.AutoUpdateSetting]::${write}`,
        ]
      : []),
    'Write-Output ("SETTING=" + $m.AutoUpdateSetting)',
  ].join("\n");
}
export function parseStoreSetting(output: string): StoreUpdateSetting {
  const match = /SETTING=(\w+)/u.exec(output);
  const value = match?.[1] as StoreUpdateSetting | undefined;
  if (!value || !STORE_SETTING_VALUES.includes(value))
    throw new Error("CODEX_STORE_SETTING_UNKNOWN");
  return value;
}

export type PowerShellRunner = (script: string) => Promise<string>;
export const runPowerShell: PowerShellRunner = (script) =>
  new Promise((resolve, reject) => {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    execFile(
      path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });

export function createWindowsStoreUpdateDriver(options: {
  get: () => Promise<UpdateHttpGet>;
  run?: PowerShellRunner;
}): StoreUpdateDriver {
  const run = options.run ?? runPowerShell;
  return {
    readSetting: async () => parseStoreSetting(await run(storeSettingScript())),
    writeSetting: async (value) => {
      const now = parseStoreSetting(await run(storeSettingScript(value)));
      if (now !== value) throw new Error("CODEX_STORE_WRITE_FAILED");
    },
    offeredVersion: async () => {
      const raw = await getUpdateJson(await options.get(), WINDOWS_STORE_UPDATE_URL, {}, 64 * 1024);
      const version =
        typeof raw === "object" && raw !== null && "buildVersion" in raw ? raw.buildVersion : null;
      if (typeof version !== "string" || !/^\d+(?:\.\d+){2,3}$/u.test(version))
        throw new Error("CODEX_STORE_FEED_INVALID");
      return version;
    },
  };
}
