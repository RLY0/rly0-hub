import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";

/**
 * One conversation may switch between relay, config.toml and official models (统一渠道). Each
 * upstream names the items it returns in its own way, and Codex sends them back as history; the
 * official Responses API rejects ids it did not issue (`Invalid 'input[27].id': 'item_…'. Expected
 * an ID that begins with 'msg'`). Thread providers on the unified channel point at this local
 * forwarder instead of the proxy's `/u/v1`: it drops such ids (an input item needs none; content
 * and `call_id` links stay) and passes everything else through to the proxy unchanged. A reasoning
 * item another upstream encrypted cannot be read by this one; when the upstream rejects the
 * request for that, it is sent once more without reasoning items.
 */

/** The id prefix the official API issues per item type; another prefix means another upstream. */
const OFFICIAL_ID_PREFIX: Readonly<Record<string, string>> = {
  message: "msg_",
  function_call: "fc_",
  custom_tool_call: "ctc_",
  reasoning: "rs_",
};
/** Item ids relays issue that the official API never does. */
const FOREIGN_ID = /^item_/u;
const MAX_BODY = 512 * 1024 * 1024;
const MAX_ERROR_BODY = 256 * 1024;
const REASONING_REJECTED = /encrypted|reasoning|\brs_/iu;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A copy of `record` without `keys`. */
function without<T extends object>(record: T, keys: readonly string[]): T {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key))) as T;
}

/** Whether an input item carries an id the official API would refuse. */
function foreignId(item: JsonRecord): boolean {
  const id = item.id;
  if (typeof id !== "string") return false;
  const expected = typeof item.type === "string" ? OFFICIAL_ID_PREFIX[item.type] : undefined;
  return expected ? !id.startsWith(expected) : FOREIGN_ID.test(id);
}

/**
 * The request with foreign item ids removed (and, with `dropReasoning`, without reasoning items);
 * `null` when nothing needed to change.
 */
export function sanitizeResponsesRequest(body: unknown, dropReasoning = false): JsonRecord | null {
  if (!isRecord(body) || !Array.isArray(body.input)) return null;
  let changed = false;
  const input: unknown[] = [];
  for (const item of body.input) {
    if (!isRecord(item)) {
      input.push(item);
      continue;
    }
    if (item.type === "reasoning" && (dropReasoning || foreignId(item))) {
      changed = true;
      continue;
    }
    if (foreignId(item)) {
      input.push(without(item, ["id"]));
      changed = true;
      continue;
    }
    input.push(item);
  }
  return changed ? { ...body, input } : null;
}

function hasReasoning(body: JsonRecord): boolean {
  return (
    Array.isArray(body.input) &&
    body.input.some((item) => isRecord(item) && item.type === "reasoning")
  );
}

function decode(body: Buffer, encoding: string | undefined): Buffer | null {
  const kind = (encoding ?? "identity").trim().toLowerCase();
  try {
    if (kind === "" || kind === "identity") return body;
    if (kind === "gzip") return zlib.gunzipSync(body);
    if (kind === "deflate") return zlib.inflateSync(body);
    if (kind === "br") return zlib.brotliDecompressSync(body);
    const zstd = (zlib as unknown as { zstdDecompressSync?: (input: Buffer) => Buffer })
      .zstdDecompressSync;
    if (kind === "zstd" && zstd) return zstd(body);
  } catch {
    return null;
  }
  return null;
}

async function readAll(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

interface Upstream {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly response: http.IncomingMessage;
}

export class UnifiedResponsesForwarder {
  #server: http.Server | null = null;
  #listening: Promise<string> | null = null;
  /** The proxy's origin (`http://127.0.0.1:<port>`) requests go to. */
  #target = "";

  /** This forwarder's `/u/v1` URL for a proxy whose unified URL is `proxyUnifiedUrl`. */
  async url(proxyUnifiedUrl: string): Promise<string> {
    this.#target = new URL(proxyUnifiedUrl).origin;
    const origin = await this.#listen();
    return `${origin}${new URL(proxyUnifiedUrl).pathname.replace(/\/+$/u, "")}`;
  }

  close(): void {
    this.#server?.close();
    this.#server = null;
    this.#listening = null;
  }

  #listen(): Promise<string> {
    this.#listening ??= new Promise<string>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.#forward(request, response).catch(() => {
          if (!response.headersSent) {
            response.writeHead(502, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "RLY/0 Hub 本地转发失败" } }));
          } else response.destroy();
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.unref();
        this.#server = server;
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
    return this.#listening;
  }

  #send(
    request: http.IncomingMessage,
    headers: http.OutgoingHttpHeaders,
    body: Buffer | null,
  ): Promise<Upstream> {
    const target = new URL(request.url ?? "/", this.#target);
    return new Promise((resolve, reject) => {
      const upstream = http.request(
        target,
        { method: request.method, headers: { ...headers, host: target.host } },
        (response) =>
          resolve({ status: response.statusCode ?? 502, headers: response.headers, response }),
      );
      upstream.once("error", reject);
      if (body) upstream.end(body);
      else request.pipe(upstream);
    });
  }

  async #forward(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.#target) throw new Error("no proxy");
    const path = new URL(request.url ?? "/", "http://local").pathname;
    const rewritable = request.method === "POST" && /\/responses$/u.test(path);
    if (!rewritable) return this.#relay(await this.#send(request, request.headers, null), response);

    const raw = await readAll(request, MAX_BODY);
    if (!raw) throw new Error("request too large");
    const decoded = decode(raw, request.headers["content-encoding"] as string | undefined);
    let parsed: unknown = null;
    try {
      parsed = decoded ? JSON.parse(decoded.toString("utf8")) : null;
    } catch {
      parsed = null;
    }
    // Anything unreadable goes on exactly as it came.
    if (!isRecord(parsed))
      return this.#relay(await this.#send(request, request.headers, raw), response);

    const plainHeaders = (): http.OutgoingHttpHeaders =>
      without(request.headers, ["content-encoding", "content-length"]);
    const cleaned = sanitizeResponsesRequest(parsed);
    const first = cleaned
      ? await this.#send(request, plainHeaders(), Buffer.from(JSON.stringify(cleaned)))
      : await this.#send(request, request.headers, raw);
    const sent = cleaned ?? parsed;
    if (first.status !== 400 || !hasReasoning(sent)) return this.#relay(first, response);

    // A 400 is small: read it to see whether another upstream's reasoning was the problem.
    const errorBody = await readAll(first.response, MAX_ERROR_BODY);
    const text = errorBody
      ? (decode(errorBody, first.headers["content-encoding"] as string) ?? errorBody).toString(
          "utf8",
        )
      : "";
    if (!errorBody || !REASONING_REJECTED.test(text)) {
      response.writeHead(first.status, without(first.headers, ["content-length"]));
      response.end(errorBody ?? undefined);
      return;
    }
    const retry = sanitizeResponsesRequest(sent, true) ?? sent;
    this.#relay(
      await this.#send(request, plainHeaders(), Buffer.from(JSON.stringify(retry))),
      response,
    );
  }

  #relay(upstream: Upstream, response: http.ServerResponse): void {
    response.writeHead(upstream.status, upstream.headers);
    upstream.response.pipe(response);
    response.once("close", () => upstream.response.destroy());
  }
}
