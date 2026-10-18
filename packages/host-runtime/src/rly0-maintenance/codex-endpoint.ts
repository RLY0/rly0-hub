import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Rly0MaintenanceCodexEndpoint } from "@codexhost/shared-contracts";
import { parse as parseToml } from "smol-toml";

/**
 * "Can Codex actually reach where it sends model requests?" The other diagnostics only look at
 * files; a config pointing at a local bridge or proxy that is not running looks perfectly healthy
 * on disk while every Codex turn hangs on "正在重新连接". This reads the same config Codex reads,
 * resolves the base URL a new turn would use, and makes one cheap request to it. Any HTTP answer
 * (even 401/404/502) means something is listening; only a network failure counts as down.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
const OFFICIAL_CHATGPT = "https://chatgpt.com/backend-api/codex";

type Table = Record<string, unknown>;
const table = (value: unknown): Table | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Table) : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export interface ResolvedCodexEndpoint {
  readonly url: string;
  readonly source: Rly0MaintenanceCodexEndpoint["source"];
  readonly providerId: string | null;
}

/** Same precedence as Codex: active profile → model_provider → its base_url / openai_base_url. */
export function resolveCodexEndpoint(config: Table): ResolvedCodexEndpoint {
  const profileName = text(config.profile);
  const profile = profileName ? table(table(config.profiles)?.[profileName]) : null;
  const providerId = text(profile?.model_provider) ?? text(config.model_provider) ?? "openai";
  const provider = table(table(config.model_providers)?.[providerId]);
  const providerUrl = text(provider?.base_url);
  if (providerUrl) return { url: providerUrl, source: "provider", providerId };
  if (providerId === "openai") {
    const override = text(profile?.openai_base_url) ?? text(config.openai_base_url);
    if (override) return { url: override, source: "openai_base_url", providerId };
  }
  return { url: OFFICIAL_CHATGPT, source: "default", providerId };
}

/** Never shows credentials or query strings, even if someone put a key into the URL. */
export function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return "";
  }
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    return LOOPBACK.has(new URL(raw).hostname.toLowerCase());
  } catch {
    return false;
  }
}

type Fetcher = (
  url: string,
  init: { signal: AbortSignal; method: string },
) => Promise<{
  status: number;
}>;

export async function probeEndpoint(
  raw: string,
  options: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<Pick<Rly0MaintenanceCodexEndpoint, "reachable" | "failure" | "httpStatus">> {
  let url: URL;
  try {
    url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
  } catch {
    return { reachable: false, failure: "BAD_URL" };
  }
  const target = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "")}/models`;
  const fetcher: Fetcher = options.fetcher ?? ((u, init) => fetch(u, init));
  try {
    const response = await fetcher(target, {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? 4000),
    });
    return { reachable: true, httpStatus: response.status };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    const code = String(
      (error as { cause?: { code?: string } })?.cause?.code ??
        (error as { code?: string })?.code ??
        "",
    );
    if (name === "TimeoutError" || name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT")
      return { reachable: false, failure: "TIMEOUT" };
    if (code === "ECONNREFUSED") return { reachable: false, failure: "REFUSED" };
    return { reachable: false, failure: "UNREACHABLE" };
  }
}

/** Local bridges we can name and start. Only ever reads their non-secret port setting. */
export interface KnownEndpointApp {
  readonly id: "codex-web-gpt";
  readonly name: string;
  readonly executable: string;
  readonly args: readonly string[];
}

export async function findEndpointApp(
  raw: string,
  environment: NodeJS.ProcessEnv,
): Promise<KnownEndpointApp | null> {
  let port: number;
  try {
    const url = new URL(raw);
    port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
  const home = environment.USERPROFILE || os.homedir();
  try {
    const config = JSON.parse(
      await fs.readFile(path.join(home, ".codex-chatgpt-web", "config.json"), "utf8"),
    ) as { port?: unknown };
    if (Number(config.port) !== port) return null;
  } catch {
    return null;
  }
  const localAppData = environment.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const executable = path.join(localAppData, "Programs", "Codex Web GPT", "Codex Web GPT.exe");
  try {
    if (!(await fs.stat(executable)).isFile()) return null;
  } catch {
    return null;
  }
  return { id: "codex-web-gpt", name: "Codex Web GPT", executable, args: ["--hidden"] };
}

export function launchEndpointApp(app: KnownEndpointApp): void {
  const child = spawn(app.executable, [...app.args], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export async function checkCodexEndpoint(
  configPath: string,
  environment: NodeJS.ProcessEnv,
  options: { fetcher?: Fetcher } = {},
): Promise<Rly0MaintenanceCodexEndpoint | null> {
  let config: Table;
  try {
    config = table(parseToml(await fs.readFile(configPath, "utf8"))) ?? {};
  } catch {
    // Missing or broken config.toml has its own row; Codex then uses the official service.
    config = {};
  }
  const resolved = resolveCodexEndpoint(config);
  const local = isLoopbackUrl(resolved.url);
  const probe = await probeEndpoint(resolved.url, {
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    timeoutMs: local ? 3000 : 6000,
  });
  const app = !probe.reachable && local ? await findEndpointApp(resolved.url, environment) : null;
  return {
    url: displayUrl(resolved.url),
    source: resolved.source,
    providerId: resolved.providerId,
    local,
    ...probe,
    ...(app ? { app: { id: app.id, name: app.name } } : {}),
  };
}
