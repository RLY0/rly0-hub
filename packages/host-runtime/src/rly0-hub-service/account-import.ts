import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Rly0CoreBridge } from "../rly0-core/index.js";

/**
 * Two more ways to add a Codex account from the Hub, besides a browser sign-in:
 * - importing an `auth.json` the person picked (e.g. exported from another computer);
 * - an OpenAI API key (`sk-...`), saved as an API-key login.
 * Either way the content is written to a throw-away `rly0-login-*` folder under the system temp
 * directory, imported by rly0-core (which encrypts it), and the folder is deleted right after.
 * The live Codex login is never touched.
 */
export const RLY0_API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,300}$/u;

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code: -32000 });
}

function lastFour(key: string): string {
  return key.slice(-4);
}

/** Checks the picked file is a Codex login and returns what to write plus a default name. */
export function parseAuthFile(content: string): { json: string; alias?: string } {
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^﻿/u, ""));
  } catch {
    throw codedError("AUTH_FILE_INVALID");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw codedError("AUTH_FILE_INVALID");
  }
  const auth = value as Record<string, unknown>;
  const tokens = auth.tokens;
  const hasTokens =
    typeof tokens === "object" &&
    tokens !== null &&
    typeof (tokens as Record<string, unknown>).id_token === "string";
  const apiKey = typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY.trim() : "";
  if (!hasTokens && !apiKey) throw codedError("AUTH_FILE_NOT_A_LOGIN");
  return {
    json: JSON.stringify(auth),
    ...(!hasTokens && apiKey ? { alias: `API Key ····${lastFour(apiKey)}` } : {}),
  };
}

/**
 * Every Codex login in a picked file: a Codex `auth.json`, or a Sub2API account export
 * (`{"type":"sub2api-data","accounts":[…]}`) whose OpenAI accounts are turned into auth.json.
 */
export function parseLoginFile(content: string): { json: string; alias?: string }[] {
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^﻿/u, ""));
  } catch {
    throw codedError("AUTH_FILE_INVALID");
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  if (!Array.isArray(record.accounts)) return [parseAuthFile(content)];
  const logins: { json: string; alias?: string }[] = [];
  for (const item of record.accounts.slice(0, 50)) {
    if (typeof item !== "object" || item === null) continue;
    const account = item as Record<string, unknown>;
    if (account.platform !== "openai") continue;
    const credentials = (account.credentials ?? {}) as Record<string, unknown>;
    const text = (key: string): string =>
      typeof credentials[key] === "string" ? (credentials[key] as string).trim() : "";
    const name =
      (typeof account.name === "string" && account.name.trim().slice(0, 40)) ||
      text("email").slice(0, 40) ||
      undefined;
    if (text("id_token") && text("access_token")) {
      logins.push({
        json: JSON.stringify({
          OPENAI_API_KEY: null,
          tokens: {
            id_token: text("id_token"),
            access_token: text("access_token"),
            refresh_token: text("refresh_token"),
            account_id: text("chatgpt_account_id") || undefined,
          },
          last_refresh: new Date().toISOString(),
        }),
        ...(name ? { alias: name } : {}),
      });
    } else if (text("api_key")) {
      logins.push({
        json: JSON.stringify({ OPENAI_API_KEY: text("api_key") }),
        alias: name ?? `API Key ····${lastFour(text("api_key"))}`,
      });
    }
  }
  if (!logins.length) throw codedError("AUTH_FILE_NOT_A_LOGIN");
  return logins;
}

export async function importLogin(
  core: Pick<Rly0CoreBridge, "importFrom">,
  authJson: string,
  alias?: string,
): Promise<{ id: string }> {
  const directory = path.join(os.tmpdir(), `rly0-login-${randomBytes(8).toString("hex")}`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(path.join(directory, "auth.json"), authJson, {
      encoding: "utf8",
      mode: 0o600,
    });
    const result = await core.importFrom({ codexHome: directory, ...(alias ? { alias } : {}) });
    if (!result.available) throw codedError("RLY0_CORE_UNAVAILABLE");
    return { id: result.id };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export function apiKeyLogin(apiKey: string): { json: string; alias: string } {
  const key = apiKey.trim();
  if (!RLY0_API_KEY_PATTERN.test(key)) throw codedError("API_KEY_INVALID");
  return { json: JSON.stringify({ OPENAI_API_KEY: key }), alias: `API Key ····${lastFour(key)}` };
}
