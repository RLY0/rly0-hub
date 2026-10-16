import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

const MAX_LINE = 256 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export interface Rly0HubRequestHandler {
  handle(method: string, params: unknown): Promise<unknown>;
}

function errorReply(error: unknown): { code: number; message: string } {
  const code = (error as { code?: unknown } | null)?.code;
  const message =
    error instanceof Error && ERROR_CODE.test(error.message) ? error.message : "HUB_ERROR";
  return { code: typeof code === "number" ? code : -32000, message };
}

/**
 * Newline-delimited JSON between the Hub window and this service: `{id, method, params}` in,
 * `{id, result}` or `{id, error: {code, message}}` out. Error messages are codes only, so nothing
 * from a failing subprocess or upstream reaches the window. Resolves when input closes.
 */
export async function serveRly0HubStdio(
  handler: Rly0HubRequestHandler,
  input: Readable,
  output: Writable,
): Promise<void> {
  const send = (value: unknown): void => {
    output.write(`${JSON.stringify(value)}\n`);
  };
  const pending = new Set<Promise<void>>();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim() || line.length > MAX_LINE) continue;
    let request: { id?: unknown; method?: unknown; params?: unknown };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      continue;
    }
    const { id, method, params } = request;
    if (typeof id !== "string" || !REQUEST_ID.test(id) || typeof method !== "string") continue;
    const task = handler
      .handle(method, params)
      .then((result) => send({ id, result: result ?? null }))
      .catch((error: unknown) => send({ id, error: errorReply(error) }))
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}
