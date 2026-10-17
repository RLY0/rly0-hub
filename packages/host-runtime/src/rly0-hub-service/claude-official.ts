import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Rly0Relay } from "@codexhost/shared-contracts";

import type { Rly0CoreBridge } from "../rly0-core/index.js";

/**
 * Claude Code's two other official sign-ins, next to the browser login:
 * - an Anthropic API key (`sk-ant-...`), kept encrypted by rly0-core like a relay key and sent by
 *   the local proxy to api.anthropic.com as `x-api-key`; Claude Code never sees it;
 * - importing a `.credentials.json` copied from another computer's `~/.claude` folder. The
 *   current file is backed up next to it first.
 */
export const ANTHROPIC_API_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,300}$/u;
export const ANTHROPIC_OFFICIAL_NAME = "Anthropic 官方 API Key";
export const ANTHROPIC_OFFICIAL_BASE_URL = "https://api.anthropic.com";

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code: -32000 });
}

/** The saved entry that holds the person's own Anthropic key (not a relay). */
export function isAnthropicOfficial(relay: Pick<Rly0Relay, "baseUrl">): boolean {
  try {
    return new URL(relay.baseUrl).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

/** Saves (or replaces) the key and returns the entry id Claude Code should be pinned to. */
export async function saveAnthropicApiKey(
  core: Pick<Rly0CoreBridge, "listRelays" | "addRelay" | "updateRelay">,
  apiKey: string,
): Promise<{ id: string }> {
  const key = apiKey.trim();
  if (!ANTHROPIC_API_KEY_PATTERN.test(key)) throw codedError("API_KEY_INVALID");
  const list = await core.listRelays();
  if (!list.available) throw codedError("RLY0_CORE_UNAVAILABLE");
  const existing = list.relays.find(isAnthropicOfficial);
  if (existing) {
    const updated = await core.updateRelay({ id: existing.id, apiKey: key, enabled: true });
    if (!updated.available) throw codedError("RLY0_CORE_UNAVAILABLE");
    return { id: existing.id };
  }
  const added = await core.addRelay({
    name: ANTHROPIC_OFFICIAL_NAME,
    baseUrl: ANTHROPIC_OFFICIAL_BASE_URL,
    apiKey: key,
    models: [],
    enabled: true,
  });
  if (!added.available) throw codedError("RLY0_CORE_UNAVAILABLE");
  return { id: added.id };
}

/** Checks a picked file is a Claude Code login before anything is written. */
export function parseClaudeCredentials(content: string): string {
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^﻿/u, ""));
  } catch {
    throw codedError("AUTH_FILE_INVALID");
  }
  const oauth =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).claudeAiOauth
      : undefined;
  const token =
    typeof oauth === "object" && oauth !== null
      ? (oauth as Record<string, unknown>).accessToken
      : undefined;
  if (typeof token !== "string" || token.length < 10) throw codedError("AUTH_FILE_NOT_A_LOGIN");
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function claudeConfigDir(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(environment.USERPROFILE || os.homedir(), ".claude");
}

export async function importClaudeCredentials(
  environment: NodeJS.ProcessEnv,
  content: string,
  now: () => number = Date.now,
): Promise<{ ok: true; backup: string | null }> {
  const json = parseClaudeCredentials(content);
  const directory = claudeConfigDir(environment);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, ".credentials.json");
  let backup: string | null = null;
  try {
    await fs.access(file);
    backup = `${file}.rly0-backup-${now()}`;
    await fs.copyFile(file, backup);
  } catch {
    backup = null;
  }
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, json, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
  return { ok: true, backup };
}
