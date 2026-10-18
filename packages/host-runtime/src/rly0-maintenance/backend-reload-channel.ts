import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * How the standalone RLY/0 Hub asks the Codex side (this Host) to reload Codex's official
 * backend after an account switch, without restarting the Codex window. The Hub writes a request
 * file with a fresh id; the Host, which checks the file every few seconds, reloads once per id
 * and writes the outcome for that id. Both files live in RLY/0 Hub's own data directory and
 * carry no secrets.
 */
export const BACKEND_RELOAD_REQUEST_FILE = "codex-reload-request.json";
export const BACKEND_RELOAD_RESULT_FILE = "codex-reload-result.json";

export type BackendReloadStatus = "reloaded" | "deferred" | "failed";

const ID_PATTERN = /^[a-f0-9]{16}$/u;

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporary, file);
}

/** Hub side: asks for a reload and waits for the Host's answer (null when nobody answers). */
export async function requestBackendReload(
  dataDirectory: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<BackendReloadStatus | null> {
  const id = randomBytes(8).toString("hex");
  await writeJson(path.join(dataDirectory, BACKEND_RELOAD_REQUEST_FILE), { id, at: Date.now() });
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
    const result = await readJson(path.join(dataDirectory, BACKEND_RELOAD_RESULT_FILE));
    if (result?.id === id) {
      const status = result.status;
      return status === "reloaded" || status === "deferred" || status === "failed" ? status : null;
    }
  }
  return null;
}

/** Host side: answers each new request once. Requests made before the Host started are skipped. */
export class BackendReloadChannel {
  readonly #directory: string;
  #handled: string | null = null;
  #ready = false;
  #busy = false;

  constructor(dataDirectory: string) {
    this.#directory = dataDirectory;
  }

  async poll(reload: () => Promise<BackendReloadStatus>): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const request = await readJson(path.join(this.#directory, BACKEND_RELOAD_REQUEST_FILE));
      const id = typeof request?.id === "string" && ID_PATTERN.test(request.id) ? request.id : null;
      if (!this.#ready) {
        // A request left over from before this Codex started is already satisfied.
        this.#ready = true;
        this.#handled = id;
        return;
      }
      if (!id || id === this.#handled) return;
      this.#handled = id;
      const status = await reload().catch((): BackendReloadStatus => "failed");
      await writeJson(path.join(this.#directory, BACKEND_RELOAD_RESULT_FILE), {
        id,
        status,
        at: Date.now(),
      });
    } finally {
      this.#busy = false;
    }
  }
}
