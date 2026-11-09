import { promises as fs } from "node:fs";
import path from "node:path";
import { compareCodexVersions, type CodexUpdateSettings } from "@codexhost/shared-contracts";
import type { CodexCompatibilityCatalog } from "./codex-compat.js";
import type { Rly0HubStateStore } from "./hub-state.js";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

export interface CodexUpdateDriver {
  readAutoUpdate(): Promise<boolean | null>;
  writeAutoUpdate(value: boolean | null): Promise<void>;
  currentVersion(): Promise<string | null>;
  latestVersion(current: string): Promise<string>;
  requestCheck(): Promise<void>;
  downloadReady(version: string): Promise<boolean>;
  /** No force kill: saves Codex state through its own normal quit. */
  quit(): Promise<void>;
  /** True only when Desktop and its Sparkle Autoupdate have exited. */
  installationStopped(): Promise<boolean>;
  reopen(): Promise<boolean>;
  healthy(): Promise<boolean>;
}
export type CodexUpdatePhase =
  | "checking"
  | "disabled"
  | "unsupported"
  | "up-to-date"
  | "waiting-compatibility"
  | "waiting-idle"
  | "downloading"
  | "installing"
  | "health-check"
  | "failed";
export type CodexUpdateError =
  | "CODEX_PREFERENCES_FAILED"
  | "CODEX_APPCAST_FAILED"
  | "CODEX_VERSION_UNAVAILABLE"
  | "CODEX_UPDATE_CHECK_FAILED"
  | "CODEX_DOWNLOAD_TIMEOUT"
  | "CODEX_INSTALL_TIMEOUT"
  | "CODEX_UPDATE_TARGET_CHANGED"
  | "CODEX_REOPEN_FAILED"
  | "CODEX_HEALTH_FAILED"
  | "CODEX_STATE_FAILED"
  | null;
export interface CodexUpdateStatus {
  enabled: boolean;
  defaulted: boolean;
  supported: boolean;
  noticePending: boolean;
  phase: CodexUpdatePhase;
  currentVersion: string | null;
  latestVersion: string | null;
  error: CodexUpdateError;
  checkedAt: string | null;
  compatibility: ReturnType<CodexCompatibilityCatalog["status"]>;
  renderer: ReturnType<CodexCompatibilityCatalog["policy"]>;
}
const ACTIVE = new Set<CodexUpdatePhase>([
  "downloading",
  "waiting-idle",
  "installing",
  "health-check",
]);
/** One serialized state machine. No unbounded waits inside an RPC or the five-minute alert check. */
export class CodexUpdateManager {
  #settings: CodexUpdateSettings = { defaulted: false, enabled: true };
  #phase: CodexUpdatePhase = "checking";
  #current: string | null = null;
  #latest: string | null = null;
  #error: CodexUpdateError = null;
  #checkedAt: string | null = null;
  #stageAt = 0;
  #idleSince: number | null = null;
  #initialized = false;
  #stopped = false;
  #queue: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    readonly options: {
      environment: NodeJS.ProcessEnv;
      state: Rly0HubStateStore;
      catalog: CodexCompatibilityCatalog;
      driver: CodexUpdateDriver | null;
      currentVersion?: () => Promise<string | null>;
      busy: () => Promise<boolean | null>;
      now?: () => number;
      idleMs?: number;
      downloadTimeoutMs?: number;
      installTimeoutMs?: number;
    },
  ) {}
  #sessionFile() {
    return path.join(resolveRly0DataDir(this.options.environment), "codex-update-session.json");
  }
  async #recordSession() {
    const file = this.#sessionFile();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ target: this.#latest, at: this.#now() }), {
      mode: 0o600,
    });
    await fs.rename(`${file}.tmp`, file);
  }
  #now() {
    return (this.options.now ?? Date.now)();
  }
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
  status(): CodexUpdateStatus {
    return {
      enabled: this.#settings.enabled,
      defaulted: this.#settings.defaulted,
      supported: this.options.driver !== null,
      noticePending: this.#settings.defaulted && this.#settings.noticeAcknowledged !== true,
      phase: this.#phase,
      currentVersion: this.#current,
      latestVersion: this.#latest,
      error: this.#error,
      checkedAt: this.#checkedAt,
      compatibility: this.options.catalog.status(),
      renderer: this.options.catalog.policy(this.#current),
    };
  }
  async #initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.options.catalog.load();
    this.#settings = (await this.options.state.read()).codexUpdates ?? {
      defaulted: true,
      enabled: true,
    };
    if (!this.options.driver) {
      await this.options.state.update({ codexUpdates: this.#settings });
      this.#initialized = true;
      return;
    }
    if (this.#settings.enabled) {
      // Persist the original before the first side effect. An absent preference is preserved as null.
      if (this.#settings.originalAutoUpdate === undefined) {
        this.#settings = {
          ...this.#settings,
          originalAutoUpdate: await this.options.driver.readAutoUpdate(),
        };
        await this.options.state.update({ codexUpdates: this.#settings });
      }
      // Also disarms a release interrupted by a Hub crash.
      await this.options.driver.writeAutoUpdate(false);
      try {
        const record: unknown = JSON.parse(await fs.readFile(this.#sessionFile(), "utf8"));
        if (
          typeof record === "object" &&
          record !== null &&
          "target" in record &&
          "at" in record &&
          typeof record.target === "string" &&
          typeof record.at === "number" &&
          this.#now() >= record.at &&
          this.#now() - record.at < 30 * 60_000 &&
          (await this.options.driver.currentVersion()) === record.target
        ) {
          this.#latest = record.target;
          this.#current = record.target;
          this.#phase = "installing";
          this.#stageAt = this.#now();
        }
      } catch {
        /* Absent/corrupt journal cannot trigger a restart. */
      }
    }
    this.#initialized = true;
  }
  start(): Promise<CodexUpdateStatus> {
    this.#stopped = false;
    this.#timer ??= setInterval(() => {
      if (ACTIVE.has(this.#phase)) void this.tick();
    }, 2000);
    this.#timer.unref();
    return this.check();
  }
  stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    return this.#serial(async () => {
      if (ACTIVE.has(this.#phase)) await this.#disarm();
    });
  }
  acknowledgeNotice(): Promise<CodexUpdateStatus> {
    return this.#serial(async () => {
      const settings = (await this.options.state.read()).codexUpdates;
      if (settings) {
        this.#settings = { ...settings, noticeAcknowledged: true };
        await this.options.state.update({ codexUpdates: this.#settings });
      }
      return this.status();
    });
  }
  setEnabled(enabled: boolean): Promise<CodexUpdateStatus> {
    return this.#serial(async () => {
      try {
        // If initialization never acquired the preference, there is nothing to restore.
        // A permission failure must not prevent the person opting out of future management.
        if (!enabled && !this.#initialized) {
          const saved = (await this.options.state.read()).codexUpdates;
          if (saved?.originalAutoUpdate === undefined) {
            this.#settings = { defaulted: true, enabled: false, noticeAcknowledged: true };
            await this.options.state.update({ codexUpdates: this.#settings });
            await this.options.catalog.load();
            this.#initialized = true;
            this.#error = null;
            this.#phase = "disabled";
            return this.status();
          }
        }
        await this.#initialize();
        const driver = this.options.driver;
        if (enabled === this.#settings.enabled) {
          if (enabled && this.#error) {
            await driver?.writeAutoUpdate(false);
            this.#error = null;
            this.#phase = "checking";
          }
          return this.status();
        }
        if (enabled) {
          this.#settings = {
            defaulted: true,
            enabled: true,
            noticeAcknowledged: true,
            ...(driver ? { originalAutoUpdate: await driver.readAutoUpdate() } : {}),
          };
          await this.options.state.update({ codexUpdates: this.#settings });
          if (driver) await driver.writeAutoUpdate(false);
        } else {
          // Persist disabled only after restoration succeeds. A failed restore can be retried.
          if (driver && this.#settings.originalAutoUpdate !== undefined)
            await driver.writeAutoUpdate(this.#settings.originalAutoUpdate);
          await fs.rm(this.#sessionFile(), { force: true });
          this.#settings = { defaulted: true, enabled: false, noticeAcknowledged: true };
          await this.options.state.update({ codexUpdates: this.#settings });
        }
        this.#error = null;
        this.#phase = enabled ? "checking" : "disabled";
        this.#idleSince = null;
      } catch {
        this.#fail("CODEX_PREFERENCES_FAILED");
      }
      return this.status();
    }).then(async (result) => (enabled && !result.error ? this.check() : result));
  }
  check(): Promise<CodexUpdateStatus> {
    return this.#serial(async () => {
      if (this.#stopped) return this.status();
      try {
        await this.#initialize();
      } catch {
        this.#fail("CODEX_PREFERENCES_FAILED");
        return this.status();
      }
      await this.options.catalog.refresh();
      this.#current =
        (await (this.options.currentVersion ?? this.options.driver?.currentVersion)?.().catch(
          () => null,
        )) ?? null;
      try {
        await this.options.catalog.publishPolicy(this.#current);
      } catch {
        this.#fail("CODEX_STATE_FAILED");
        return this.status();
      }
      if (!this.#settings.enabled) {
        this.#phase = "disabled";
        return this.status();
      }
      const driver = this.options.driver;
      if (!driver) {
        this.#phase = "unsupported";
        return this.status();
      }
      if (ACTIVE.has(this.#phase)) {
        await this.#advance();
        return this.status();
      }
      this.#error = null;
      this.#idleSince = null;
      try {
        await driver.writeAutoUpdate(false);
      } catch {
        this.#fail("CODEX_PREFERENCES_FAILED");
        return this.status();
      }
      this.#current = await driver.currentVersion().catch(() => null);
      this.#checkedAt = new Date(this.#now()).toISOString();
      if (!this.#current || !/^\d+(?:\.\d+)+$/u.test(this.#current)) {
        this.#fail("CODEX_VERSION_UNAVAILABLE");
        return this.status();
      }
      try {
        this.#latest = await driver.latestVersion(this.#current);
      } catch {
        this.#fail("CODEX_APPCAST_FAILED");
        return this.status();
      }
      if (!this.options.catalog.verified(this.#latest)) this.#phase = "waiting-compatibility";
      else if (compareCodexVersions(this.#latest, this.#current) <= 0) this.#phase = "up-to-date";
      else {
        this.#phase = "downloading";
        this.#stageAt = this.#now();
        try {
          if (this.#stopped) return this.status();
          await driver.writeAutoUpdate(true);
          await driver.requestCheck();
        } catch {
          this.#fail("CODEX_UPDATE_CHECK_FAILED");
          await this.#disarm();
        }
      }
      return this.status();
    });
  }
  tick(): Promise<CodexUpdateStatus> {
    return this.#serial(async () => {
      if (this.#initialized && this.#settings.enabled && ACTIVE.has(this.#phase))
        await this.#advance();
      return this.status();
    });
  }
  #fail(error: Exclude<CodexUpdateError, null>) {
    this.#phase = "failed";
    this.#error = error;
    this.#idleSince = null;
  }
  async #disarm() {
    try {
      await this.options.driver?.writeAutoUpdate(false);
    } catch {
      this.#fail("CODEX_PREFERENCES_FAILED");
    }
  }
  async #advance(): Promise<void> {
    const driver = this.options.driver;
    if (!driver || !this.#latest) return;
    if (this.#stopped) {
      await this.#disarm();
      return;
    }
    try {
      if (
        !this.options.catalog.verified(this.#latest) &&
        this.#phase !== "installing" &&
        this.#phase !== "health-check"
      ) {
        await this.#disarm();
        this.#phase = "waiting-compatibility";
        return;
      }
      if (this.#phase === "downloading" || this.#phase === "waiting-idle") {
        if (this.#now() - this.#stageAt > (this.options.downloadTimeoutMs ?? 30 * 60_000)) {
          this.#fail("CODEX_DOWNLOAD_TIMEOUT");
          await this.#disarm();
          return;
        }
        if (!(await driver.downloadReady(this.#latest))) {
          this.#phase = "downloading";
          this.#idleSince = null;
          return;
        }
        this.#phase = "waiting-idle";
        // Fresh false heartbeats throughout the interval; unknown/stale/busy resets the gate.
        if ((await this.options.busy()) !== false) {
          this.#idleSince = null;
          return;
        }
        this.#idleSince ??= this.#now();
        if (this.#now() - this.#idleSince < (this.options.idleMs ?? 15_000)) return;
        // Re-query immediately before quit: Sparkle must never install a newer, unverified target.
        if ((await driver.latestVersion(this.#current ?? "")) !== this.#latest) {
          this.#fail("CODEX_UPDATE_TARGET_CHANGED");
          await this.#disarm();
          return;
        }
        if ((await this.options.busy()) !== false) {
          this.#idleSince = null;
          return;
        }
        if (this.#stopped) {
          await this.#disarm();
          return;
        }
        await this.#recordSession();
        await driver.quit();
        this.#phase = "installing";
        this.#stageAt = this.#now();
        return;
      }
      if (this.#phase === "installing") {
        if (this.#now() - this.#stageAt > (this.options.installTimeoutMs ?? 5 * 60_000)) {
          this.#fail("CODEX_INSTALL_TIMEOUT");
          await this.#disarm();
          return;
        }
        if (!(await driver.installationStopped())) return;
        const installed = await driver.currentVersion();
        if (installed !== this.#latest) return;
        this.#current = installed;
        await this.options.catalog.publishPolicy(installed);
        await this.#disarm();
        if (this.#error) return;
        if (this.#stopped) return;
        if (!(await driver.reopen())) {
          this.#fail("CODEX_REOPEN_FAILED");
          return;
        }
        await fs.rm(this.#sessionFile(), { force: true });
        this.#phase = "health-check";
        this.#stageAt = this.#now();
        return;
      }
      if (this.#phase === "health-check") {
        if (await driver.healthy()) {
          this.#phase = "up-to-date";
          return;
        }
        if (this.#now() - this.#stageAt > 60_000) this.#fail("CODEX_HEALTH_FAILED");
      }
    } catch {
      this.#fail("CODEX_UPDATE_CHECK_FAILED");
      await this.#disarm();
    }
  }
}
