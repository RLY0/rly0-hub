import { codexHeartbeatAfter } from "../rly0-maintenance/backend-reload-channel.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { compareCodexVersions, type CodexUpdateSettings } from "@codexhost/shared-contracts";
import type { CodexCompatibilityCatalog } from "./codex-compat.js";
import type { Rly0HubStateStore } from "./hub-state.js";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

export interface CodexCheckPreferences {
  automaticChecks: boolean | null;
  lastCheckTime: string | null;
}
export interface CodexUpdateDriver {
  acquireControl?(): Promise<() => Promise<void>>;
  watchLease(file: string, id: string, exited?: () => void): Promise<void>;
  feedIdentity?(): string | null;
  installableVersions?(): string[];
  readAutoUpdate(): Promise<boolean | null>;
  writeAutoUpdate(value: boolean | null): Promise<void>;
  currentVersion(): Promise<string | null>;
  latestVersion(current: string): Promise<string>;
  readCheckPreferences(): Promise<CodexCheckPreferences>;
  restoreCheckPreferences(value: CodexCheckPreferences): Promise<void>;
  /** Prepare the next launch for a scheduled background check; never click a menu. */
  requestCheck(): Promise<void>;
  availableVersions?(current: string): Promise<string[]>;
  downloadReady(version: string, revalidate?: boolean): Promise<boolean>;
  /** No force kill: saves Codex state through its own normal quit. */
  quit(): Promise<void>;
  /** True only when Desktop and its Sparkle Autoupdate have exited. */
  installationStopped(): Promise<boolean>;
  isRunning(): Promise<boolean>;
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
const UPDATE_ERRORS = [
  "CODEX_PREFERENCES_FAILED",
  "CODEX_APPCAST_FAILED",
  "CODEX_VERSION_UNAVAILABLE",
  "CODEX_UPDATE_CHECK_FAILED",
  "CODEX_DOWNLOAD_TIMEOUT",
  "CODEX_INSTALL_TIMEOUT",
  "CODEX_UPDATE_TARGET_CHANGED",
  "CODEX_REOPEN_FAILED",
  "CODEX_HEALTH_FAILED",
  "CODEX_STATE_FAILED",
] as const;
export type CodexUpdateError = (typeof UPDATE_ERRORS)[number] | null;
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
/** Replace this driver when the agreed idle definition changes; all quit checks use it. */
export type CodexIdleDriver = () => Promise<boolean>;
export function codexIdleFromBusy(busy: () => Promise<boolean | null>): CodexIdleDriver {
  return async () => (await busy()) === false;
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
  #target: string | null = null;
  #candidates: string[] = [];
  #error: CodexUpdateError = null;
  #checkedAt: string | null = null;
  #stageAt = 0;
  #idleSince: number | null = null;
  #initialized = false;
  #armed = false;
  #leaseId = randomUUID();
  #controlReady = false;
  #releaseControl: (() => Promise<void>) | undefined;
  #staged = false;
  #backgroundStarted = false;
  #closedByHub = false;
  #quitReason: "background" | "install" | "recovery" = "install";
  #retryAt = 0;
  #retryStatus: { phase: "failed" | "up-to-date"; error: CodexUpdateError } = {
    phase: "failed",
    error: "CODEX_DOWNLOAD_TIMEOUT",
  };
  #failures = 0;
  #timeouts = 0;
  #suspendedFeed: string | null = null;
  #feed: string | null = null;
  #leaseTimer: ReturnType<typeof setInterval> | undefined;
  #renewing: Promise<void> | undefined;
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
      idle?: CodexIdleDriver;
      now?: () => number;
      idleMs?: number;
      downloadTimeoutMs?: number;
      installTimeoutMs?: number;
    },
  ) {}
  #idle(): Promise<boolean> {
    return (this.options.idle ?? codexIdleFromBusy(this.options.busy))();
  }
  async #saveAttempt() {
    if (this.#phase === "failed" || this.#phase === "up-to-date")
      this.#retryStatus = { phase: this.#phase, error: this.#error };
    await this.#writeRecord(this.#attemptFile(), {
      retryAt: this.#retryAt,
      failures: this.#failures,
      timeouts: this.#timeouts,
      suspendedFeed: this.#suspendedFeed,
      feed: this.#feed,
      phase: this.#phase,
      error: this.#error,
    });
  }
  #sessionFile() {
    return path.join(resolveRly0DataDir(this.options.environment), "codex-update-session.json");
  }
  async #writeRecord(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async #recordSession() {
    await this.#writeRecord(this.#sessionFile(), {
      target: this.#target ?? this.#latest,
      at: this.#now(),
      closedByHub: true,
    });
  }
  #leaseFile() {
    return path.join(resolveRly0DataDir(this.options.environment), "codex-update-armed.json");
  }
  #attemptFile() {
    return path.join(resolveRly0DataDir(this.options.environment), "codex-update-attempt.json");
  }
  async #lease() {
    await this.#writeRecord(this.#leaseFile(), {
      id: this.#leaseId,
      pid: process.pid,
      at: this.#now(),
      target: this.#target ?? this.#latest,
      checkPreferences: this.#settings.originalCheckPreferences,
    });
  }
  async #arm() {
    const driver = this.options.driver;
    if (!driver) throw new Error("CODEX_UPDATE_UNSUPPORTED");
    if (!this.#armed) {
      // Do not take a lease away from another live Hub, even one sharing this directory.
      const existing = await fs
        .readFile(this.#leaseFile(), "utf8")
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (existing) {
        const lease = JSON.parse(existing);
        if (lease.id !== this.#leaseId && Number.isSafeInteger(lease.pid) && lease.pid > 0) {
          let alive = false;
          try {
            process.kill(lease.pid, 0);
            alive = true;
          } catch {
            /* exited */
          }
          if (alive) throw new Error("CODEX_UPDATE_OWNER_BUSY");
        }
      }
      this.#leaseId = randomUUID();
    }
    await this.#lease(); // Durable lease BEFORE opening the preference, not after it.
    if (!this.#armed)
      await driver.watchLease(this.#leaseFile(), this.#leaseId, () => {
        this.#armed = false;
      });
    this.#armed = true;
    this.#leaseTimer ??= setInterval(() => {
      if (!this.#armed || this.#renewing) return;
      this.#renewing = this.#lease()
        .catch(() => {
          this.#armed = false;
        })
        .finally(() => {
          this.#renewing = undefined;
        });
    }, 2000);
    this.#leaseTimer.unref();
    await driver.writeAutoUpdate(true);
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
    this.#releaseControl ??= await this.options.driver.acquireControl?.();
    this.#controlReady = true;
    if (this.#settings.enabled) {
      // Persist the original before the first side effect. An absent preference is preserved as null.
      if (this.#settings.originalAutoUpdate === undefined) {
        this.#settings = {
          ...this.#settings,
          originalAutoUpdate: await this.options.driver.readAutoUpdate(),
        };
        await this.options.state.update({ codexUpdates: this.#settings });
      }
      // Also restores scheduled-check preferences interrupted by a Hub crash.
      await this.#disarm();
      try {
        const attempt = JSON.parse(await fs.readFile(this.#attemptFile(), "utf8"));
        if (Number.isFinite(attempt.retryAt) && attempt.retryAt > this.#now()) {
          this.#retryAt = Math.min(attempt.retryAt, this.#now() + 24 * 60 * 60_000);
          this.#retryStatus = {
            phase: attempt.phase === "up-to-date" ? "up-to-date" : "failed",
            error:
              attempt.phase === "up-to-date"
                ? null
                : (UPDATE_ERRORS.find((error) => error === attempt.error) ??
                  "CODEX_DOWNLOAD_TIMEOUT"),
          };
          this.#phase = this.#retryStatus.phase;
          this.#error = this.#retryStatus.error;
        }
        if (Number.isSafeInteger(attempt.failures) && attempt.failures >= 0)
          this.#failures = attempt.failures;
        if (Number.isSafeInteger(attempt.timeouts) && attempt.timeouts >= 0)
          this.#timeouts = attempt.timeouts;
        if (typeof attempt.suspendedFeed === "string") this.#suspendedFeed = attempt.suspendedFeed;
        if (typeof attempt.feed === "string") this.#feed = attempt.feed;
      } catch {
        /* No attempt history. */
      }
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
          this.#now() - record.at < 5 * 60_000 &&
          !(await codexHeartbeatAfter(resolveRly0DataDir(this.options.environment), record.at)) &&
          "closedByHub" in record &&
          record.closedByHub === true
        ) {
          this.#latest = record.target;
          this.#target = record.target;
          this.#current = await this.options.driver.currentVersion().catch(() => null);
          this.#closedByHub = true;
          this.#quitReason = "recovery";
          this.#phase = "installing";
          this.#stageAt = this.#now();
        } else {
          await fs.rm(this.#sessionFile(), { force: true });
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
      if (ACTIVE.has(this.#phase) || this.#closedByHub) void this.tick();
    }, 2000);
    this.#timer.unref();
    return this.check();
  }
  stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    return this.#serial(async () => {
      if (ACTIVE.has(this.#phase) || this.#armed) await this.#disarm();
      await this.#recoverClosed();
      await this.#releaseControl?.();
      this.#releaseControl = undefined;
      this.#controlReady = false;
      this.#initialized = false;
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
          await this.#restoreCheckPreferences();
          this.#armed = false;
          clearInterval(this.#leaseTimer);
          this.#leaseTimer = undefined;
          await this.#renewing;
          await fs.rm(this.#leaseFile(), { force: true });
          await this.#recoverClosed();
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
      try {
        await this.options.catalog.refresh();
        const observed = await (
          this.options.currentVersion ?? this.options.driver?.currentVersion
        )?.().catch(() => null);
        if (observed) this.#current = observed;
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
        if (this.#closedByHub) {
          await this.#recoverClosed();
          return this.status();
        }
        if (this.#now() < this.#retryAt && !this.#suspendedFeed) {
          this.#phase = this.#retryStatus.phase;
          this.#error = this.#retryStatus.error;
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
        const nextFeed = driver.feedIdentity?.() ?? this.#latest;
        if (this.#feed && this.#feed !== nextFeed) this.#timeouts = 0;
        this.#feed = nextFeed;
        if (this.#suspendedFeed === this.#feed) {
          this.#phase = "failed";
          this.#error = "CODEX_DOWNLOAD_TIMEOUT";
          return this.status();
        }
        if (this.#suspendedFeed) {
          this.#suspendedFeed = null;
          this.#timeouts = 0;
          this.#retryAt = 0;
          await this.#saveAttempt();
        }
        if (!this.options.catalog.verified(this.#latest)) this.#phase = "waiting-compatibility";
        else if (compareCodexVersions(this.#latest, this.#current) <= 0) this.#phase = "up-to-date";
        else if (
          driver
            .installableVersions?.()
            .every((version) => compareCodexVersions(version, this.#current ?? "0.0") <= 0)
        ) {
          this.#phase = "up-to-date";
        } else {
          this.#phase = "downloading";
          this.#stageAt = this.#now();
          this.#backgroundStarted = false;
          this.#staged = false;
          this.#target = null;
          this.#candidates = (await driver.availableVersions?.(this.#current)) ?? [this.#latest];
          if (!this.#candidates.includes(this.#latest)) this.#candidates.push(this.#latest);
          await this.#advance();
        }
      } catch {
        this.#fail("CODEX_UPDATE_CHECK_FAILED");
        await this.#disarm();
        await this.#recoverClosed();
      }
      return this.status();
    });
  }
  tick(): Promise<CodexUpdateStatus> {
    return this.#serial(async () => {
      try {
        if (this.#initialized && this.#settings.enabled && ACTIVE.has(this.#phase))
          await this.#advance();
        else if (this.#closedByHub) await this.#recoverClosed();
      } catch {
        this.#fail("CODEX_UPDATE_CHECK_FAILED");
        await this.#disarm();
        await this.#recoverClosed();
      }
      return this.status();
    });
  }
  #fail(error: Exclude<CodexUpdateError, null>) {
    this.#phase = "failed";
    this.#error = error;
    if (error === "CODEX_DOWNLOAD_TIMEOUT" && ++this.#timeouts >= 3)
      this.#suspendedFeed = this.#feed ?? this.#latest;
    this.#idleSince = null;
    this.#retryAt =
      this.#now() + Math.min(24, 6 * 2 ** Math.min(this.#failures++, 2)) * 60 * 60_000;
  }
  async #restoreCheckPreferences() {
    if (this.#settings.originalCheckPreferences) {
      await this.options.driver?.restoreCheckPreferences(this.#settings.originalCheckPreferences);
      const settings = { ...this.#settings };
      delete settings.originalCheckPreferences;
      await this.options.state.update({ codexUpdates: settings });
      this.#settings = settings;
    }
  }
  async #recoverClosed() {
    if (!this.#closedByHub || !this.options.driver) return;
    try {
      if (await this.options.driver.isRunning()) {
        // Quit was cancelled/lost, or Sparkle already relaunched it. Never reopen a later user quit.
        this.#closedByHub = false;
        await fs.rm(this.#sessionFile(), { force: true });
        return;
      }
      if (!(await this.options.driver.installationStopped())) return;
      // Recovery is required even when disarming failed. Never strand an app we closed.
      if (!(await this.options.driver.reopen())) {
        this.#fail("CODEX_REOPEN_FAILED");
        return;
      }
      this.#closedByHub = false;
      await fs.rm(this.#sessionFile(), { force: true });
    } catch {
      this.#fail("CODEX_REOPEN_FAILED");
    }
  }
  async #disarm() {
    if (!this.#controlReady) return;
    try {
      this.#armed = false;
      clearInterval(this.#leaseTimer);
      this.#leaseTimer = undefined;
      await this.#renewing;
      await this.options.driver?.writeAutoUpdate(false);
      await fs.rm(this.#leaseFile(), { force: true });
      await this.#restoreCheckPreferences();
      if (this.#phase === "failed") await this.#saveAttempt();
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
      if (this.#armed) await this.#lease();
      else if (this.#backgroundStarted && this.#phase === "downloading") await this.#arm();
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
        if (!this.#staged) {
          // Observe Sparkle's actual signed choice; OS and rollout eligibility are its decision.
          for (const candidate of this.#candidates) {
            if (
              compareCodexVersions(candidate, this.#current ?? "0.0") <= 0 ||
              !this.options.catalog.verified(candidate)
            )
              continue;
            if (await driver.downloadReady(candidate)) {
              this.#target = candidate;
              this.#staged = true;
              break;
            }
          }
        }
        this.#phase = this.#staged || !this.#backgroundStarted ? "waiting-idle" : "downloading";
        // Download time excludes the unlimited wait for fresh idle heartbeats.
        if (!this.#staged && this.#backgroundStarted) {
          if (this.#now() - this.#stageAt > (this.options.downloadTimeoutMs ?? 30 * 60_000)) {
            this.#fail("CODEX_DOWNLOAD_TIMEOUT");
            await this.#disarm();
          }
          return;
        }
        if (!(await this.#idle())) {
          this.#idleSince = null;
          return;
        }
        this.#idleSince ??= this.#now();
        if (this.#now() - this.#idleSince < (this.options.idleMs ?? 15_000)) return;
        if (
          compareCodexVersions(await driver.latestVersion(this.#current ?? ""), this.#latest) !== 0
        ) {
          this.#fail("CODEX_UPDATE_TARGET_CHANGED");
          await this.#disarm();
          return;
        }
        // Sparkle selects using OS/rollout rules unavailable to Hub. Conservatively require
        // every newer feed candidate verified, not only the numerically greatest version.
        const candidates = await driver.availableVersions?.(this.#current ?? "");
        if (
          this.#staged &&
          candidates &&
          !candidates.some(
            (version) => compareCodexVersions(version, this.#target ?? this.#latest ?? "0.0") === 0,
          )
        ) {
          this.#fail("CODEX_UPDATE_TARGET_CHANGED");
          await this.#disarm();
          return;
        }
        if (
          candidates?.some(
            (v) =>
              compareCodexVersions(v, this.#current ?? "0.0") > 0 &&
              !this.options.catalog.verified(v),
          )
        ) {
          await this.#disarm();
          this.#phase = "waiting-compatibility";
          return;
        }
        if (!(await this.#idle()) || this.#stopped) {
          this.#idleSince = null;
          return;
        }
        if (!this.#staged) {
          // Persist backoff BEFORE a restart so a crash cannot cause a restart loop.
          this.#retryAt = this.#now() + 6 * 60 * 60_000;
          await this.#saveAttempt();
          if (!this.#settings.originalCheckPreferences) {
            this.#settings = {
              ...this.#settings,
              originalCheckPreferences: await driver.readCheckPreferences(),
            };
            await this.options.state.update({ codexUpdates: this.#settings });
          }
          await this.#arm();
          await driver.requestCheck();
          this.#quitReason = "background";
          this.#backgroundStarted = true;
        } else {
          // Recheck cache identity before quitting; driver caches successful codesign per fingerprint.
          if (!(await driver.downloadReady(this.#target ?? this.#latest, true))) {
            this.#staged = false;
            this.#idleSince = null;
            return;
          }
          await this.#arm();
          this.#quitReason = "install";
        }
        // Check again after command / filesystem awaits, immediately before normal quit.
        if (!(await this.#idle()) || this.#stopped) {
          await this.#disarm();
          this.#backgroundStarted = false;
          this.#idleSince = null;
          return;
        }
        await this.#recordSession();
        this.#closedByHub = true; // quit may succeed even if its reply is lost.
        await driver.quit();
        this.#phase = "installing";
        this.#stageAt = this.#now();
        this.#idleSince = null;
        return;
      }
      if (this.#phase === "installing") {
        if (this.#now() - this.#stageAt >= 30_000 && (await driver.isRunning())) {
          this.#closedByHub = false;
          await fs.rm(this.#sessionFile(), { force: true });
          const installed = await driver.currentVersion();
          if (installed && compareCodexVersions(installed, this.#target ?? this.#latest) === 0) {
            this.#current = installed;
            await this.options.catalog.publishPolicy(installed);
            await this.#disarm();
            if (!this.#error) {
              this.#phase = "health-check";
              this.#stageAt = this.#now();
            }
            return;
          }
          this.#fail("CODEX_INSTALL_TIMEOUT");
          await this.#disarm();
          return;
        }
        if (this.#now() - this.#stageAt > (this.options.installTimeoutMs ?? 5 * 60_000)) {
          this.#fail("CODEX_INSTALL_TIMEOUT");
          await this.#disarm();
          await this.#recoverClosed();
          return;
        }
        if (!(await driver.installationStopped())) return;
        const installed = await driver.currentVersion();
        if (installed && compareCodexVersions(installed, this.#target ?? this.#latest) === 0) {
          this.#current = installed;
          await this.options.catalog.publishPolicy(installed);
          await this.#disarm();
          await this.#recoverClosed();
          if (this.#error || this.#closedByHub) return;
          this.#phase = "health-check";
          this.#stageAt = this.#now();
          return;
        }
        if (this.#quitReason === "background") {
          await this.#recoverClosed();
          if (this.#error || this.#closedByHub) {
            await this.#disarm();
            return;
          }
          this.#phase = "downloading";
          this.#stageAt = this.#now();
          return;
        }
        if (this.#quitReason === "recovery") {
          this.#fail("CODEX_INSTALL_TIMEOUT");
          await this.#recoverClosed();
        }
        return;
      }
      if (this.#phase === "health-check") {
        if (await driver.healthy()) {
          this.#phase = "up-to-date";
          this.#failures = 0;
          this.#timeouts = 0;
          this.#suspendedFeed = null;
          if (
            !this.#current ||
            !this.#latest ||
            compareCodexVersions(this.#current, this.#latest) >= 0
          ) {
            this.#retryAt = 0;
            await fs.rm(this.#attemptFile(), { force: true });
          } else {
            // A rollout/OS-selected lower version is success, not permission to restart every 5 min.
            this.#retryAt = this.#now() + 6 * 60 * 60_000;
            await this.#saveAttempt();
          }
          return;
        }
        if (this.#now() - this.#stageAt > 60_000) this.#fail("CODEX_HEALTH_FAILED");
      }
    } catch {
      this.#fail("CODEX_UPDATE_CHECK_FAILED");
      await this.#disarm();
      await this.#recoverClosed();
    }
  }
}
