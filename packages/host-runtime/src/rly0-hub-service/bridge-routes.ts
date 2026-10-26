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
import {
  syncNativePreferences,
  syncNativeResources,
  nativeResourceSyncError,
} from "../rly0-bridge/native-resources.js";

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
        (error instanceof Error &&
          /^(?:GLOBAL_CONFIG_[A-Z_]+|CODEX_MEMORY_[A-Z_]+)$/u.test(error.message));
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
export function rly0MemoryEntryUrl(
  installRoot: string,
  here: string = import.meta.url,
): string | undefined {
  const bundled = path.join(installRoot, "app", "host-runtime.mjs");
  if (existsSync(bundled)) return pathToFileURL(bundled).href;
  const source = fileURLToPath(new URL("../installed-harness-plugins.js", here));
  return existsSync(source) &&
    existsSync(path.join(path.dirname(source), "rly0-memory", "server-main.js"))
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
    thread: record.thread ?? null,
    pinned: record.preferenceApproved === true && record.tags.includes("preference"),
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
  const provider = sharedResourcesProvider(
    environment,
    entryUrl ? { memoryEntryUrl: entryUrl } : {},
  );
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
        (entryUrl ? rly0MemoryServerLaunch({ environment, agent: "codex", entryUrl }) : undefined));

  /** Codex gets (or loses) `[mcp_servers.rly0_memory]` to follow the memory switch. */
  async function syncCodex(): Promise<CodexMemorySync> {
    const settings = await sharedResourceSettings(environment);
    return syncCodexMemoryServer({ environment, enabled: settings.memory, launch: codexLaunch() });
  }
  let nativeError: string | null = null;
  const errorCode = (error: unknown) =>
    error instanceof Error && /^GLOBAL_CONFIG_[A-Z_]+$/u.test(error.message)
      ? error.message
      : "GLOBAL_CONFIG_NATIVE_SYNC_FAILED";
  const syncNative = async () => {
    try {
      const result = await syncNativeResources(
        environment,
        await sharedResourceSettings(environment),
      );
      nativeError = null;
      return result;
    } catch (error) {
      nativeError = errorCode(error);
      throw error;
    }
  };
  // The memory write is already durable. Report an instruction-file failure without inviting
  // the caller to repeat a successful add/forget/pin operation.
  const syncSavedPreferences = async () => {
    try {
      const instructions = await syncNativePreferences(
        environment,
        (await sharedResourceSettings(environment)).memory,
      );
      nativeError = null;
      return { instructions };
    } catch (error) {
      nativeError = errorCode(error);
      return { error: nativeError };
    }
  };

  const globalAgent = z.enum(RLY0_GLOBAL_AGENTS);
  const routes = {
    "memory.list": route(
      z
        .object({
          query: z.string().max(200).optional(),
          scope: z.enum(["all", "global", "project"]).optional(),
          limit: z.number().int().min(1).max(500).optional(),
          pinned: z.boolean().optional(),
        })
        .strict(),
      async (p) => {
        const all = await store.all();
        const records = await store.query({
          scope: p.scope === "global" ? "global" : "all",
          limit: p.limit ?? 200,
          ...(p.query ? { query: p.query } : {}),
          ...(p.pinned === true ? { tag: "preference" } : {}),
        });
        const filtered = records.filter(
          (r) =>
            (p.scope !== "project" || r.scope === "project") &&
            (p.pinned !== true || r.preferenceApproved === true) &&
            (p.pinned !== false || r.preferenceApproved !== true),
        );
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
        const saved = await store.remember(
          {
            text: p.text,
            scope: p.scope,
            agent: "hub",
            ...(p.tags ? { tags: p.tags } : {}),
            ...(p.project ? { cwd: p.project } : {}),
          },
          true,
        );
        const native = await syncSavedPreferences();
        return { ...view(saved), native };
      },
    ),
    "memory.forget": route(z.object({ id: z.string().min(1).max(64) }).strict(), async (p) => {
      const forgotten = await store.forget(p.id, "hub", true);
      const native = await syncSavedPreferences();
      return { forgotten, ...("error" in native ? { native } : {}) };
    }),
    "memory.pin": route(
      z.object({ id: z.string().min(1).max(64), pinned: z.boolean() }).strict(),
      async (p) => {
        const updated = await store.setPreference(p.id, p.pinned, "hub");
        return { record: updated ? view(updated) : null, native: await syncSavedPreferences() };
      },
    ),
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
        nativeError: nativeError ?? nativeResourceSyncError(environment),
      };
    }),
    "bridge.globalSet": route(
      z.object({ agent: globalAgent, enabled: z.boolean() }).strict(),
      (p) => global.set(p.agent as Rly0GlobalAgent, p.enabled),
    ),
    "bridge.syncCodex": route(empty, async () => ({ codex: await syncCodex() })),
    "bridge.syncNative": route(empty, syncNative),
  };
  return {
    routes,
    /** After the sharing switches change: Codex's memory entry and the global blocks follow. */
    async afterSharingChange(): Promise<CodexMemorySync> {
      const result = await syncCodex();
      await global.refresh();
      await syncNative();
      return result;
    },
    /** At Hub start: import Codex memories once and keep Codex's entry current. */
    async start(): Promise<void> {
      await importCodexMemories(store, environment).catch(() => undefined);
      await syncCodex().catch(() => undefined);
      await syncNative().catch(() => undefined);
    },
    async restorePure(): Promise<void> {
      await syncNativeResources(environment, { memory: false, skills: false });
      await syncCodexMemoryServer({ environment, enabled: false, launch: codexLaunch() });
      for (const agent of RLY0_GLOBAL_AGENTS) await global.set(agent, false);
    },
  };
}
