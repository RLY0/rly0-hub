import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  CONSOLE_REMOTE_CONNECTIONS_METHOD,
  USAGE_STATISTICS_RANGES,
  USAGE_STATISTICS_METHOD,
  harnessSessionImportParamsSchema,
  harnessSessionListParamsSchema,
} from "@codexhost/shared-contracts";
import { z } from "zod";

import { consoleHostDescriptorDirectory } from "../console-control-server.js";

/**
 * The upstream web console's Codex-side functions (remote Hosts, local usage statistics, session
 * import), reached from the Hub window instead of a browser page. They go through the same local
 * Host console channel the web console used (`console-control-server.ts`): a loopback endpoint
 * whose descriptor and token only this user can read. Nothing here opens a browser.
 */
export type HubHostRequest = (method: string, params: unknown) => Promise<unknown>;

/** Thrown when no local Codex with RLY/0 Hub is running (the channel has no live descriptor). */
export const HOST_UNAVAILABLE = "HOST_UNAVAILABLE";

const DESCRIPTOR_PATTERN = /^host-\d{1,10}\.json$/u;
const DESCRIPTOR_MAX_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

interface HostEndpoint {
  readonly port: number;
  readonly token: string;
  readonly startedAt: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function newestHost(
  directory: string,
  isAlive: (pid: number) => boolean,
): Promise<HostEndpoint | null> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }
  const hosts: HostEndpoint[] = [];
  for (const name of names.filter((candidate) => DESCRIPTOR_PATTERN.test(candidate))) {
    try {
      const text = await readFile(path.join(directory, name), "utf8");
      if (text.length > DESCRIPTOR_MAX_BYTES) continue;
      const value = JSON.parse(text) as Record<string, unknown>;
      if (
        value.schemaVersion !== 1 ||
        typeof value.pid !== "number" ||
        typeof value.port !== "number" ||
        typeof value.token !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value.token) ||
        typeof value.startedAt !== "number" ||
        !isAlive(value.pid)
      )
        continue;
      hosts.push({ port: value.port, token: value.token, startedAt: value.startedAt });
    } catch {
      continue;
    }
  }
  return hosts.sort((left, right) => right.startedAt - left.startedAt)[0] ?? null;
}

/** Requests to the newest live local Host; read-only toward its descriptors (never removes one). */
export function createHubHostRequest(options: {
  environment: NodeJS.ProcessEnv;
  isAlive?: (pid: number) => boolean;
  fetchImpl?: typeof fetch;
}): HubHostRequest {
  const directory = consoleHostDescriptorDirectory(options.environment);
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (method, params) => {
    const host = await newestHost(directory, options.isAlive ?? processAlive);
    if (!host) throw Object.assign(new Error(HOST_UNAVAILABLE), { code: -32090 });
    const response = await fetchImpl(`http://127.0.0.1:${host.port}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, params: params ?? {} }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && "result" in body) return body.result;
    const error = body?.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof error?.code === "number" ? error.code : -32603;
    const message =
      typeof error?.message === "string" && error.message
        ? error.message.slice(0, 500)
        : `HOST_HTTP_${response.status}`;
    throw Object.assign(new Error(code === -32090 ? HOST_UNAVAILABLE : message), { code });
  };
}

function route<S extends z.ZodTypeAny>(
  schema: S,
  run: (params: z.infer<S>) => Promise<unknown> | unknown,
) {
  return async (raw: unknown): Promise<unknown> => {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) throw Object.assign(new Error("INVALID_PARAMS"), { code: -32602 });
    return run(parsed.data);
  };
}

const empty = z.object({}).strict();
const hostId = z.string().min(1).max(1024);

/**
 * Reads answer `{ available: false }` while Codex is not running, so a page can say so instead
 * of failing; changes (connect, import) throw `HOST_UNAVAILABLE` instead.
 */
export function createHostConsoleRoutes(request: HubHostRequest) {
  const read = async <T>(method: string, params: unknown, wrap: (result: unknown) => T) => {
    try {
      return { available: true, ...wrap(await request(method, params)) };
    } catch (error) {
      if (error instanceof Error && error.message === HOST_UNAVAILABLE) return { available: false };
      throw error;
    }
  };
  return {
    "remote.list": route(empty, () =>
      read(CONSOLE_REMOTE_CONNECTIONS_METHOD, { action: "list" }, (connections) => ({
        connections: Array.isArray(connections) ? connections : [],
      })),
    ),
    "remote.state": route(z.object({ hostId }).strict(), (p) =>
      read(CONSOLE_REMOTE_CONNECTIONS_METHOD, { action: "state", hostId: p.hostId }, (state) => ({
        state,
      })),
    ),
    "remote.connect": route(z.object({ hostId, enabled: z.boolean() }).strict(), async (p) => {
      await request(CONSOLE_REMOTE_CONNECTIONS_METHOD, {
        action: "connect",
        hostId: p.hostId,
        enabled: p.enabled,
      });
      return { ok: true };
    }),
    "usage.statistics": route(z.object({ range: z.enum(USAGE_STATISTICS_RANGES) }).strict(), (p) =>
      read(USAGE_STATISTICS_METHOD, { range: p.range }, (statistics) => ({ statistics })),
    ),
    "sessions.sources": route(empty, () =>
      read("codexhost/harness/session-import/sources", {}, (result) => ({
        harnesses:
          result &&
          typeof result === "object" &&
          Array.isArray((result as Record<string, unknown>).harnesses)
            ? (result as { harnesses: unknown[] }).harnesses
            : [],
      })),
    ),
    "sessions.list": route(harnessSessionListParamsSchema, (p) =>
      read("codexhost/harness/session-import/list", p, (result) => ({ list: result })),
    ),
    "sessions.import": route(harnessSessionImportParamsSchema, (p) =>
      request("codexhost/harness/session-import/import", p),
    ),
  };
}
