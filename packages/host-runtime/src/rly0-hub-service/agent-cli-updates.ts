import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import {
  agentCliUpdateEntrySchema,
  agentCliUpdateIdSchema,
  type AgentCliUpdateEntry,
  type AgentCliUpdateError,
  type AgentCliUpdateId,
  type AgentCliUpdateStatus,
} from "@codexhost/shared-contracts";
import { newerInstallationVersion } from "@codexhost/harness-discovery";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import {
  acquireAgentCliFence,
  cleanAgentCliFences,
  type CliOwnerProbe,
} from "../rly0-agents/cli-update-admission.js";
import { agentCliPlanSchema, type AgentCliUpdateDriver } from "./agent-cli-update-driver.js";

export const AGENT_CLI_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const pendingSchema = z.strictObject({
  plan: agentCliPlanSchema,
  previous: z.string(),
  target: z.string(),
  baselineReady: z.boolean().default(false),
  quarantine: z.boolean().default(false),
});
type PendingUpdate = z.infer<typeof pendingSchema>;
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  agents: z.array(agentCliUpdateEntrySchema),
  pending: z.partialRecord(agentCliUpdateIdSchema, pendingSchema),
});
const initial = (agent: AgentCliUpdateId): AgentCliUpdateEntry => ({
  agent,
  currentVersion: null,
  latestVersion: null,
  previousVersion: null,
  recoveryPending: false,
  lastCheckedAt: null,
  lastUpdatedAt: null,
  phase: "idle",
  result: null,
  errorCode: null,
  causeCode: null,
  badVersions: [],
  installKind: "unknown",
  canUpdate: false,
});
function code(error: unknown, fallback: AgentCliUpdateError): AgentCliUpdateError {
  const message = error instanceof Error ? error.message : "";
  if (message === "COMMAND_PERMISSION_DENIED") return "PERMISSION_DENIED";
  if (message === "COMMAND_FILE_IN_USE") return "INSTALL_FILE_BUSY";
  if (
    message === "Harness command timed out" ||
    message === "COMMAND_TIMEOUT" ||
    (error instanceof Error && error.name === "TimeoutError")
  )
    return fallback === "INSTALL_FAILED" ? "INSTALL_TIMEOUT" : "CHECK_TIMEOUT";
  if (
    [
      "HOST_UNAVAILABLE",
      "INTERRUPTED",
      "STATE_WRITE_FAILED",
      "ORIGINAL_INSTALLER",
      "COMMAND_TREE_STOP_FAILED",
      "BUSY",
    ].includes(message)
  )
    return message as AgentCliUpdateError;
  return fallback;
}

/** One transaction stream per data directory; every external effect is driver-owned. */
export class AgentCliUpdates {
  readonly #options: {
    environment: NodeJS.ProcessEnv;
    driver: AgentCliUpdateDriver;
    now?: () => number;
    ownerProbe?: CliOwnerProbe;
  };
  readonly #file: string;
  readonly #entries = new Map<AgentCliUpdateId, AgentCliUpdateEntry>();
  readonly #pending = new Map<AgentCliUpdateId, PendingUpdate>();
  readonly #queue = new Map<AgentCliUpdateId, boolean>();
  #enabled = true;
  #switchWrites = 0;
  #switchRevision = 0;
  #loaded: Promise<void> | undefined;
  #saving: Promise<void> = Promise.resolve();
  #checking: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #nextDaily = 0;
  #queueWait = new AbortController();

  constructor(options: {
    environment: NodeJS.ProcessEnv;
    driver: AgentCliUpdateDriver;
    now?: () => number;
    ownerProbe?: CliOwnerProbe;
  }) {
    this.#options = options;
    this.#file = path.join(resolveRly0DataDir(options.environment), "agent-cli-updates.json");
    for (const agent of agentCliUpdateIdSchema.options) this.#entries.set(agent, initial(agent));
  }
  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
  async #stored() {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("STATE_INVALID");
    }
    try {
      return stateSchema.parse(JSON.parse(text));
    } catch {
      throw new Error("STATE_INVALID");
    }
  }
  async #refresh(): Promise<void> {
    const stored = await this.#stored();
    if (!stored) return;
    if (!this.#switchWrites) this.#enabled = stored.enabled;
    for (const entry of stored.agents) this.#entries.set(entry.agent, entry);
    this.#pending.clear();
    for (const [agent, pending] of Object.entries(stored.pending))
      this.#pending.set(agentCliUpdateIdSchema.parse(agent), pending);
    for (const entry of this.#entries.values()) {
      entry.recoveryPending = this.#pending.has(entry.agent);
      const pending = this.#pending.get(entry.agent);
      if (pending) entry.previousVersion = pending.previous;
    }
  }
  #load(): Promise<void> {
    return (this.#loaded ??= (async () => {
      // Clean abandoned fences even if disabled, already latest, blacklisted, or no journal exists.
      cleanAgentCliFences(this.#options.environment, this.#options.ownerProbe);
      await this.#refresh();
    })());
  }
  #fence(agent: string) {
    return acquireAgentCliFence(this.#options.environment, agent, this.#options.ownerProbe);
  }
  #save(agent?: AgentCliUpdateId, enabled?: boolean): Promise<void> {
    return this.#track(this.#saveNow(agent, enabled));
  }
  #saveNow(agent?: AgentCliUpdateId, enabled?: boolean): Promise<void> {
    const next = this.#saving.then(async () => {
      let release: (() => Promise<void>) | null = null;
      const temporary = `${this.#file}.${process.pid}.tmp`;
      try {
        for (let n = 0; !release && n < 100; n++) {
          release = await this.#fence("state");
          if (!release) await delay(10);
        }
        if (!release) throw new Error("STATE_WRITE_FAILED");
        const stored = await this.#stored();
        const state = stored ?? {
          schemaVersion: 1 as const,
          enabled: this.#enabled,
          agents: [...this.#entries.values()],
          pending: {} as z.infer<typeof stateSchema>["pending"],
        };
        const before = stored ? JSON.stringify(stored) : null;
        if (enabled !== undefined) state.enabled = enabled;
        if (agent) {
          const entry = this.#entries.get(agent);
          if (!entry) throw new Error("STATE_INVALID");
          entry.recoveryPending = this.#pending.has(agent);
          state.agents = state.agents
            .filter((e) => e.agent !== agent)
            .concat(entry)
            .sort(
              (a, b) =>
                agentCliUpdateIdSchema.options.indexOf(a.agent) -
                agentCliUpdateIdSchema.options.indexOf(b.agent),
            );
          const pending = this.#pending.get(agent);
          if (pending) state.pending[agent] = pending;
          else
            state.pending = Object.fromEntries(
              Object.entries(state.pending).filter(([id]) => id !== agent),
            );
        }
        if (!this.#switchWrites) this.#enabled = state.enabled;
        const text = JSON.stringify(state);
        if (text === before) return; // Deferred minute checks must not rewrite identical state.
        await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, this.#file);
      } catch {
        throw new Error("STATE_WRITE_FAILED");
      } finally {
        if (release) {
          await rm(temporary, { force: true }).catch(() => undefined);
          await release();
        }
      }
    });
    this.#saving = next.catch(() => undefined);
    return next;
  }
  async status(): Promise<AgentCliUpdateStatus> {
    await this.#load();
    if (!this.#checking) await this.#refresh();
    return structuredClone({
      enabled: this.#enabled,
      checking: !!this.#checking,
      intervalMs: AGENT_CLI_CHECK_INTERVAL_MS,
      agents: [...this.#entries.values()],
    });
  }
  async setEnabled(enabled: boolean): Promise<AgentCliUpdateStatus> {
    await this.#load();
    const old = this.#enabled;
    const revision = ++this.#switchRevision;
    this.#switchWrites++;
    this.#enabled = enabled;
    try {
      await this.#save(undefined, enabled);
    } catch (error) {
      if (revision === this.#switchRevision) this.#enabled = old;
      throw error;
    } finally {
      this.#switchWrites--;
    }
    if (enabled && !old && this.#timer) void this.check().catch(() => undefined);
    return this.status();
  }
  async requestCheck(agent?: AgentCliUpdateId): Promise<AgentCliUpdateStatus> {
    await this.#load();
    void this.check(agent).catch(() => undefined);
    return this.status();
  }
  /** Work that may still touch the data directory; stop() waits for all of it. */
  #inflight = new Set<Promise<unknown>>();
  #track<T>(work: Promise<T>): Promise<T> {
    this.#inflight.add(work);
    void work.finally(() => this.#inflight.delete(work)).catch(() => undefined);
    return work;
  }
  start(): Promise<void> {
    return this.#track(this.#start());
  }
  async #start(): Promise<void> {
    if (this.#timer) return;
    this.#stopped = false;
    if (this.#queueWait.signal.aborted) this.#queueWait = new AbortController();
    await this.#load();
    if (this.#stopped || this.#timer) return;
    void this.check().catch(() => undefined);
    this.#nextDaily = this.#now() + AGENT_CLI_CHECK_INTERVAL_MS;
    this.#timer = setInterval(() => {
      if (this.#checking) return;
      if (this.#now() >= this.#nextDaily) {
        this.#nextDaily = this.#now() + AGENT_CLI_CHECK_INTERVAL_MS;
        void this.check().catch(() => undefined);
      } else {
        const deferred = [...this.#entries.values()].filter(
          (entry) =>
            // A completed rollback must never become a minute-by-minute trial install loop.
            (entry.causeCode === null || entry.recoveryPending) &&
            (entry.result === "skipped-busy" ||
              entry.result === "skipped-not-ready" ||
              entry.errorCode === "HOST_UNAVAILABLE" ||
              entry.errorCode === "CHECK_TIMEOUT"),
        );
        void Promise.all(deferred.map((entry) => this.check(entry.agent, true))).catch(
          () => undefined,
        );
      }
    }, 60_000);
    this.#timer.unref?.();
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#queueWait.abort();
    this.#queue.clear();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#options.driver.cancel?.();
    await this.#checking;
    // A start still loading state, a check before its queue or a pending save must not write
    // into the data directory after stop() returns (the service removes it on uninstall/tests).
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight]);
  }
  /** Preserve manual requests arriving during another agent's check or a cached busy retry. */
  check(agent?: AgentCliUpdateId, cached = false): Promise<void> {
    return this.#track(this.#check(agent, cached));
  }
  async #check(agent?: AgentCliUpdateId, cached = false): Promise<void> {
    await this.#load();
    if (this.#stopped) return;
    for (const id of agent ? [agent] : agentCliUpdateIdSchema.options)
      this.#queue.set(id, this.#queue.has(id) ? !!this.#queue.get(id) && cached : cached);
    // Requests arriving while the coordinator is held elsewhere or being released stay queued.
    while (this.#queue.size && !this.#stopped) await this.#drainQueue();
  }
  #drainQueue(): Promise<void> {
    return (this.#checking ??= (async () => {
      let release: (() => Promise<void>) | null = null;
      let backoff = 250;
      while (!release && !this.#stopped) {
        release = await this.#fence("coordinator");
        if (!release) {
          await delay(backoff + Math.floor(Math.random() * backoff * 0.2), undefined, {
            signal: this.#queueWait.signal,
          }).catch((error: unknown) => {
            if (!this.#queueWait.signal.aborted) throw error;
          });
          backoff = Math.min(backoff * 2, 10_000);
        }
      }
      if (!release) return;
      try {
        await this.#refresh();
        while (this.#queue.size && !this.#stopped) {
          const next = this.#queue.entries().next().value;
          if (!next) break;
          this.#queue.delete(next[0]);
          await this.#checkOne(...next);
        }
      } finally {
        await release();
      }
    })().finally(() => {
      this.#checking = undefined;
    }));
  }
  async #checkOne(agent: AgentCliUpdateId, cached: boolean): Promise<void> {
    const entry = this.#entries.get(agent);
    if (!entry) throw new Error("STATE_INVALID");
    const driver = this.#options.driver;
    const finish = async (
      result: AgentCliUpdateEntry["result"],
      errorCode: AgentCliUpdateError | null = null,
    ) => {
      Object.assign(entry, { phase: "idle", result, errorCode });
      await this.#save(agent);
    };
    const interrupted = this.#pending.get(agent);
    if (!interrupted && !this.#enabled) {
      await finish("skipped-disabled", "DISABLED");
      return;
    }
    entry.phase = "checking";
    entry.errorCode = null;
    entry.causeCode = null;
    let release: (() => Promise<void>) | null = null;
    try {
      if (interrupted) {
        entry.previousVersion = interrupted.previous;
        release = await this.#fence(agent);
        if (!release) {
          await finish("skipped-busy", "BUSY");
          return;
        }
        // A restored or externally replaced CLI is never blindly reinstalled from a stale journal.
        const current = await driver.version(interrupted.plan).catch(() => null);
        entry.currentVersion = current;
        if (
          current === interrupted.previous ||
          (current !== null && current !== interrupted.target)
        ) {
          this.#pending.delete(agent);
          if (!interrupted.quarantine || !(await driver.ready(agent).catch(() => false)))
            entry.badVersions = entry.badVersions.filter((v) => v !== interrupted.target);
          entry.causeCode = "INTERRUPTED";
          await finish(
            current === interrupted.previous ? "recovered" : "failed",
            current === interrupted.previous ? null : "VERSION_MISMATCH",
          );
          return;
        }
        if (await driver.busy(agent, interrupted.plan, true, interrupted.target)) {
          await finish("skipped-busy", "BUSY");
          return;
        }
        entry.causeCode = "INTERRUPTED";
        if (
          current === interrupted.target &&
          !interrupted.quarantine &&
          !entry.badVersions.includes(interrupted.target) &&
          (await driver.ready(agent).catch(() => false))
        ) {
          this.#pending.delete(agent);
          entry.lastUpdatedAt = this.#now();
          await finish("recovered");
          return;
        }
      } else {
        if (!cached || entry.lastCheckedAt === null) entry.lastCheckedAt = this.#now();
        const installation = await driver.inspect(
          agent,
          cached && entry.latestVersion ? entry.latestVersion : undefined,
        );
        if (!installation) {
          Object.assign(entry, {
            currentVersion: null,
            latestVersion: null,
            canUpdate: false,
            installKind: "unknown",
          });
          await finish("skipped-not-installed", "NOT_INSTALLED");
          return;
        }
        Object.assign(entry, {
          currentVersion: installation.currentVersion,
          latestVersion: installation.latestVersion,
          installKind: installation.plan.kind,
          canUpdate: installation.canUpdate,
        });
        if (!installation.canUpdate) {
          await finish(
            installation.reason === "INSTALL_FILE_BUSY" ? "skipped-busy" : "skipped-unsupported",
            installation.reason,
          );
          return;
        }
        if (
          !installation.latestVersion ||
          !newerInstallationVersion(installation.currentVersion, installation.latestVersion)
        ) {
          await finish("up-to-date");
          return;
        }
        if (entry.badVersions.includes(installation.latestVersion)) {
          await finish("skipped-bad-version", "BAD_VERSION");
          return;
        }
        if (!this.#enabled || this.#stopped) {
          await finish("skipped-disabled", "DISABLED");
          return;
        }
        release = await this.#fence(agent);
        if (
          !release ||
          (await driver.busy(agent, installation.plan, true, installation.latestVersion))
        ) {
          await finish("skipped-busy", "BUSY");
          return;
        }
        if (!(await driver.ready(agent))) {
          await finish("skipped-not-ready", "BASELINE_NOT_READY");
          return;
        }
        if ((await driver.version(installation.plan)) !== installation.currentVersion) {
          await finish("failed", "PRE_UPDATE_VERSION_MISMATCH");
          return;
        }
        if (!this.#enabled || this.#stopped) {
          await finish("skipped-disabled", "DISABLED");
          return;
        }
        const pending: PendingUpdate = {
          plan: installation.plan,
          previous: installation.currentVersion,
          target: installation.latestVersion,
          baselineReady: true,
          quarantine: false,
        };
        entry.previousVersion = pending.previous;
        this.#pending.set(agent, pending);
        entry.phase = "updating";
        await this.#save(agent);
        if (!this.#enabled || this.#stopped) {
          this.#pending.delete(agent);
          await finish("skipped-disabled", "DISABLED");
          return;
        }
        let failure: AgentCliUpdateError | null = null;
        try {
          await driver.install(pending.plan, pending.target);
          entry.phase = "verifying";
          entry.currentVersion = await driver.version(pending.plan);
          if (entry.currentVersion !== pending.target) failure = "VERSION_MISMATCH";
          else if (!(await driver.ready(agent))) failure = "CONNECTION_NOT_READY";
        } catch (error) {
          failure = code(
            error,
            entry.phase === "updating" ? "INSTALL_FAILED" : "CONNECTION_NOT_READY",
          );
        }
        if (!failure) {
          const previousUpdatedAt = entry.lastUpdatedAt;
          this.#pending.delete(agent);
          entry.lastUpdatedAt = this.#now();
          try {
            await finish("updated");
            return;
          } catch {
            this.#pending.set(agent, pending);
            entry.lastUpdatedAt = previousUpdatedAt;
            failure = "STATE_WRITE_FAILED";
          }
        }
        entry.causeCode = failure;
        if (this.#stopped || failure === "COMMAND_TREE_STOP_FAILED") {
          await finish("failed", failure === "COMMAND_TREE_STOP_FAILED" ? failure : "INTERRUPTED");
          return;
        }
        // npm may exit nonzero without touching anything. Do not reinstall or quarantine it.
        entry.currentVersion = await driver.version(pending.plan).catch(() => null);
        if (entry.currentVersion === pending.previous) {
          this.#pending.delete(agent);
          if (failure === "BUSY") {
            // Nothing was installed or rolled back: a plain wait, retried every minute.
            entry.causeCode = null;
            await finish("skipped-busy", failure);
          } else await finish("failed", failure);
          return;
        }
        pending.quarantine = failure === "CONNECTION_NOT_READY" || failure === "VERSION_MISMATCH";
      }
      const pending = this.#pending.get(agent);
      if (!pending) throw new Error("STATE_INVALID");
      if (pending.quarantine && !entry.badVersions.includes(pending.target))
        entry.badVersions.push(pending.target);
      entry.phase = "rolling-back";
      let persistenceFailed = false;
      try {
        await this.#save(agent);
      } catch {
        persistenceFailed = true;
      }
      try {
        await driver.install(pending.plan, pending.previous);
      } catch (error) {
        if (code(error, "INSTALL_FAILED") === "BUSY") {
          await finish("skipped-busy", "BUSY");
          return;
        }
        if (this.#stopped || code(error, "INSTALL_FAILED") === "COMMAND_TREE_STOP_FAILED") {
          await finish("failed", code(error, "INTERRUPTED"));
          return;
        }
        // A failing rollback command can still have restored the original executable.
      }
      entry.currentVersion = await driver.version(pending.plan).catch(() => null);
      if (entry.currentVersion !== pending.previous) {
        await finish("failed", "ROLLBACK_FAILED");
        return;
      }
      // Once the saved version is back, never reinstall it on every restart because auth/Host failed.
      this.#pending.delete(agent);
      let restored = false;
      let connectionError: AgentCliUpdateError = "BASELINE_NOT_READY";
      try {
        restored = await driver.ready(agent);
      } catch (error) {
        connectionError = code(error, "HOST_UNAVAILABLE");
      }
      // The saved version failing the same check is environmental evidence, not a bad release.
      // Legacy journals default quarantine=false and never justify a persistent blacklist.
      if (!restored || !pending.quarantine)
        entry.badVersions = entry.badVersions.filter((v) => v !== pending.target);
      try {
        await finish(
          restored ? "rolled-back" : "failed",
          persistenceFailed ? "STATE_WRITE_FAILED" : restored ? entry.causeCode : connectionError,
        );
      } catch {
        this.#pending.set(agent, pending);
        throw new Error("STATE_WRITE_FAILED");
      }
    } catch (error) {
      const failure = code(error, "CHECK_FAILED");
      if (failure === "ORIGINAL_INSTALLER") entry.canUpdate = false;
      await finish(
        failure === "HOST_UNAVAILABLE" || failure === "CHECK_TIMEOUT"
          ? "skipped-not-ready"
          : failure === "ORIGINAL_INSTALLER"
            ? "skipped-unsupported"
            : "failed",
        failure,
      );
    } finally {
      await release?.();
    }
  }
}
