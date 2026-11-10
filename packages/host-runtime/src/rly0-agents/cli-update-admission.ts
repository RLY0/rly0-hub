import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessAdapter, HarnessSession, HostCommand } from "@codexhost/harness-adapter";
import { agentCliUpdateIdSchema } from "@codexhost/shared-contracts";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import {
  cliOwnerProbe,
  heldCliOwners,
  liveCliOwners,
  type CliOwnerProbe,
} from "./cli-update-owner.js";
export type { CliOwnerProbe } from "./cli-update-owner.js";

export const AGENT_CLI_UPDATE_BUSY_MESSAGE =
  "该 AI 助手正在更新，请稍后重试（AGENT_CLI_UPDATE_BUSY）";
export function agentCliBusyError(): Error {
  return Object.assign(new Error(AGENT_CLI_UPDATE_BUSY_MESSAGE), { code: -32072, retryable: true });
}

export function agentCliUpdateFence(environment: NodeJS.ProcessEnv, agent: string): string {
  return path.join(resolveRly0DataDir(environment), "agent-cli-updates", `${agent}.lock`);
}

/** Synchronous with setting thread.running; no await between admission and execution. */
export function assertAgentCliAvailable(
  environment: NodeJS.ProcessEnv,
  agent: string,
  probe?: CliOwnerProbe,
): void {
  if (!agentCliUpdateIdSchema.safeParse(agent).success) return;
  try {
    if (!liveCliOwners(agentCliUpdateFence(environment, agent), probe).length) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  throw agentCliBusyError();
}

/** Exclusive cross-Hub fence, held through readback, inspection and any rollback. */
export async function acquireAgentCliFence(
  environment: NodeJS.ProcessEnv,
  agent: string,
  probe: CliOwnerProbe = cliOwnerProbe,
): Promise<(() => Promise<void>) | null> {
  const directory = agentCliUpdateFence(environment, agent);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  liveCliOwners(directory, probe);
  const id = randomUUID();
  const startedAt = probe.start(process.pid);
  if (!startedAt) throw new Error("CHECK_FAILED");
  const file = path.join(directory, `${id}.json`);
  const temporary = path.join(directory, `${id}.tmp`);
  heldCliOwners.add(id);
  try {
    await writeFile(temporary, JSON.stringify({ pid: process.pid, startedAt, id }), {
      flag: "wx",
      mode: 0o600,
    });
    await link(temporary, file);
  } catch (error) {
    heldCliOwners.delete(id);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  // Concurrent contenders either observe the owner or both back off. Never pick a new owner
  // by timestamp: one contender could already have passed its empty-directory observation.
  if ((await readdir(directory)).filter((name) => name.endsWith(".json")).length !== 1) {
    await rm(file, { force: true });
    heldCliOwners.delete(id);
    return null;
  }
  return async () => {
    await rm(file, { force: true });
    heldCliOwners.delete(id);
  };
}

export async function fenceOwnerAlive(
  environment: NodeJS.ProcessEnv,
  agent: string,
  probe?: CliOwnerProbe,
): Promise<boolean> {
  return liveCliOwners(agentCliUpdateFence(environment, agent), probe).length > 0;
}

export function cleanAgentCliFences(environment: NodeJS.ProcessEnv, probe?: CliOwnerProbe): void {
  for (const agent of [...agentCliUpdateIdSchema.options, "coordinator", "state"])
    liveCliOwners(agentCliUpdateFence(environment, agent), probe);
}

/** Wrap all plugin opens, restores, commands and turn starts; keep adapter private receivers. */
export class AgentCliUpdateAdmission {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #pending = new Map<string, number>();
  readonly #originals = new WeakMap<HarnessAdapter, HarnessAdapter>();
  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = environment;
  }
  busy(agent: string): boolean {
    return (this.#pending.get(agent) ?? 0) > 0;
  }
  async run<T>(agent: string, run: () => Promise<T>): Promise<T> {
    assertAgentCliAvailable(this.#environment, agent);
    this.#pending.set(agent, (this.#pending.get(agent) ?? 0) + 1);
    try {
      return await run();
    } finally {
      this.#pending.set(agent, (this.#pending.get(agent) ?? 1) - 1);
    }
  }
  /** Only the Host's fenced updater RPC may bypass ordinary inspection admission. */
  inspectForUpdate(adapter: HarnessAdapter): ReturnType<HarnessAdapter["inspect"]> {
    const original = this.#originals.get(adapter);
    if (!original) throw new Error("HOST_UNAVAILABLE");
    return original.inspect({ refresh: true });
  }
  wrap(adapter: HarnessAdapter): HarnessAdapter {
    const agent = adapter.harnessId;
    if (!agentCliUpdateIdSchema.safeParse(agent).success) return adapter;
    const unavailable = (error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("AGENT_CLI_UPDATE_BUSY"))
        throw error;
      return {
        ok: false as const,
        error: { code: "unavailable" as const, message: error.message, retryable: true },
      };
    };
    const wrapped = new Proxy(adapter, {
      get: (target, property) => {
        if (property === "inspect")
          return (input: Parameters<HarnessAdapter["inspect"]>[0]) =>
            this.run(agent, () => target.inspect(input));
        if (property === "open")
          return (input: Parameters<HarnessAdapter["open"]>[0]) =>
            this.run(agent, async () => {
              const opened = await target.open(input);
              return opened.ok ? { ...opened, value: this.#session(agent, opened.value) } : opened;
            }).catch(unavailable);
        const install = target.install;
        const installation = target.installation;
        if (property === "install" && install)
          return () => this.run(agent, () => install.call(target));
        if (property === "installation" && installation)
          return (action: "check" | "update") =>
            this.run(agent, () => installation.call(target, action));
        if (property === "webUi" && target.webUi) {
          const webUi = target.webUi;
          return { ...webUi, open: () => this.run(agent, () => webUi.open()).catch(unavailable) };
        }
        if (property === "inspectAccount" && target.inspectAccount) {
          const inspect = target.inspectAccount;
          return () => this.run(agent, () => inspect.call(target));
        }
        if (property === "inspectAccounts" && target.inspectAccounts) {
          const inspect = target.inspectAccounts;
          return () => this.run(agent, () => inspect.call(target));
        }
        if (property === "refreshCredits" && target.refreshCredits) {
          const inspect = target.refreshCredits;
          return () => this.run(agent, () => inspect.call(target));
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.#originals.set(wrapped, adapter);
    return wrapped;
  }
  #session(agent: string, session: HarnessSession): HarnessSession {
    const unavailable = (error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("AGENT_CLI_UPDATE_BUSY"))
        throw error;
      return {
        ok: false as const,
        error: { code: "unavailable" as const, message: error.message, retryable: true },
      };
    };
    return new Proxy(session, {
      get: (target, property) => {
        if (property === "execute")
          return (input: HostCommand) => {
            if (input.type === "turn.start")
              return this.run(agent, () => target.execute(input)).catch(unavailable);
            // Forward overloaded non-start commands without weakening their public signatures.
            return Reflect.apply(target.execute, target, [input]) as Promise<unknown>;
          };
        if (property === "commands" && target.commands) {
          const commands = target.commands;
          return {
            ...commands,
            list: commands.list.bind(commands),
            execute: (input: Parameters<typeof commands.execute>[0]) =>
              this.run(agent, () => commands.execute(input)).catch(unavailable),
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
