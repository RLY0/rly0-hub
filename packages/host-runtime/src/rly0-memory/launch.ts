import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { RLY0_MEMORY_SERVER_NAME, serveMemoryMcp } from "./mcp-server.js";
import { MemoryStore } from "./store.js";

/** Released Host bundle subcommand that serves the shared memory over MCP stdio. */
export const RLY0_MEMORY_MCP_ARGUMENT = "--rly0-memory-mcp";
/** Name the shared memory server is attached under, for every Agent and Codex. */
export const RLY0_MEMORY_MCP_KEY = "rly0_memory";

export function rly0MemoryDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.RLY0_MEMORY_DIR
    ? path.resolve(environment.RLY0_MEMORY_DIR)
    : path.join(resolveRly0DataDir(environment), "memory");
}

export function openRly0MemoryStore(environment: NodeJS.ProcessEnv): MemoryStore {
  return new MemoryStore(rly0MemoryDirectory(environment));
}

export interface MemoryServerLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

/**
 * How an Agent starts the memory server. `entryUrl` is a module of the running Host: the released
 * single-file bundle (`app/host-runtime.mjs`) takes the subcommand; a source build runs the
 * compiled `rly0-memory/server-main.js` next to it. The environment carries no credential.
 */
export function rly0MemoryServerLaunch(input: {
  environment: NodeJS.ProcessEnv;
  agent: string;
  entryUrl: string;
  nodePath?: string;
  cwd?: string;
}): MemoryServerLaunch {
  const entry = fileURLToPath(input.entryUrl).replace(/^\\\\\?\\(?=[A-Za-z]:\\)/u, "");
  const args = entry.endsWith(".mjs")
    ? [entry, RLY0_MEMORY_MCP_ARGUMENT]
    : [path.join(path.dirname(entry), "rly0-memory", "server-main.js")];
  return {
    command: (input.nodePath ?? process.execPath).replace(/^\\\\\?\\(?=[A-Za-z]:\\)/u, ""),
    args,
    env: {
      RLY0_MEMORY_DIR: rly0MemoryDirectory(input.environment),
      RLY0_MEMORY_AGENT: input.agent,
      ...(input.cwd ? { RLY0_MEMORY_CWD: input.cwd } : {}),
    },
  };
}

export { RLY0_MEMORY_SERVER_NAME };

/** Serves the memory over this process's stdio until stdin closes. */
export async function runRly0MemoryServer(environment: NodeJS.ProcessEnv): Promise<number> {
  await serveMemoryMcp(
    {
      store: openRly0MemoryStore(environment),
      agent: environment.RLY0_MEMORY_AGENT || "unknown",
      ...(environment.RLY0_MEMORY_THREAD ? { thread: environment.RLY0_MEMORY_THREAD } : {}),
      cwd: environment.RLY0_MEMORY_CWD || process.cwd(),
    },
    process.stdin,
    process.stdout,
  );
  return 0;
}
