import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import {
  RLY0_GLOBAL_AGENTS,
  Rly0GlobalBridge,
  type Rly0GlobalAgent,
} from "../rly0-bridge/global-config.js";
import { syncCodexMemoryServer, type CodexMemorySync } from "../rly0-memory/codex-config.js";
import { importCodexMemories } from "../rly0-memory/codex-import.js";
import {
  openRly0MemoryStore,
  rly0MemoryServerLaunch,
  type MemoryServerLaunch,
} from "../rly0-memory/launch.js";
import { MemoryError, MEMORY_LIMITS, type MemoryRecord } from "../rly0-memory/store.js";
import { sharedResourceSettings, sharedResourcesProvider } from "../shared-harness-resources.js";

/**
 * 打通设置 backend: the shared memory (list / add / forget / export), Codex's own memory server
 * entry, and the opt-in global blocks for agents that read MCP only from a global file.
 */
const empty = z.object({}).strict();

function route<S extends z.ZodTypeAny>(schema: S, run: (params: z.infer<S>) => unknown) {
  return async (raw: unknown): Promise<unknown> => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw Object.assign(new Error("INVALID_PARAMS"), { code: -32602 });
    try {
      return await run(parsed.data);
    } catch (error) {
      const known =
        error instanceof MemoryError ||
        (error instanceof Error && /^(?:GLOBAL_CONFIG_[A-Z_]+|CODEX_MEMORY_[A-Z_]+)$/u.test(error.message));
      throw Object.assign(new Error(known ? (error as Error).message : "BRIDGE_OPERATION_FAILED"), {
        code: -32000,
      });
    }
  };
}

/**
 * The module the memory server runs from: the installed Host bundle, or the compiled source
 * build next to this file. Undefined when neither exists (then nothing is attached).
 */
export function rly0MemoryEntryUrl(installRoot: string, here: string = import.meta.url): string | undefined {
  const bundled = path.join(installRoot, "app", "host-runtime.mjs");
  if (existsSync(bundled)) return pathToFileURL(bundled).href;
  const source = fileURLToPath(new URL("../installed-harness-plugins.js", here));
  return existsSync(source) && existsSync(path.join(path.dirname(source), "rly0-memory", "server-main.js"))
    ? pathToFileURL(source).href
    : undefined;
}

function view(record: MemoryRecord) {
  return {
    id: record.id,
    text: record.text,
    tags: record.tags,
    agent: record.agent,
    scope: record.scope,
    project: record.project ?? null,
    time: record.time,
    source: record.source ?? null,
  };
}

export function createBridgeRoutes(options: {
  environment: NodeJS.ProcessEnv;
  installRoot: string;
  openFolder: (directory: string) => void;
  /** Tests pin the memory server launch; the default resolves it from the install. */
  memoryLaunch?: MemoryServerLaunch | null;
}) {
  const { environment } = options;
  const store = openRly0MemoryStore(environment);
  const entryUrl = rly0MemoryEntryUrl(options.installRoot);
  const provider = sharedResourcesProvider(environment, entryUrl ? { memoryEntryUrl: entryUrl } : {});
  const global = new Rly0GlobalBridge({
    environment,
    servers: async (agent) => {
      const shared = await provider(environment.USERPROFILE ?? environment.HOME ?? os.homedir(), {
        harnessId: agent,
        mcp: true,
        memoryMcp: true,
      });
      return shared.mcpServers;
    },
  });
  const codexLaunch = (): MemoryServerLaunch | undefined =>
    options.memoryLaunch === null
      ? undefined
      : (options.memoryLaunch ??
        (entryUrl
          ? rly0MemoryServerLaunch({ environment, agent: "codex", entryUrl })
          : undefined));

  /** Codex gets (or loses) `[mcp_servers.rly0_memory]` to follow the memory switch. */
  async function syncCodex(): Promise<CodexMemorySync> {
    const settings = await sharedResourceSettings(environment);
    return syncCodexMemoryServer({ environment, enabled: settings.memory, launch: codexLaunch() });
  }

  const globalAgent = z.enum(RLY0_GLOBAL_AGENTS);
  const routes = {
    "memory.list": route(
      z
        .object({
          query: z.string().max(200).optional(),
          scope: z.enum(["all", "global", "project"]).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .strict(),
      async (p) => {
        const all = await store.all();
        const records = await store.query({
          scope: p.scope === "global" ? "global" : "all",
          limit: p.limit ?? 200,
          ...(p.query ? { query: p.query } : {}),
        });
        const filtered = p.scope === "project" ? records.filter((r) => r.scope === "project") : records;
        const projects = [...new Set(all.flatMap((r) => (r.project ? [r.project] : [])))];
        return {
          records: filtered.map(view),
          total: all.length,
          projects: projects.length,
          agents: [...new Set(all.map((r) => r.agent))].sort(),
          directory: store.directory,
          limits: { text: MEMORY_LIMITS.textChars, records: MEMORY_LIMITS.records },
        };
      },
    ),
    "memory.add": route(
      z
        .object({
          text: z.string().min(1).max(MEMORY_LIMITS.textChars),
          scope: z.enum(["global", "project"]),
          project: z.string().min(3).max(1024).optional(),
          tags: z.array(z.string().max(32)).max(MEMORY_LIMITS.tags).optional(),
        })
        .strict(),
      async (p) => {
        if (p.scope === "project" && (!p.project || !path.isAbsolute(p.project)))
          throw new MemoryError("MEMORY_PROJECT_REQUIRED");
        return view(
          await store.remember({
            text: p.text,
            scope: p.scope,
            agent: "hub",
            ...(p.tags ? { tags: p.tags } : {}),
            ...(p.project ? { cwd: p.project } : {}),
          }),
        );
      },
    ),
    "memory.forget": route(z.object({ id: z.string().min(1).max(64) }).strict(), async (p) => ({
      forgotten: await store.forget(p.id, "hub"),
    })),
    "memory.export": route(empty, async () => {
      const records = await store.all();
      const folder = path.join(store.directory, "exports");
      await fs.mkdir(folder, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "");
      const file = path.join(folder, `memory-${stamp}.json`);
      await fs.writeFile(file, `${JSON.stringify(records.map(view), null, 2)}\n`, { mode: 0o600 });
      return { file, count: records.length };
    }),
    "memory.openFolder": route(empty, async () => {
      await fs.mkdir(store.directory, { recursive: true });
      options.openFolder(store.directory);
      return { ok: true };
    }),
    "memory.importCodex": route(empty, () => importCodexMemories(store, environment)),
    "bridge.status": route(empty, async () => {
      const globals = await Promise.all(RLY0_GLOBAL_AGENTS.map((agent) => global.status(agent)));
      const launch = codexLaunch();
      return {
        memoryServer: launch ? { available: true } : { available: false },
        globals,
      };
    }),
    "bridge.globalSet": route(
      z.object({ agent: globalAgent, enabled: z.boolean() }).strict(),
      (p) => global.set(p.agent as Rly0GlobalAgent, p.enabled),
    ),
    "bridge.syncCodex": route(empty, async () => ({ codex: await syncCodex() })),
  };
  return {
    routes,
    /** After the sharing switches change: Codex's memory entry and the global blocks follow. */
    async afterSharingChange(): Promise<CodexMemorySync> {
      const result = await syncCodex();
      await global.refresh();
      return result;
    },
    /** At Hub start: import Codex memories once and keep Codex's entry current. */
    async start(): Promise<void> {
      await importCodexMemories(store, environment).catch(() => undefined);
      await syncCodex().catch(() => undefined);
    },
  };
}
