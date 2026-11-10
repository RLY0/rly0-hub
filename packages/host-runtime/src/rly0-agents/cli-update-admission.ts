import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessAdapter, HarnessSession, HostCommand } from "@codexhost/harness-adapter";
import { agentCliUpdateIdSchema } from "@codexhost/shared-contracts";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

export function agentCliUpdateFence(environment: NodeJS.ProcessEnv, agent: string): string {
  return path.join(resolveRly0DataDir(environment), "agent-cli-updates", `${agent}.lock`);
}

/** Synchronous with setting thread.running; no await between admission and execution. */
export function assertAgentCliAvailable(environment: NodeJS.ProcessEnv, agent: string): void {
  if (!agentCliUpdateIdSchema.safeParse(agent).success) return;
  try {
    if (
      !readdirSync(agentCliUpdateFence(environment, agent)).some((name) => name.endsWith(".json"))
    )
      return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  throw Object.assign(new Error("AGENT_CLI_UPDATE_BUSY"), { code: -32072 });
}

/** Exclusive cross-Hub fence, held through readback, inspection and any rollback. */
export async function acquireAgentCliFence(
  environment: NodeJS.ProcessEnv,
  agent: string,
  isAlive: (pid: number) => boolean = processAlive,
): Promise<(() => Promise<void>) | null> {
  const directory = agentCliUpdateFence(environment, agent);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Unique owner paths are never reused. A stale-owner cleanup cannot unlink a successor.
  for (const name of await readdir(directory)) {
    if (name.endsWith(".json") && !(await ownerAlive(path.join(directory, name), isAlive)))
      await rm(path.join(directory, name), { force: true });
  }
  const file = path.join(directory, `${randomUUID()}.json`);
  try {
    await writeFile(file, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  // Concurrent contenders either observe the owner or both back off. Never pick a new owner
  // by timestamp: one contender could already have passed its empty-directory observation.
  if ((await readdir(directory)).filter((name) => name.endsWith(".json")).length !== 1) {
    await rm(file, { force: true });
    return null;
  }
  return () => rm(file, { force: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function ownerAlive(file: string, isAlive: (pid: number) => boolean): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0
    )
      return true;
    return isAlive(value.pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export async function fenceOwnerAlive(
  environment: NodeJS.ProcessEnv,
  agent: string,
): Promise<boolean> {
  const directory = agentCliUpdateFence(environment, agent);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return (
    await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => ownerAlive(path.join(directory, name), processAlive)),
    )
  ).some(Boolean);
}

/** Wrap all plugin opens, restores, commands and turn starts; keep adapter private receivers. */
export class AgentCliUpdateAdmission {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #pending = new Map<string, number>();
  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = environment;
  }
  busy(agent: string): boolean {
    return (this.#pending.get(agent) ?? 0) > 0;
  }
  async #run<T>(agent: string, run: () => Promise<T>): Promise<T> {
    assertAgentCliAvailable(this.#environment, agent);
    this.#pending.set(agent, (this.#pending.get(agent) ?? 0) + 1);
    try {
      return await run();
    } finally {
      this.#pending.set(agent, (this.#pending.get(agent) ?? 1) - 1);
    }
  }
  wrap(adapter: HarnessAdapter): HarnessAdapter {
    const agent = adapter.harnessId;
    if (!agentCliUpdateIdSchema.safeParse(agent).success) return adapter;
    const unavailable = (error: unknown) => {
      if (!(error instanceof Error) || error.message !== "AGENT_CLI_UPDATE_BUSY") throw error;
      return {
        ok: false as const,
        error: { code: "unavailable" as const, message: error.message, retryable: true },
      };
    };
    return new Proxy(adapter, {
      get: (target, property) => {
        if (property === "open")
          return (input: Parameters<HarnessAdapter["open"]>[0]) =>
            this.#run(agent, async () => {
              const opened = await target.open(input);
              return opened.ok ? { ...opened, value: this.#session(agent, opened.value) } : opened;
            }).catch(unavailable);
        const install = target.install;
        const installation = target.installation;
        if (property === "install" && install)
          return () => this.#run(agent, () => install.call(target));
        if (property === "installation" && installation)
          return (action: "check" | "update") =>
            action === "check"
              ? installation.call(target, action)
              : this.#run(agent, () => installation.call(target, action));
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  #session(agent: string, session: HarnessSession): HarnessSession {
    const unavailable = (error: unknown) => {
      if (!(error instanceof Error) || error.message !== "AGENT_CLI_UPDATE_BUSY") throw error;
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
              return this.#run(agent, () => target.execute(input)).catch(unavailable);
            // Forward overloaded non-start commands without weakening their public signatures.
            return Reflect.apply(target.execute, target, [input]) as Promise<unknown>;
          };
        if (property === "commands" && target.commands) {
          const commands = target.commands;
          return {
            ...commands,
            list: commands.list.bind(commands),
            execute: (input: Parameters<typeof commands.execute>[0]) =>
              this.#run(agent, () => commands.execute(input)).catch(unavailable),
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
