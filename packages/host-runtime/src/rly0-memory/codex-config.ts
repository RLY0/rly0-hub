import { promises as fs } from "node:fs";
import path from "node:path";

import { parse } from "smol-toml";

import { backupAndWriteAtomic, resolveCodexHome } from "../rly0-mcp/file-io.js";
import { removeTable, tomlString, upsertTable } from "../rly0-mcp/toml-editor.js";
import { RLY0_MEMORY_MCP_KEY, type MemoryServerLaunch } from "./launch.js";

/**
 * Codex itself uses the shared memory through `[mcp_servers.rly0_memory]` in its config.toml,
 * written with the same backup + atomic write as the Hub's MCP page. Turning memory sharing off
 * removes exactly that table. The launch carries no credential.
 */
export type CodexMemorySync = "added" | "updated" | "removed" | "unchanged";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function sameLaunch(current: unknown, launch: MemoryServerLaunch): boolean {
  if (!record(current)) return false;
  const env = record(current.env) ? current.env : {};
  return (
    current.command === launch.command &&
    JSON.stringify(current.args) === JSON.stringify(launch.args) &&
    current.enabled !== false &&
    JSON.stringify(Object.entries(env).sort()) === JSON.stringify(Object.entries(launch.env).sort())
  );
}

export async function syncCodexMemoryServer(input: {
  environment: NodeJS.ProcessEnv;
  enabled: boolean;
  /** Undefined when this build cannot start the memory server (then nothing is added). */
  launch: MemoryServerLaunch | undefined;
}): Promise<CodexMemorySync> {
  const file = path.join(resolveCodexHome(input.environment), "config.toml");
  const content = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  // An unreadable config is left for the person (and the MCP page) to fix.
  const parsed: unknown = content ? parse(content) : {};
  const servers = record(parsed) && record(parsed.mcp_servers) ? parsed.mcp_servers : {};
  const current = servers[RLY0_MEMORY_MCP_KEY];
  const segments = ["mcp_servers", RLY0_MEMORY_MCP_KEY];
  if (!input.enabled || !input.launch) {
    if (current === undefined) return "unchanged";
    await backupAndWriteAtomic(
      file,
      removeTable(removeTable(content, [...segments, "env"]), segments),
    );
    return "removed";
  }
  const launch = input.launch;
  if (sameLaunch(current, launch)) return "unchanged";
  let next = removeTable(content, [...segments, "env"]);
  next = upsertTable(next, segments, [
    ["command", tomlString(launch.command)],
    ["args", `[${launch.args.map(tomlString).join(", ")}]`],
  ]);
  next = upsertTable(
    next,
    [...segments, "env"],
    Object.entries(launch.env).map(([key, value]) => [key, tomlString(value)] as const),
  );
  const check: unknown = parse(next);
  if (!record(check) || !record(check.mcp_servers) || !sameLaunch(check.mcp_servers[RLY0_MEMORY_MCP_KEY], launch))
    throw new Error("CODEX_MEMORY_CONFIG_UNVERIFIED");
  await backupAndWriteAtomic(file, next);
  return current === undefined ? "added" : "updated";
}
