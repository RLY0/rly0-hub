import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { resolveCodexHome } from "../rly0-mcp/file-io.js";

/**
 * "统一渠道（一个对话里随便切换账号和中转）": every Codex conversation runs on the one `rly0`
 * provider (RLY/0 Hub's local proxy, unified path `/u/v1`), and the proxy picks the upstream per
 * request from the chosen model: official names go to the account Codex is signed in with,
 * `rly0/<relay>/<model>` to that relay, `cfg/<provider>/<model>` to a provider of config.toml.
 *
 * On by default. The setting lives in RLY/0 Hub's data directory only; turning it on or off
 * never writes Codex's config.toml (the provider is defined per conversation at load time), so
 * "off" is exactly the earlier behavior.
 */
export const RLY0_UNIFIED_CHANNEL_FILE = "unified-channel.json";

export function unifiedChannelPath(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveRly0DataDir(environment), RLY0_UNIFIED_CHANNEL_FILE);
}

/** Whether the unified channel is on; a missing or unreadable file means the default (on). */
export async function readUnifiedChannel(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const value = JSON.parse(await fs.readFile(unifiedChannelPath(environment), "utf8")) as unknown;
    if (typeof value === "object" && value !== null && "enabled" in value)
      return (value as { enabled: unknown }).enabled !== false;
    return true;
  } catch {
    return true;
  }
}

export async function writeUnifiedChannel(
  enabled: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const target = unifiedChannelPath(environment);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`, "utf8");
  await fs.rename(temp, target);
}

/**
 * Whether Codex is signed in with an API key (`auth.json` holds `OPENAI_API_KEY` and no ChatGPT
 * tokens). Only the shape is looked at; no value leaves this function.
 */
export async function codexSignedInWithApiKey(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const auth = JSON.parse(
      await fs.readFile(path.join(resolveCodexHome(environment), "auth.json"), "utf8"),
    ) as Record<string, unknown>;
    if (auth.auth_mode === "apikey") return true;
    const hasKey = typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim() !== "";
    const hasTokens = typeof auth.tokens === "object" && auth.tokens !== null;
    return hasKey && !hasTokens;
  } catch {
    return false;
  }
}

/** The proxy's unified path: `http://127.0.0.1:<port>/v1` becomes `.../u/v1`. */
export function unifiedBaseUrl(proxyBaseUrl: string): string {
  const trimmed = proxyBaseUrl.replace(/\/+$/u, "");
  return trimmed.endsWith("/v1") ? `${trimmed.slice(0, -3)}/u/v1` : `${trimmed}/u/v1`;
}
