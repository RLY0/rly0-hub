import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { MemoryError, MEMORY_LIMITS, type MemoryRecord, type MemoryStore } from "./store.js";
import { standingPreferences } from "./preferences.js";

/**
 * Minimal MCP stdio server (newline-delimited JSON-RPC 2.0) for the shared memory, without an
 * SDK dependency: initialize, ping, tools/list, tools/call. Every Agent gets the same tools.
 */
export const RLY0_MEMORY_SERVER_NAME = "rly0-memory";
export const RLY0_MEMORY_INSTRUCTION =
  "rly0-memory is memory shared by every AI agent on this computer: call recall (cwd = workspace root) when starting a task, remember durable facts and decisions (never secrets); only the person can pin standing preferences in the Hub, forget what is wrong.";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const cwdProperty = {
  type: "string",
  description: "Absolute path of the current workspace; selects the project scope.",
};
export const RLY0_MEMORY_TOOLS = [
  {
    name: "remember",
    description:
      "Save a durable memory visible to every agent: a fact, decision or convention. Standing preferences can only be pinned by the person in the Hub. Not for secrets (they are removed).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: MEMORY_LIMITS.textChars },
        tags: { type: "array", items: { type: "string" }, maxItems: MEMORY_LIMITS.tags },
        scope: {
          type: "string",
          enum: ["project", "global"],
          description: "project (default): this repository only; global: every project.",
        },
        cwd: cwdProperty,
      },
      required: ["text"],
    },
  },
  {
    name: "recall",
    description:
      "Memories for this project and global ones, best match first (newest first without a query).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        cwd: cwdProperty,
        limit: { type: "integer", minimum: 1, maximum: MEMORY_LIMITS.results },
      },
    },
  },
  {
    name: "search",
    description: "Search memories by words; scope all also searches other projects.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["project", "global", "all"] },
        cwd: cwdProperty,
        limit: { type: "integer", minimum: 1, maximum: MEMORY_LIMITS.results },
      },
      required: ["query"],
    },
  },
  {
    name: "forget",
    description: "Delete one memory by its id (from recall or search).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
] as const;

export interface MemoryServerContext {
  store: MemoryStore;
  agent: string;
  thread?: string;
  /** Default workspace when a call has no `cwd`. */
  cwd: string;
  environment?: NodeJS.ProcessEnv;
}

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 4096) =>
  typeof value === "string" ? value.slice(0, max) : undefined;
const limit = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(value, MEMORY_LIMITS.results))
    : 10;

function view(entry: MemoryRecord) {
  return {
    id: entry.id,
    text: entry.text,
    ...(entry.tags.length ? { tags: entry.tags } : {}),
    scope: entry.scope,
    agent: entry.agent,
    time: new Date(entry.time).toISOString(),
  };
}

const MESSAGES: Record<MemoryError["code"], string> = {
  MEMORY_TEXT_EMPTY: "text is empty",
  MEMORY_TEXT_TOO_LONG: `text is longer than ${MEMORY_LIMITS.textChars} characters; shorten it`,
  MEMORY_PREFERENCE_HUB_ONLY: "standing preferences can only be changed in the Hub",
  MEMORY_TAG_INVALID: `at most ${MEMORY_LIMITS.tags} tags of letters, digits, _ . : - (32 characters)`,
  MEMORY_FULL: "the memory store is full; forget old memories first",
  MEMORY_LOCKED: "the memory store is busy; retry",
  MEMORY_PROJECT_REQUIRED: "project scope needs cwd",
};

export async function callMemoryTool(
  context: MemoryServerContext,
  name: string,
  args: Json,
): Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Json;
}> {
  const cwd = text(args.cwd, 1024) || context.cwd;
  const result = (value: Json) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  });
  try {
    if (name === "remember") {
      const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string") : [];
      const saved = await context.store.remember({
        text: typeof args.text === "string" ? args.text : "",
        tags: tags as string[],
        scope: args.scope === "global" ? "global" : "project",
        cwd,
        agent: context.agent,
        ...(context.thread ? { thread: context.thread } : {}),
      });
      return result({
        saved: view(saved),
      });
    }
    if (name === "recall") {
      const query = text(args.query);
      const found = await context.store.query({
        cwd,
        scope: "visible",
        limit: limit(args.limit),
        ...(query ? { query } : {}),
      });
      return result({ memories: found.map(view) });
    }
    if (name === "search") {
      const scope = args.scope === "global" || args.scope === "all" ? args.scope : "visible";
      const found = await context.store.query({
        cwd,
        scope: args.scope === "project" ? "project" : scope,
        limit: limit(args.limit),
        query: text(args.query) ?? "",
      });
      return result({ memories: found.map(view) });
    }
    if (name === "forget") {
      const id = text(args.id, 64) ?? "";
      if ((await context.store.get(id))?.preferenceApproved === true)
        throw new MemoryError("MEMORY_PREFERENCE_HUB_ONLY");
      const forgotten = await context.store.forget(id, context.agent);
      return result({ forgotten });
    }
    return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  } catch (error) {
    const message = error instanceof MemoryError ? MESSAGES[error.code] : "memory operation failed";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

export async function handleMemoryRpc(
  context: MemoryServerContext,
  message: Json,
): Promise<Json | null> {
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";
  const isRequest = typeof id === "string" || typeof id === "number";
  const reply = (resultValue: Json) => ({ jsonrpc: "2.0", id, result: resultValue });
  const fail = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });
  if (!isRequest) return null;
  const params = record(message.params) ? message.params : {};
  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: RLY0_MEMORY_SERVER_NAME, version: "1.0.0" },
        instructions: [
          context.agent === "codex"
            ? ""
            : (await standingPreferences(context.store, context.cwd)).content,
          RLY0_MEMORY_INSTRUCTION,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: RLY0_MEMORY_TOOLS as unknown as Json[] });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = record(params.arguments) ? params.arguments : {};
      return reply(await callMemoryTool(context, name, args));
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export async function serveMemoryMcp(
  context: MemoryServerContext,
  input: Readable,
  output: Writable,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
      );
      continue;
    }
    if (!record(message)) continue;
    const task = handleMemoryRpc(context, message).then(
      (response) => {
        if (response) output.write(`${JSON.stringify(response)}\n`);
      },
      () => undefined,
    );
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}
