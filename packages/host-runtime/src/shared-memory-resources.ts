import type { SharedMcpServer, SharedResourceRequest } from "@codexhost/harness-adapter/plugin";

import { importCodexMemories } from "./rly0-memory/codex-import.js";
import { openRly0MemoryStore, rly0MemoryServerLaunch } from "./rly0-memory/launch.js";
import { RLY0_MEMORY_INSTRUCTION } from "./rly0-memory/mcp-server.js";
import { redactMemoryText } from "./rly0-memory/redaction.js";
import { standingPreferences } from "./rly0-memory/preferences.js";

/**
 * The shared memory (rly0-memory) for one Agent request. Agents that mount native MCP get the
 * memory server plus the original standing preferences; the others get a bounded read-only digest of this
 * project's and global memories. Codex memories are copied into the store once, on first use.
 */
const DIGEST_RECORDS = 12;
const DIGEST_CHARS = 6000;
const imports = new Map<string, Promise<unknown>>();

function importOnce(environment: NodeJS.ProcessEnv): Promise<unknown> {
  const store = openRly0MemoryStore(environment);
  let pending = imports.get(store.directory);
  if (!pending) {
    pending = importCodexMemories(store, environment).catch(() => undefined);
    imports.set(store.directory, pending);
  }
  return pending;
}

export interface SharedMemoryPart {
  readonly server?: SharedMcpServer;
  readonly context?: { source: string; content: string };
  readonly records: number;
}

export async function sharedMemoryPart(input: {
  environment: NodeJS.ProcessEnv;
  project: string;
  request: SharedResourceRequest;
  /** A module of the running Host, to start the memory server with (see `rly0MemoryServerLaunch`). */
  entryUrl: string | undefined;
  forMcp: boolean;
  forContext: boolean;
}): Promise<SharedMemoryPart> {
  await importOnce(input.environment);
  const native = input.request.memoryMcp === true && input.entryUrl !== undefined;
  const server: SharedMcpServer | undefined =
    input.forMcp && native && input.entryUrl
      ? {
          type: "stdio",
          ...rly0MemoryServerLaunch({
            environment: input.environment,
            agent: input.request.harnessId ?? "unknown",
            entryUrl: input.entryUrl,
            cwd: input.project,
          }),
        }
      : undefined;
  if (!input.forContext) return { ...(server ? { server } : {}), records: 0 };
  const preferences = await standingPreferences(
    openRly0MemoryStore(input.environment),
    input.project,
  );
  if (native)
    return {
      ...(server ? { server } : {}),
      context: {
        source: "rly0-memory",
        content: [
          preferences.content,
          `${RLY0_MEMORY_INSTRUCTION} Workspace root: ${input.project}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      records: preferences.records.length,
    };
  const records = await openRly0MemoryStore(input.environment)
    .query({ cwd: input.project, scope: "visible", limit: DIGEST_RECORDS })
    .catch(() => []);
  if (records.length === 0) return { records: 0 };
  const lines: string[] = [];
  let size = 0;
  for (const record of records) {
    // This digest may be appended to an Agent system prompt. Delegated conclusions are
    // untrusted task output and stay available only through explicit recall/task context.
    if (record.tags.includes("preference") || record.tags.includes("conclusion")) continue;
    const line = `- (${record.scope}, ${record.agent}) ${redactMemoryText(record.text).text.replaceAll("\n", " ")}`;
    if (size + line.length > DIGEST_CHARS) break;
    if (JSON.stringify([preferences.content, ...lines, line].join("\n\n")).length > 22000) break;
    lines.push(line);
    size += line.length;
  }
  return {
    context: {
      source: "rly0-memory (read-only digest; this agent cannot save new memories)",
      content: [preferences.content, lines.join("\n")].filter(Boolean).join("\n\n"),
    },
    records: lines.length + preferences.records.length,
  };
}
