import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { RLY0_OFFICIAL_VENDORS, type Rly0OfficialVendor } from "../rly0-relay/official-keys.js";

/**
 * Finds API keys, subscription tokens and relays that the agents on this computer are already set
 * up with outside a sign-in, so the Hub can take them over in one click instead of the person
 * pasting them again:
 *
 * - environment variables (the process's own and the user's saved ones in `HKCU\Environment`):
 *   `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`,
 *   `OPENAI_API_KEY` + `OPENAI_BASE_URL`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `XAI_API_KEY`;
 * - Claude Code's `settings.json` `env` block (where cc-switch and most guides put a relay);
 * - Claude Code's own stored login when it is a long-lived `claude setup-token` token: newer
 *   versions keep it in Windows Credential Manager (`Claude Code-credentials…`), older ones in
 *   `~/.claude/.credentials.json`;
 * - Codex's `config.toml` model providers and the API key in `auth.json`;
 * - `~/.gemini/.env` and Grok CLI's `~/.grok/user-settings.json`.
 *
 * Only the server side ever holds the values. What the window gets is a masked list; importing
 * names entries by id and the scan runs again to fetch the value.
 */

export type DiscoveredKind = "officialKey" | "relay";

export interface DiscoveredItem {
  readonly id: string;
  readonly kind: DiscoveredKind;
  /** Official keys: whose. Relays: which protocol the agent speaks to it. */
  readonly vendor: Rly0OfficialVendor;
  readonly name: string;
  readonly baseUrl: string | null;
  readonly keyMask: string;
  /** Where it was found, in words (`环境变量 ANTHROPIC_API_KEY`, `~/.claude/settings.json`). */
  readonly source: string;
  /** Which agent uses it there. */
  readonly agent: "claude" | "codex" | "gemini" | "grok" | "any";
  /** Codex relays: the model Codex is set to use with it, if any. */
  readonly model: string | null;
}

export interface DiscoveredSecret extends DiscoveredItem {
  readonly secret: string;
}

export interface LocalDiscoveryOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** User environment variables saved in the registry; read with `reg.exe` when omitted. */
  readonly userEnvironment?: () => Promise<Record<string, string>>;
  /** Claude Code's stored credentials (JSON); read from Credential Manager when omitted. */
  readonly claudeCredentials?: () => Promise<string[]>;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/iu;

function mask(secret: string): string {
  return `····${secret.slice(-4)}`;
}

function cleanBase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/u, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (LOOPBACK.test(url.hostname)) return null; // our own proxy, AiMaMi's router and the like
    return trimmed;
  } catch {
    return null;
  }
}

function hostOf(base: string): string {
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return base;
  }
}

function officialHost(base: string): Rly0OfficialVendor | null {
  const host = hostOf(base);
  for (const [vendor, spec] of Object.entries(RLY0_OFFICIAL_VENDORS))
    if (spec.host === host) return vendor as Rly0OfficialVendor;
  return null;
}

function plausibleSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 16 &&
    value.trim().length <= 1024 &&
    !/\s/u.test(value.trim())
  );
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  const text = await readText(file);
  if (!text) return null;
  try {
    const value = JSON.parse(text.replace(/^﻿/u, "")) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `KEY=value` lines (dotenv). */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    const [, name, value] = match ?? [];
    if (name && value !== undefined) out[name] = value.replace(/^(['"])(.*)\1$/u, "$2");
  }
  return out;
}

function readRegistryEnvironment(): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", "HKCU\\Environment"],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => {
        if (error) return resolve({});
        const out: Record<string, string> = {};
        for (const line of String(stdout).split(/\r?\n/u)) {
          const match = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/u.exec(line);
          const [, name, value] = match ?? [];
          if (name && value !== undefined) out[name] = value.trim();
        }
        resolve(out);
      },
    );
  });
}

/**
 * Claude Code's entries in Windows Credential Manager (`Claude Code-credentials`, plus a hash
 * suffix for a non-default config folder), read with CredEnumerate. Returns the stored JSON.
 */
function readClaudeCredentialManager(): Promise<string[]> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Rly0Cred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredEnumerate(string filter, int flags, out int count, out IntPtr creds);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
  public static string[] Read(string filter) {
    int count; IntPtr list;
    if (!CredEnumerate(filter, 0, out count, out list)) return new string[0];
    var result = new string[count];
    for (int i = 0; i < count; i++) {
      var item = (CREDENTIAL)Marshal.PtrToStructure(Marshal.ReadIntPtr(list, i * IntPtr.Size), typeof(CREDENTIAL));
      var bytes = new byte[item.CredentialBlobSize];
      if (item.CredentialBlobSize > 0) Marshal.Copy(item.CredentialBlob, bytes, 0, item.CredentialBlobSize);
      result[i] = Convert.ToBase64String(bytes);
    }
    CredFree(list);
    return result;
  }
}
'@
[Rly0Cred]::Read('Claude Code-credentials*') | ForEach-Object { Write-Output $_ }
`;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve([]);
        const out: string[] = [];
        for (const line of String(stdout).split(/\r?\n/u)) {
          const b64 = line.trim();
          if (!/^[A-Za-z0-9+/=]{8,}$/u.test(b64)) continue;
          const bytes = Buffer.from(b64, "base64");
          // Written as UTF-8 by Claude Code; UTF-16 when set with cmdkey or other tools.
          const text = bytes.includes(0) ? bytes.toString("utf16le") : bytes.toString("utf8");
          out.push(text.replace(/\0+$/u, ""));
        }
        resolve(out);
      },
    );
  });
}

/** A stored Claude Code login that is a long-lived `setup-token` token (no refresh token). */
function setupTokenOf(json: string): string | null {
  try {
    const oauth = (JSON.parse(json.replace(/^\uFEFF/u, "")) as Record<string, unknown>)
      .claudeAiOauth as Record<string, unknown> | undefined;
    const token = oauth?.accessToken;
    if (typeof token !== "string" || !token.startsWith("sk-ant-oat")) return null;
    // A browser sign-in rotates its token with a refresh token; that one is an account login,
    // which the Claude account list handles, not a key to keep.
    return typeof oauth?.refreshToken === "string" && oauth.refreshToken ? null : token;
  } catch {
    return null;
  }
}

export class Rly0LocalDiscovery {
  readonly #options: LocalDiscoveryOptions;

  constructor(options: LocalDiscoveryOptions) {
    this.#options = options;
  }

  #home(): string {
    return this.#options.environment.USERPROFILE || this.#options.environment.HOME || os.homedir();
  }

  /** Everything found, values included. Server side only. */
  async scanSecrets(): Promise<DiscoveredSecret[]> {
    const found: DiscoveredSecret[] = [];
    const seen = new Set<string>();
    const add = (item: Omit<DiscoveredSecret, "id" | "keyMask">): void => {
      const secret = item.secret.trim();
      // One entry per value and destination, however many places repeat it.
      const id = createHash("sha256")
        .update(`${item.kind}|${item.vendor}|${item.baseUrl ?? ""}|${secret}`)
        .digest("hex")
        .slice(0, 16);
      if (seen.has(id)) return;
      seen.add(id);
      found.push({ ...item, secret, id, keyMask: mask(secret) });
    };

    // Environment: the process's own, then the user's saved variables (set after login).
    const windows = (this.#options.platform ?? process.platform) === "win32";
    const saved = await (
      this.#options.userEnvironment ?? (windows ? readRegistryEnvironment : async () => ({}))
    )().catch(() => ({}));
    const env: Record<string, string | undefined> = { ...saved, ...this.#options.environment };
    this.#anthropicFrom(env, "环境变量", add);
    this.#openaiFrom(env, "环境变量", add);
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
      const value = env[name];
      if (plausibleSecret(value) && RLY0_OFFICIAL_VENDORS.google.pattern.test(value.trim()))
        add(official("google", value, `环境变量 ${name}`, "gemini"));
    }
    for (const name of ["XAI_API_KEY", "GROK_API_KEY"]) {
      const value = env[name];
      if (plausibleSecret(value) && RLY0_OFFICIAL_VENDORS.xai.pattern.test(value.trim()))
        add(official("xai", value, `环境变量 ${name}`, "grok"));
    }

    // Claude Code's settings.json `env` block.
    const claudeDir =
      this.#options.environment.CLAUDE_CONFIG_DIR?.trim() || path.join(this.#home(), ".claude");
    for (const file of ["settings.json", "settings.local.json"]) {
      const settings = await readJson(path.join(claudeDir, file));
      const block = settings?.env;
      if (block && typeof block === "object")
        this.#anthropicFrom(
          block as Record<string, string | undefined>,
          `~/.claude/${file}`,
          add,
          true,
        );
    }

    // Claude Code's stored login, when it is a setup-token token.
    const stored = await (
      this.#options.claudeCredentials ?? (windows ? readClaudeCredentialManager : async () => [])
    )().catch(() => []);
    for (const json of stored) {
      const token = setupTokenOf(json);
      if (token)
        add(official("anthropic", token, "Windows 凭据管理器（Claude Code 登录）", "claude"));
    }
    const credentialsFile = await readText(path.join(claudeDir, ".credentials.json"));
    const fileToken = credentialsFile ? setupTokenOf(credentialsFile) : null;
    if (fileToken) add(official("anthropic", fileToken, "~/.claude/.credentials.json", "claude"));

    await this.#codex(add);

    // Gemini CLI's .env and Grok CLI's settings.
    const geminiEnv = await readText(path.join(this.#home(), ".gemini", ".env"));
    if (geminiEnv) {
      const values = parseDotenv(geminiEnv);
      for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
        const value = values[name];
        if (plausibleSecret(value) && RLY0_OFFICIAL_VENDORS.google.pattern.test(value.trim()))
          add(official("google", value, "~/.gemini/.env", "gemini"));
      }
    }
    const grok = await readJson(path.join(this.#home(), ".grok", "user-settings.json"));
    const grokKey = grok?.apiKey;
    if (plausibleSecret(grokKey)) {
      const base = cleanBase(grok?.baseURL ?? grok?.baseUrl);
      if (base && !officialHost(base))
        add(relay("xai", base, grokKey, "~/.grok/user-settings.json", "grok", null));
      else if (RLY0_OFFICIAL_VENDORS.xai.pattern.test(grokKey.trim()))
        add(official("xai", grokKey, "~/.grok/user-settings.json", "grok"));
    }
    return found;
  }

  /** The masked list for the window. */
  async scan(): Promise<DiscoveredItem[]> {
    return (await this.scanSecrets()).map((entry) => {
      const item: Record<string, unknown> = { ...entry };
      delete item.secret;
      return item as unknown as DiscoveredItem;
    });
  }

  #anthropicFrom(
    env: Record<string, string | undefined>,
    where: string,
    add: (item: Omit<DiscoveredSecret, "id" | "keyMask">) => void,
    file = false,
  ): void {
    const label = (name: string) => (file ? where : `${where} ${name}`);
    const base = cleanBase(env.ANTHROPIC_BASE_URL);
    const relayBase = base && !officialHost(base) ? base : null;
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      const value = env[name];
      if (!plausibleSecret(value)) continue;
      if (relayBase) add(relay("anthropic", relayBase, value, label(name), "claude", null));
      else if (RLY0_OFFICIAL_VENDORS.anthropic.pattern.test(value.trim()))
        add(official("anthropic", value, label(name), "claude"));
    }
    const oauth = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (plausibleSecret(oauth) && RLY0_OFFICIAL_VENDORS.anthropic.pattern.test(oauth.trim()))
      add(official("anthropic", oauth, label("CLAUDE_CODE_OAUTH_TOKEN"), "claude"));
  }

  #openaiFrom(
    env: Record<string, string | undefined>,
    where: string,
    add: (item: Omit<DiscoveredSecret, "id" | "keyMask">) => void,
  ): void {
    const value = env.OPENAI_API_KEY;
    if (!plausibleSecret(value)) return;
    const base = cleanBase(env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE);
    if (base && !officialHost(base))
      add(relay("openai", base, value, `${where} OPENAI_API_KEY`, "any", null));
    else if (RLY0_OFFICIAL_VENDORS.openai.pattern.test(value.trim()))
      add(official("openai", value, `${where} OPENAI_API_KEY`, "any"));
  }

  async #codex(add: (item: Omit<DiscoveredSecret, "id" | "keyMask">) => void): Promise<void> {
    const codexHome =
      this.#options.environment.CODEX_HOME?.trim() || path.join(this.#home(), ".codex");
    const auth = await readJson(path.join(codexHome, "auth.json"));
    const authKey = plausibleSecret(auth?.OPENAI_API_KEY) ? auth.OPENAI_API_KEY : null;
    let config: Record<string, unknown> = {};
    const text = await readText(path.join(codexHome, "config.toml"));
    if (text) {
      try {
        config = parseToml(text) as Record<string, unknown>;
      } catch {
        config = {};
      }
    }
    const providers = (config.model_providers ?? {}) as Record<string, Record<string, unknown>>;
    const active = typeof config.model_provider === "string" ? config.model_provider : null;
    const activeModel = typeof config.model === "string" ? config.model : null;
    let authKeyUsed = false;
    for (const [name, provider] of Object.entries(providers)) {
      if (typeof provider !== "object" || provider === null) continue;
      const base = cleanBase(provider.base_url);
      if (!base) continue;
      const envKey = typeof provider.env_key === "string" ? provider.env_key : null;
      let secret: unknown = provider.experimental_bearer_token;
      if (!plausibleSecret(secret) && envKey) secret = this.#options.environment[envKey];
      if (!plausibleSecret(secret) && provider.requires_openai_auth === true && authKey) {
        // cc-switch and similar tools put the relay's key in auth.json for the active provider.
        if (active === name || !active) {
          secret = authKey;
          authKeyUsed = true;
        }
      }
      if (!plausibleSecret(secret)) continue;
      const vendor = officialHost(base);
      const model = active === name ? activeModel : null;
      if (vendor) add(official(vendor, secret, "~/.codex/config.toml", "codex"));
      else add(relay("openai", base, secret, `~/.codex/config.toml（${name}）`, "codex", model));
    }
    if (authKey && !authKeyUsed && RLY0_OFFICIAL_VENDORS.openai.pattern.test(authKey.trim()))
      add(official("openai", authKey, "~/.codex/auth.json", "codex"));
  }
}

function official(
  vendor: Rly0OfficialVendor,
  secret: string,
  source: string,
  agent: DiscoveredItem["agent"],
): Omit<DiscoveredSecret, "id" | "keyMask"> {
  const subscription = vendor === "anthropic" && secret.trim().startsWith("sk-ant-oat");
  return {
    kind: "officialKey",
    vendor,
    name: subscription ? "Claude 订阅令牌" : RLY0_OFFICIAL_VENDORS[vendor].name,
    baseUrl: null,
    secret,
    source,
    agent,
    model: null,
  };
}

function relay(
  vendor: Rly0OfficialVendor,
  baseUrl: string,
  secret: string,
  source: string,
  agent: DiscoveredItem["agent"],
  model: string | null,
): Omit<DiscoveredSecret, "id" | "keyMask"> {
  return {
    kind: "relay",
    vendor,
    name: hostOf(baseUrl),
    baseUrl,
    secret,
    source,
    agent,
    model,
  };
}
