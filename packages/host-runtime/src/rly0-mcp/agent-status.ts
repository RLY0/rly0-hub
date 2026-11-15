import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { redactCredentialText } from "../secret-redaction.js";

/**
 * The connection state each Agent itself reported for the shared MCP servers it received
 * (Claude Code's session `init`/`mcpServerStatus`). Sessions run in the Host while the Hub page is
 * served by another process, so the last report per Agent and server is kept in a small file.
 */
export const AGENT_MCP_STATUSES = [
  "connected",
  "needs-auth",
  "failed",
  "pending",
  "disabled",
] as const;
export type AgentMcpStatus = (typeof AGENT_MCP_STATUSES)[number];
export interface AgentMcpStatusEntry {
  status: AgentMcpStatus;
  at: number;
  error?: string;
}
export type AgentMcpStatusMap = Record<string, Record<string, AgentMcpStatusEntry>>;

const MAX_AGENTS = 16;
const MAX_SERVERS = 96;
const NAME = /^[A-Za-z0-9._-]{1,80}$/u;

const statusFile = (env: NodeJS.ProcessEnv) =>
  path.join(resolveRly0DataDir(env), "bridge", "mcp-agent-status.json");

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export async function readAgentMcpStatus(env: NodeJS.ProcessEnv): Promise<AgentMcpStatusMap> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(statusFile(env), "utf8"));
    if (!record(data)) return {};
    const result: AgentMcpStatusMap = Object.create(null);
    for (const [agent, servers] of Object.entries(data).slice(0, MAX_AGENTS)) {
      if (!NAME.test(agent) || !record(servers)) continue;
      const entries: Record<string, AgentMcpStatusEntry> = Object.create(null);
      for (const [name, value] of Object.entries(servers).slice(0, MAX_SERVERS)) {
        if (!NAME.test(name) || !record(value)) continue;
        if (!AGENT_MCP_STATUSES.includes(value.status as AgentMcpStatus)) continue;
        if (typeof value.at !== "number" || !Number.isSafeInteger(value.at)) continue;
        entries[name] = {
          status: value.status as AgentMcpStatus,
          at: value.at,
          ...(typeof value.error === "string" ? { error: value.error.slice(0, 200) } : {}),
        };
      }
      result[agent] = entries;
    }
    return result;
  } catch {
    return {};
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Merges one report; servers not in it keep their previous state. Never throws. */
export function recordAgentMcpStatus(
  env: NodeJS.ProcessEnv,
  agent: string,
  reports: readonly { name: string; status: string; error?: string }[],
  now: number = Date.now(),
): Promise<void> {
  const write = async () => {
    if (!NAME.test(agent)) return;
    const current = await readAgentMcpStatus(env);
    const entries = current[agent] ?? Object.create(null);
    for (const report of reports.slice(0, MAX_SERVERS)) {
      if (!NAME.test(report.name)) continue;
      if (!AGENT_MCP_STATUSES.includes(report.status as AgentMcpStatus)) continue;
      const error =
        report.status === "failed" && typeof report.error === "string" && report.error
          ? redactCredentialText(report.error).replace(/\s+/gu, " ").slice(0, 200)
          : undefined;
      entries[report.name] = {
        status: report.status as AgentMcpStatus,
        at: now,
        ...(error ? { error } : {}),
      };
    }
    current[agent] = entries;
    const file = statusFile(env);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(current), { flag: "wx", mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  };
  const next = queue.then(write, write).catch(() => undefined);
  queue = next;
  return next;
}
