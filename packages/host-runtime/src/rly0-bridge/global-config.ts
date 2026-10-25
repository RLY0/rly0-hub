import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SharedMcpServer } from "@codexhost/harness-adapter/plugin";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { backupAndWriteAtomic } from "../rly0-mcp/file-io.js";
import { carriesCredentials, renderAntigravityMcp, renderHermesMcpLines } from "./renderers.js";

/**
 * The opt-in managed blocks for agents that read MCP only from a global config file (Antigravity
 * CLI `agy`, Hermes). Off by default for each agent. Turning one on backs the file up, then adds
 * only the Hub's entries (named `rly0-*`), and only servers without credentials in their options:
 * a global file is read by every process of that agent and stays on disk. Turning it off removes
 * exactly those entries. Which entries the Hub added is recorded in `bridge/global-blocks.json`.
 */
export const RLY0_GLOBAL_AGENTS = ["antigravity", "hermes"] as const;
export type Rly0GlobalAgent = (typeof RLY0_GLOBAL_AGENTS)[number];

export interface Rly0GlobalBlockState {
  readonly agent: Rly0GlobalAgent;
  readonly enabled: boolean;
  readonly file: string;
  /** Entries the Hub wrote. */
  readonly servers: readonly string[];
  /** Shared servers left out because their options carry credentials. */
  readonly skipped: readonly string[];
}

const BEGIN = "  # >>> RLY/0 Hub managed MCP servers (turn off in RLY/0 Hub → 打通设置) >>>";
const END = "  # <<< RLY/0 Hub managed MCP servers <<<";
const ADDED_KEY = "mcp_servers:  # added by RLY/0 Hub";

interface Manifest {
  [agent: string]: { enabled: boolean; servers: string[]; skipped: string[]; createdKey?: boolean };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function home(environment: NodeJS.ProcessEnv): string {
  return environment.USERPROFILE ?? environment.HOME ?? os.homedir();
}
export function rly0GlobalConfigFile(agent: Rly0GlobalAgent, environment: NodeJS.ProcessEnv): string {
  return agent === "antigravity"
    ? path.join(home(environment), ".gemini", "config", "mcp_config.json")
    : path.join(
        environment.HERMES_HOME ? path.resolve(environment.HERMES_HOME) : path.join(home(environment), ".hermes"),
        "config.yaml",
      );
}
const entryName = (name: string) =>
  `rly0-${name.replace(/^codex_/u, "").replace(/^rly0_/u, "").replaceAll("_", "-")}`;

async function readText(file: string): Promise<string> {
  return fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

/* ---------- Antigravity: JSON `mcpServers` map ---------- */
function antigravityApply(content: string, previous: readonly string[], next: Record<string, unknown>): string {
  let parsed: unknown = {};
  if (content.trim()) {
    try {
      parsed = JSON.parse(content);
    } catch {
      // agy accepts `//` comments; rewriting such a file would drop them.
      throw new Error("GLOBAL_CONFIG_UNPARSEABLE");
    }
  }
  if (!record(parsed)) throw new Error("GLOBAL_CONFIG_UNPARSEABLE");
  const servers = Object.fromEntries(
    Object.entries(record(parsed.mcpServers) ? parsed.mcpServers : {}).filter(
      ([name]) => !previous.includes(name),
    ),
  );
  for (const name of Object.keys(next))
    if (name in servers) throw new Error("GLOBAL_CONFIG_NAME_TAKEN");
  return `${JSON.stringify({ ...parsed, mcpServers: { ...servers, ...next } }, null, 2)}\n`;
}

/* ---------- Hermes: a marked block under `mcp_servers:` in config.yaml ---------- */
function hermesRemove(content: string): string {
  const lines = content.split(/\r?\n/u);
  const begin = lines.findIndex((line) => line.trim() === BEGIN.trim());
  if (begin < 0) return content;
  const end = lines.findIndex((line, index) => index > begin && line.trim() === END.trim());
  if (end < 0) throw new Error("GLOBAL_CONFIG_MARKER_BROKEN");
  lines.splice(begin, end - begin + 1);
  const key = lines.findIndex((line) => line === ADDED_KEY);
  if (key >= 0) {
    const child = lines.slice(key + 1).find((line) => line.trim() && !line.trim().startsWith("#"));
    if (!child || !/^\s/u.test(child)) lines.splice(key, 1);
  }
  return lines.join(content.includes("\r\n") ? "\r\n" : "\n");
}
function hermesInsert(content: string, entries: string[]): string {
  if (!entries.length) return content;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content ? content.split(/\r?\n/u) : [];
  const keyIndex = lines.findIndex((line) => /^mcp_servers\s*:/u.test(line));
  if (keyIndex >= 0 && !/^mcp_servers\s*:\s*(?:#.*)?$/u.test(lines[keyIndex] ?? ""))
    throw new Error("GLOBAL_CONFIG_UNSUPPORTED");
  const indentOf = (from: number) => {
    const child = lines.slice(from).find((line) => line.trim() && !line.trim().startsWith("#"));
    const indent = child ? /^(\s+)/u.exec(child)?.[1] : undefined;
    return indent ?? "  ";
  };
  const indent = keyIndex >= 0 ? indentOf(keyIndex + 1) : "  ";
  const block = [BEGIN, ...entries, END].map((line) => indent + line.trimStart());
  if (keyIndex >= 0) lines.splice(keyIndex + 1, 0, ...block);
  else {
    while (lines.length && !lines.at(-1)?.trim()) lines.pop();
    lines.push(...(lines.length ? [""] : []), ADDED_KEY, ...block, "");
  }
  return lines.join(newline);
}

export class Rly0GlobalBridge {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #servers: (agent: Rly0GlobalAgent) => Promise<Record<string, SharedMcpServer>>;

  constructor(options: {
    environment: NodeJS.ProcessEnv;
    /** The shared servers this agent would receive (the Host's provider). */
    servers: (agent: Rly0GlobalAgent) => Promise<Record<string, SharedMcpServer>>;
  }) {
    this.#environment = options.environment;
    this.#servers = options.servers;
  }

  #manifestFile(): string {
    return path.join(resolveRly0DataDir(this.#environment), "bridge", "global-blocks.json");
  }
  async #manifest(): Promise<Manifest> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.#manifestFile(), "utf8"));
      return record(parsed) ? (parsed as Manifest) : {};
    } catch {
      return {};
    }
  }
  async #saveManifest(manifest: Manifest): Promise<void> {
    const file = this.#manifestFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(manifest, null, 2));
    await fs.rename(`${file}.tmp`, file);
  }

  async status(agent: Rly0GlobalAgent): Promise<Rly0GlobalBlockState> {
    const entry = (await this.#manifest())[agent];
    return {
      agent,
      enabled: entry?.enabled === true,
      file: rly0GlobalConfigFile(agent, this.#environment),
      servers: entry?.servers ?? [],
      skipped: entry?.skipped ?? [],
    };
  }

  async set(agent: Rly0GlobalAgent, enabled: boolean): Promise<Rly0GlobalBlockState> {
    const manifest = await this.#manifest();
    const previous = manifest[agent]?.servers ?? [];
    const file = rly0GlobalConfigFile(agent, this.#environment);
    const content = await readText(file);
    const shared = enabled ? await this.#servers(agent) : {};
    const allowed = Object.fromEntries(
      Object.entries(shared)
        .filter(([, server]) => !carriesCredentials(server))
        .map(([name, server]) => [entryName(name), server]),
    );
    const skipped = Object.entries(shared)
      .filter(([, server]) => carriesCredentials(server))
      .map(([name]) => name.replace(/^codex_/u, ""));
    const next =
      agent === "antigravity"
        ? antigravityApply(content, previous, renderAntigravityMcp(allowed))
        : hermesInsert(hermesRemove(content), renderHermesMcpLines(allowed));
    if (next !== content && (content || Object.keys(allowed).length))
      await backupAndWriteAtomic(file, next);
    manifest[agent] = { enabled, servers: enabled ? Object.keys(allowed) : [], skipped };
    await this.#saveManifest(manifest);
    return this.status(agent);
  }

  /** Re-renders the blocks that are on, after the shared MCP list changed. */
  async refresh(): Promise<void> {
    for (const agent of RLY0_GLOBAL_AGENTS)
      if ((await this.status(agent)).enabled) await this.set(agent, true).catch(() => undefined);
  }
}
