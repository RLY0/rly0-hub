import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * How the standalone RLY/0 Hub asks the Codex side (this Host) for things only it can do:
 * - reload Codex's official backend after an account switch, without restarting the window;
 * - check every agent's connection (the diagnostics that used to live in Codex's settings).
 * The Hub writes a request file with a fresh id; the Host, which checks it every few seconds,
 * acts once per id and writes the outcome tagged with that id. All files live in RLY/0 Hub's own
 * data directory and carry no secrets.
 */
export const BACKEND_RELOAD_REQUEST_FILE = "codex-reload-request.json";
export const BACKEND_RELOAD_RESULT_FILE = "codex-reload-result.json";
export const AGENT_CHECK_REQUEST_FILE = "agent-check-request.json";
export const AGENT_STATUS_FILE = "agent-status.json";
/**
 * Written every few seconds by the Codex side while it runs: `{ pid, at, busy }`; `busy` is true
 * while a reply, tool call or agent task is in progress (older builds omit it).
 */
export const CODEX_HEARTBEAT_FILE = "codex-heartbeat.json";
const HEARTBEAT_FRESH_MS = 10_000;

/** Hub side: is the Codex side (Codex opened through RLY/0 Hub) alive right now? */
export async function codexHeartbeatAlive(
  dataDirectory: string,
  now = Date.now(),
): Promise<boolean> {
  const value = await readJson(path.join(dataDirectory, CODEX_HEARTBEAT_FILE));
  const at = value?.at;
  const pid = value?.pid;
  if (typeof at !== "number" || now - at > HEARTBEAT_FRESH_MS) return false;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Hub side: whether Codex (opened through RLY/0 Hub) is working on something right now. `null`
 * when there is no fresh heartbeat, or the Codex side is an older build that does not say.
 */
export async function codexHeartbeatBusy(
  dataDirectory: string,
  now = Date.now(),
): Promise<boolean | null> {
  if (!(await codexHeartbeatAlive(dataDirectory, now))) return null;
  const busy = (await readJson(path.join(dataDirectory, CODEX_HEARTBEAT_FILE)))?.busy;
  return typeof busy === "boolean" ? busy : null;
}

export type BackendReloadStatus = "reloaded" | "deferred" | "failed";

export interface AgentConnectionStatus {
  readonly status: "ready" | "notInstalled" | "unavailable" | "error";
  readonly code?: string;
  readonly message?: string;
}

export interface AgentStatusReport {
  /** Request this report answers; null for the report written at startup. */
  readonly requestId: string | null;
  readonly checkedAt: number;
  readonly agents: Readonly<Record<string, AgentConnectionStatus>>;
}

const ID_PATTERN = /^[a-f0-9]{16}$/u;

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporary, file);
}

async function request(
  dataDirectory: string,
  requestFile: string,
  resultFile: string,
  matches: (result: Record<string, unknown>, id: string) => boolean,
  options: { timeoutMs?: number; pollMs?: number },
): Promise<Record<string, unknown> | null> {
  const id = randomBytes(8).toString("hex");
  await writeJsonFile(path.join(dataDirectory, requestFile), { id, at: Date.now() });
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
    const result = await readJson(path.join(dataDirectory, resultFile));
    if (result && matches(result, id)) return result;
  }
  return null;
}

/** Hub side: asks for a reload and waits for the Host's answer (null when nobody answers). */
export async function requestBackendReload(
  dataDirectory: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<BackendReloadStatus | null> {
  const result = await request(
    dataDirectory,
    BACKEND_RELOAD_REQUEST_FILE,
    BACKEND_RELOAD_RESULT_FILE,
    (value, id) => value.id === id,
    options,
  );
  const status = result?.status;
  return status === "reloaded" || status === "deferred" || status === "failed" ? status : null;
}

function cleanReport(value: Record<string, unknown> | null): AgentStatusReport | null {
  if (!value || typeof value.agents !== "object" || value.agents === null) return null;
  const agents: Record<string, AgentConnectionStatus> = {};
  for (const [id, raw] of Object.entries(value.agents as Record<string, unknown>)) {
    if (!/^[a-z0-9-]{1,40}$/u.test(id) || typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const status = entry.status;
    if (
      status !== "ready" &&
      status !== "notInstalled" &&
      status !== "unavailable" &&
      status !== "error"
    )
      continue;
    agents[id] = {
      status,
      ...(typeof entry.code === "string" ? { code: entry.code.slice(0, 80) } : {}),
      ...(typeof entry.message === "string" ? { message: entry.message.slice(0, 600) } : {}),
    };
  }
  return {
    requestId: typeof value.requestId === "string" ? value.requestId : null,
    checkedAt: typeof value.checkedAt === "number" ? value.checkedAt : 0,
    agents,
  };
}

/** Hub side: the last connection check the Codex side wrote (null before Codex ever ran). */
export async function readAgentStatus(dataDirectory: string): Promise<AgentStatusReport | null> {
  return cleanReport(await readJson(path.join(dataDirectory, AGENT_STATUS_FILE)));
}

/** Hub side: asks the Codex side to check every agent now and waits for the report. */
export async function requestAgentCheck(
  dataDirectory: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<AgentStatusReport | null> {
  return cleanReport(
    await request(
      dataDirectory,
      AGENT_CHECK_REQUEST_FILE,
      AGENT_STATUS_FILE,
      (value, id) => value.requestId === id,
      { timeoutMs: 60_000, ...options },
    ),
  );
}

/** Host side: answers each new request once. Requests made before the Host started are skipped. */
export class HubRequestChannel {
  readonly #file: string;
  #handled: string | null = null;
  #ready = false;
  #busy = false;

  constructor(dataDirectory: string, requestFile: string) {
    this.#file = path.join(dataDirectory, requestFile);
  }

  async poll(handle: (id: string) => Promise<void>): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const value = await readJson(this.#file);
      const id = typeof value?.id === "string" && ID_PATTERN.test(value.id) ? value.id : null;
      if (!this.#ready) {
        // A request left over from before this Codex started is already satisfied.
        this.#ready = true;
        this.#handled = id;
        return;
      }
      if (!id || id === this.#handled) return;
      this.#handled = id;
      await handle(id);
    } finally {
      this.#busy = false;
    }
  }
}

/** Host side: reloads the official backend once per Hub request and reports the outcome. */
export class BackendReloadChannel {
  readonly #channel: HubRequestChannel;
  readonly #directory: string;

  constructor(dataDirectory: string) {
    this.#directory = dataDirectory;
    this.#channel = new HubRequestChannel(dataDirectory, BACKEND_RELOAD_REQUEST_FILE);
  }

  poll(reload: () => Promise<BackendReloadStatus>): Promise<void> {
    return this.#channel.poll(async (id) => {
      const status = await reload().catch((): BackendReloadStatus => "failed");
      await writeJsonFile(path.join(this.#directory, BACKEND_RELOAD_RESULT_FILE), {
        id,
        status,
        at: Date.now(),
      });
    });
  }
}
