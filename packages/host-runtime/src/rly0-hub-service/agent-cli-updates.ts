import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { acquireAgentCliFence, fenceOwnerAlive } from "../rly0-agents/cli-update-admission.js";
import { agentCliPlanSchema, type AgentCliUpdateDriver } from "./agent-cli-update-driver.js";

export const AGENT_CLI_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const pendingSchema = z.strictObject({
  plan: agentCliPlanSchema,
  previous: z.string(),
  target: z.string(),
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
  if (message === "HOST_UNAVAILABLE") return "HOST_UNAVAILABLE";
  if (message === "STATE_WRITE_FAILED") return "STATE_WRITE_FAILED";
  return fallback;
}

/** One serialized transaction stream; commands, network and Host observations are all drivers. */
export class AgentCliUpdates {
  readonly #options: {
    environment: NodeJS.ProcessEnv;
    driver: AgentCliUpdateDriver;
    now?: () => number;
    ownerAlive?: (agent: AgentCliUpdateId) => Promise<boolean>;
  };
  readonly #file: string;
  readonly #entries = new Map<AgentCliUpdateId, AgentCliUpdateEntry>();
  readonly #pending = new Map<AgentCliUpdateId, PendingUpdate>();
  #enabled = true;
  #loaded: Promise<void> | undefined;
  #saving: Promise<void> = Promise.resolve();
  #checking: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #nextDaily = 0;

  constructor(options: {
    environment: NodeJS.ProcessEnv;
    driver: AgentCliUpdateDriver;
    now?: () => number;
    ownerAlive?: (agent: AgentCliUpdateId) => Promise<boolean>;
  }) {
    this.#options = options;
    this.#file = path.join(resolveRly0DataDir(options.environment), "agent-cli-updates.json");
    for (const agent of agentCliUpdateIdSchema.options) this.#entries.set(agent, initial(agent));
  }
  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
  #load(): Promise<void> {
    return (this.#loaded ??= (async () => {
      let text: string;
      try {
        text = await readFile(this.#file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error("STATE_INVALID");
      }
      try {
        const stored = stateSchema.parse(JSON.parse(text));
        this.#enabled = stored.enabled;
        for (const entry of stored.agents) this.#entries.set(entry.agent, entry);
        for (const [agent, pending] of Object.entries(stored.pending))
          this.#pending.set(agentCliUpdateIdSchema.parse(agent), pending);
      } catch {
        throw new Error("STATE_INVALID");
      }
    })());
  }
  #save(): Promise<void> {
    const text = JSON.stringify({
      schemaVersion: 1,
      enabled: this.#enabled,
      agents: [...this.#entries.values()],
      pending: Object.fromEntries(this.#pending),
    });
    const next = this.#saving.then(async () => {
      const temporary = `${this.#file}.${process.pid}.tmp`;
      try {
        await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, this.#file);
      } catch {
        throw new Error("STATE_WRITE_FAILED");
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.#saving = next.catch(() => undefined);
    return next;
  }
  async status(): Promise<AgentCliUpdateStatus> {
    await this.#load();
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
    this.#enabled = enabled;
    try {
      await this.#save();
    } catch (error) {
      this.#enabled = old;
      throw error;
    }
    if (enabled && !old && this.#timer) void this.check().catch(() => undefined);
    return this.status();
  }
  /** RPC starts work and returns promptly; status is the polling endpoint. */
  async requestCheck(agent?: AgentCliUpdateId): Promise<AgentCliUpdateStatus> {
    await this.#load();
    void this.check(agent).catch(() => undefined);
    return this.status();
  }
  async start(): Promise<void> {
    if (this.#timer) return;
    this.#stopped = false;
    await this.#load();
    if (this.#stopped || this.#timer) return;
    void this.check().catch(() => undefined);
    this.#nextDaily = this.#now() + AGENT_CLI_CHECK_INTERVAL_MS;
    // Deferred busy/Host-unavailable work is retried without re-fetching a fresh npm version.
    this.#timer = setInterval(() => {
      if (this.#checking) return;
      if (this.#now() >= this.#nextDaily) {
        this.#nextDaily = this.#now() + AGENT_CLI_CHECK_INTERVAL_MS;
        void this.check().catch(() => undefined);
      } else {
        const deferred = [...this.#entries.values()].filter(
          (entry) => entry.result === "skipped-busy" || entry.errorCode === "HOST_UNAVAILABLE",
        );
        void (async () => {
          for (const entry of deferred) await this.check(entry.agent, true);
        })().catch(() => undefined);
      }
    }, 60_000);
    this.#timer.unref?.();
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#checking;
  }
  /** Concurrent startup/manual checks coalesce, including calls for different agents. */
  async check(agent?: AgentCliUpdateId, cached = false): Promise<void> {
    await this.#load();
    if (this.#checking) return this.#checking;
    if (this.#stopped) return;
    const operation = async () => {
      for (const id of agent ? [agent] : agentCliUpdateIdSchema.options) {
        if (this.#stopped) break;
        await this.#checkOne(id, cached);
      }
    };
    this.#checking = operation().finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }
  async #checkOne(agent: AgentCliUpdateId, cached: boolean): Promise<void> {
    const entry = this.#entries.get(agent);
    if (!entry) throw new Error("STATE_INVALID");
    const previousUpdatedAt = entry.lastUpdatedAt;
    const driver = this.#options.driver;
    const finish = async (
      result: AgentCliUpdateEntry["result"],
      errorCode: AgentCliUpdateError | null = null,
    ) => {
      Object.assign(entry, { phase: "idle", result, errorCode });
      await this.#save();
    };
    // An interrupted transaction restores the saved version even if the switch was turned off.
    // Do not throw away its journal or treat the half-installed CLI as a new rollback baseline.
    const interrupted = this.#pending.get(agent);
    if (!interrupted && !this.#enabled) {
      await finish("skipped-disabled", "DISABLED");
      return;
    }
    entry.phase = "checking";
    entry.errorCode = null;
    entry.causeCode = null;
    let release: (() => Promise<void>) | null = null;
    const ownerAlive = () =>
      this.#options.ownerAlive?.(agent) ?? fenceOwnerAlive(this.#options.environment, agent);
    try {
      if (interrupted) {
        if (await ownerAlive()) {
          await finish("skipped-busy", "BUSY");
          return;
        }
        // Only a dead owner's fence is reclaimed, and only with a saved rollback journal.
      }
      if (!interrupted) {
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
          await finish("skipped-unsupported", installation.reason);
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
        release = await acquireAgentCliFence(this.#options.environment, agent);
        if (!release) {
          await finish("skipped-busy", "BUSY");
          return;
        }
        if (await driver.busy(agent)) {
          await finish("skipped-busy", "BUSY");
          return;
        }
        if (!this.#enabled || this.#stopped) {
          await finish("skipped-disabled", "DISABLED");
          return;
        }
        // Revalidate the original version after admission; never overwrite an external update.
        if ((await driver.version(installation.plan)) !== installation.currentVersion) {
          await finish("failed", "VERSION_MISMATCH");
          return;
        }
        this.#pending.set(agent, {
          plan: installation.plan,
          previous: installation.currentVersion,
          target: installation.latestVersion,
        });
        entry.phase = "updating";
        await this.#save(); // Write-ahead journal must succeed before any install.
        if (!this.#enabled || this.#stopped) {
          this.#pending.delete(agent);
          await finish("skipped-disabled", "DISABLED");
          return;
        }
        let failure: AgentCliUpdateError | null = null;
        try {
          await driver.install(installation.plan, installation.latestVersion);
          entry.phase = "verifying";
          entry.currentVersion = await driver.version(installation.plan);
          if (entry.currentVersion !== installation.latestVersion) failure = "VERSION_MISMATCH";
          else if (!(await driver.ready(agent))) failure = "CONNECTION_NOT_READY";
        } catch (error) {
          failure = code(
            error,
            entry.phase === "updating" ? "INSTALL_FAILED" : "CONNECTION_NOT_READY",
          );
        }
        if (!failure) {
          const committed = this.#pending.get(agent);
          if (!committed) throw new Error("STATE_INVALID");
          entry.lastUpdatedAt = this.#now();
          this.#pending.delete(agent);
          try {
            await finish("updated");
            return;
          } catch {
            this.#pending.set(agent, committed);
            entry.lastUpdatedAt = previousUpdatedAt;
            failure = "STATE_WRITE_FAILED";
          }
        }
        entry.causeCode = failure;
      } else {
        release = await acquireAgentCliFence(this.#options.environment, agent);
        if (!release || (await driver.busy(agent))) {
          await finish("skipped-busy", "BUSY");
          return;
        }
        entry.causeCode = "INTERRUPTED";
      }
      const pending = this.#pending.get(agent);
      if (!pending) throw new Error("STATE_INVALID");
      if (!entry.badVersions.includes(pending.target)) entry.badVersions.push(pending.target);
      entry.phase = "rolling-back";
      // Roll back even when recording the bad version fails; the original write-ahead journal
      // remains on disk so a restart cannot blindly install the suspect version again.
      let persistenceFailed = false;
      try {
        await this.#save();
      } catch {
        persistenceFailed = true;
      }
      try {
        await driver.install(pending.plan, pending.previous);
        entry.currentVersion = await driver.version(pending.plan);
        if (entry.currentVersion !== pending.previous || !(await driver.ready(agent)))
          throw new Error("ROLLBACK_FAILED");
      } catch {
        entry.currentVersion = await driver.version(pending.plan).catch(() => null);
        await finish("failed", "ROLLBACK_FAILED");
        return;
      }
      this.#pending.delete(agent);
      try {
        await finish("rolled-back", persistenceFailed ? "STATE_WRITE_FAILED" : entry.causeCode);
      } catch {
        this.#pending.set(agent, pending);
        throw new Error("STATE_WRITE_FAILED");
      }
    } catch (error) {
      await finish("failed", code(error, "CHECK_FAILED"));
    } finally {
      await release?.();
    }
  }
}
