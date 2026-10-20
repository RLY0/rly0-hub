import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";

import type { ArtifactSource } from "@codexhost/update-manager";
import type { Rly0ProxySettings } from "@codexhost/shared-contracts";

/**
 * The network side of the Hub's own update: HTTPS GET through the proxy the user chose (Hub
 * setting, then HTTPS_PROXY, then the Windows system proxy), and an installer download that
 * continues a partial file with an HTTP Range request. Uses only Node built-ins, because the
 * Hub service bundle admits no other runtime packages.
 */

/** Errors carry one of these as their message, so the window can say what actually went wrong. */
export type HubUpdateNetErrorCode =
  "UPDATE_RATE_LIMITED" | "UPDATE_NETWORK" | "UPDATE_DOWNLOAD_FAILED";

/** An HTTP answer that is not a success; the caller decides what the status means. */
export class HubUpdateHttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Readonly<Record<string, string | undefined>>,
  ) {
    super(`HTTP ${status}`);
  }
}

export interface UpdateHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Stops reading and frees the connection. */
  cancel(): void;
}

/**
 * GET `url`, following HTTPS redirects. Rejects with `UPDATE_NETWORK` when no answer arrives
 * (DNS, refused, proxy, timeout); any HTTP status is returned to the caller.
 */
export type UpdateHttpGet = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => Promise<UpdateHttpResponse>;

const USER_AGENT = "rly0-hub-updater";
const MAX_REDIRECTS = 5;

function networkError(cause: unknown): Error {
  return new Error("UPDATE_NETWORK", { cause });
}

function singleHeaders(raw: http.IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(raw))
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  return out;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/u, "$1");
}

/** Opens a CONNECT tunnel to `host:port` through an HTTP(S) proxy. */
function tunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `${host}:${port}`, "user-agent": USER_AGENT };
    if (proxy.username) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["proxy-authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }
    const secure = proxy.protocol === "https:";
    const request = (secure ? https : http).request({
      host: hostOf(proxy),
      port: Number(proxy.port) || (secure ? 443 : 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      agent: false,
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("proxy CONNECT timed out")));
    request.once("connect", (response, socket) => {
      request.setTimeout(0);
      if (response.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`proxy CONNECT answered HTTP ${response.statusCode ?? 0}`));
      }
    });
    request.once("error", reject);
    request.end();
  });
}

async function requestOnce(
  url: URL,
  headers: Readonly<Record<string, string>>,
  proxy: URL | null,
  timeoutMs: number,
): Promise<http.IncomingMessage> {
  const host = hostOf(url);
  const port = Number(url.port) || 443;
  const socket = proxy ? await tunnel(proxy, host, port, timeoutMs) : null;
  return new Promise((resolve, reject) => {
    const request = https.request({
      host,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { "user-agent": USER_AGENT, ...headers },
      servername: host,
      ...(socket ? { createConnection: () => tls.connect({ socket, servername: host }) } : {}),
    });
    // An idle limit, not a total one: a slow but moving download keeps going.
    request.setTimeout(timeoutMs, () => request.destroy(new Error("connection timed out")));
    request.once("response", resolve);
    request.once("error", reject);
    request.end();
  });
}

/** A GET that honours `proxy` (an `http(s)://` URL, or null for a direct connection). */
export function createUpdateHttpGet(options: {
  readonly proxy: string | null;
  readonly timeoutMs?: number;
}): UpdateHttpGet {
  const proxy = options.proxy ? new URL(options.proxy) : null;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return async (target, headers) => {
    let url = new URL(target);
    for (let hop = 0; ; hop += 1) {
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("UPDATE_DOWNLOAD_FAILED");
      let response: http.IncomingMessage;
      try {
        response = await requestOnce(url, headers, proxy, timeoutMs);
      } catch (error) {
        throw networkError(error);
      }
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        response.destroy();
        if (hop >= MAX_REDIRECTS) throw new Error("UPDATE_DOWNLOAD_FAILED");
        url = new URL(location, url);
        continue;
      }
      return {
        status,
        headers: singleHeaders(response.headers),
        body: response,
        cancel: () => response.destroy(),
      };
    }
  };
}

/** Reads a small JSON answer (at most `limit` bytes); non-2xx becomes `HubUpdateHttpError`. */
export async function getUpdateJson(
  get: UpdateHttpGet,
  url: string,
  headers: Readonly<Record<string, string>> = {},
  limit = 1024 * 1024,
): Promise<unknown> {
  const response = await get(url, { accept: "application/json", ...headers });
  if (response.status < 200 || response.status > 299) {
    response.cancel();
    throw new HubUpdateHttpError(response.status, response.headers);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("answer too large");
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    response.cancel();
    throw networkError(error);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

// ---------------------------------------------------------------------------------------------
// Proxy choice

const PROXY_ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
];

/** `host:port` or a URL; only HTTP(S) proxies can carry the CONNECT tunnel. */
export function normalizeUpdateProxy(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `http://${text}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function bypassedByNoProxy(environment: NodeJS.ProcessEnv, host: string): boolean {
  const list = environment.NO_PROXY ?? environment.no_proxy ?? "";
  return list
    .split(/[,\s]+/u)
    .map((entry) =>
      entry
        .trim()
        .toLowerCase()
        .replace(/^\*?\./u, ""),
    )
    .some(
      (entry) => entry === "*" || (entry !== "" && (host === entry || host.endsWith(`.${entry}`))),
    );
}

/**
 * Picks the proxy for GitHub: the Hub's own setting first (`direct` means none, `custom` its URL);
 * with `system`, HTTPS_PROXY and friends, and then the Windows system proxy.
 */
export async function resolveUpdateProxy(input: {
  readonly settings: Rly0ProxySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly systemProxy: () => Promise<string | null>;
}): Promise<string | null> {
  if (input.settings.mode === "direct") return null;
  if (input.settings.mode === "custom") return normalizeUpdateProxy(input.settings.url);
  if (bypassedByNoProxy(input.environment, "github.com")) return null;
  for (const name of PROXY_ENV) {
    const value = input.environment[name];
    if (value?.trim()) return normalizeUpdateProxy(value);
  }
  return normalizeUpdateProxy(await input.systemProxy().catch(() => null));
}

/**
 * The proxy from `reg query` of HKCU Internet Settings, when ProxyEnable is on. `ProxyServer` is
 * either `host:port` or per-scheme (`http=a:1;https=b:2;socks=c:3`); SOCKS alone is not usable.
 */
export function parseWindowsProxyQuery(stdout: string): string | null {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s+(ProxyEnable|ProxyServer)\s+REG_\w+\s+(.*)$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2].trim());
  }
  const enabled = values.get("ProxyEnable");
  if (!enabled || Number(enabled) === 0) return null;
  const server = values.get("ProxyServer");
  if (!server) return null;
  if (!server.includes("=")) return normalizeUpdateProxy(server);
  const schemes = new Map<string, string>();
  for (const part of server.split(";")) {
    const [scheme, address] = part.split("=", 2);
    if (scheme && address) schemes.set(scheme.trim().toLowerCase(), address.trim());
  }
  return normalizeUpdateProxy(schemes.get("https") ?? schemes.get("http") ?? null);
}

export function readWindowsSystemProxy(platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    execFile(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(error ? null : parseWindowsProxyQuery(String(stdout))),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Download that resumes

export interface ResumableDownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number | undefined;
}

/**
 * Downloads `source` into `partialPath`, continuing what an earlier attempt left there when the
 * server honours Range (otherwise it starts over). Returns the file size; the caller still has to
 * verify the SHA-256 before using the file.
 */
export async function downloadResumable(
  get: UpdateHttpGet,
  source: ArtifactSource,
  partialPath: string,
  onProgress?: (progress: ResumableDownloadProgress) => void,
): Promise<{ bytes: number }> {
  let have = await fs
    .stat(partialPath)
    .then((stat) => (stat.isFile() ? stat.size : 0))
    .catch(() => 0);
  if (source.size !== undefined && have > source.size) {
    await fs.rm(partialPath, { force: true });
    have = 0;
  }
  if (source.size !== undefined && have === source.size) {
    onProgress?.({ downloadedBytes: have, totalBytes: source.size });
    return { bytes: have };
  }
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  if (have > 0) headers.range = `bytes=${have}-`;
  const response = await get(source.url, headers);
  let start: number;
  if (response.status === 206 && have > 0) {
    const range = /^bytes (\d+)-\d+\/(\d+|\*)$/u.exec(response.headers["content-range"] ?? "");
    if (!range || Number(range[1]) !== have) {
      response.cancel();
      await fs.rm(partialPath, { force: true });
      throw new Error("UPDATE_DOWNLOAD_FAILED");
    }
    start = have;
  } else if (response.status === 200) {
    start = 0;
  } else {
    response.cancel();
    // The saved part no longer fits what the server has; the next attempt starts fresh.
    if (response.status === 416) await fs.rm(partialPath, { force: true });
    throw new Error("UPDATE_DOWNLOAD_FAILED", {
      cause: new HubUpdateHttpError(response.status, response.headers),
    });
  }
  const file = await fs.open(partialPath, start === 0 ? "w" : "a", 0o600);
  let bytes = start;
  try {
    onProgress?.({ downloadedBytes: bytes, totalBytes: source.size });
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (source.size !== undefined && bytes > source.size) throw new Error("larger than expected");
      await file.write(chunk);
      onProgress?.({ downloadedBytes: bytes, totalBytes: source.size });
    }
    await file.sync();
  } catch (error) {
    response.cancel();
    // What arrived stays on disk so a retry continues from there.
    throw new Error("UPDATE_DOWNLOAD_FAILED", { cause: error });
  } finally {
    await file.close();
  }
  if (source.size !== undefined && bytes !== source.size)
    throw new Error("UPDATE_DOWNLOAD_FAILED", { cause: new Error("download ended early") });
  return { bytes };
}
