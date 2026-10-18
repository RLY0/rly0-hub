import { promises as fs } from "node:fs";
import path from "node:path";

import type { Rly0Relay } from "@codexhost/shared-contracts";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

/**
 * Official API keys of the model vendors, saved for agents to use (Claude Code uses the
 * Anthropic one directly; Pi, Hermes and OpenCode can use any of them). Each key is kept by
 * rly0-core like a relay pointed at the vendor's own OpenAI-compatible API, so the local proxy
 * adds it and agents never see it.
 *
 * The relay entry itself always lists no models: otherwise Codex's own requests for those models
 * would be routed to the key (silently billed). The vendor's model list is kept here instead,
 * only for the agents that choose the key.
 */
export type Rly0OfficialVendor = "openai" | "anthropic" | "google" | "xai";

export const RLY0_OFFICIAL_VENDORS: Readonly<
  Record<
    Rly0OfficialVendor,
    {
      readonly name: string;
      readonly baseUrl: string;
      readonly host: string;
      readonly pattern: RegExp;
    }
  >
> = {
  openai: {
    name: "OpenAI 官方 API Key",
    baseUrl: "https://api.openai.com/v1",
    host: "api.openai.com",
    pattern: /^sk-[A-Za-z0-9_-]{16,300}$/u,
  },
  anthropic: {
    name: "Anthropic 官方 API Key",
    baseUrl: "https://api.anthropic.com",
    host: "api.anthropic.com",
    pattern: /^sk-ant-[A-Za-z0-9_-]{20,300}$/u,
  },
  google: {
    name: "Google Gemini 官方 API Key",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    host: "generativelanguage.googleapis.com",
    pattern: /^[A-Za-z0-9_-]{30,80}$/u,
  },
  xai: {
    name: "xAI 官方 API Key",
    baseUrl: "https://api.x.ai/v1",
    host: "api.x.ai",
    pattern: /^xai-[A-Za-z0-9_-]{20,200}$/u,
  },
};

export const RLY0_OFFICIAL_KEYS_FILE = "official-keys.json";

export function officialVendorOf(relay: Pick<Rly0Relay, "baseUrl">): Rly0OfficialVendor | null {
  let host: string;
  try {
    host = new URL(relay.baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [vendor, entry] of Object.entries(RLY0_OFFICIAL_VENDORS))
    if (entry.host === host) return vendor as Rly0OfficialVendor;
  return null;
}

/** Model lists of the saved official keys: `{ vendor: { models } }` in RLY/0 Hub's data. */
export class Rly0OfficialKeyModels {
  readonly #file: string;

  constructor(environment: NodeJS.ProcessEnv) {
    this.#file = path.join(resolveRly0DataDir(environment), RLY0_OFFICIAL_KEYS_FILE);
  }

  async read(): Promise<Partial<Record<Rly0OfficialVendor, readonly string[]>>> {
    try {
      const value = JSON.parse(await fs.readFile(this.#file, "utf8")) as Record<string, unknown>;
      const out: Partial<Record<Rly0OfficialVendor, readonly string[]>> = {};
      for (const vendor of Object.keys(RLY0_OFFICIAL_VENDORS) as Rly0OfficialVendor[]) {
        const entry = value[vendor] as { models?: unknown } | undefined;
        if (entry && Array.isArray(entry.models))
          out[vendor] = entry.models
            .filter((m): m is string => typeof m === "string" && /^[\w.:/@+-]{1,128}$/u.test(m))
            .slice(0, 300);
      }
      return out;
    } catch {
      return {};
    }
  }

  async set(vendor: Rly0OfficialVendor, models: readonly string[] | null): Promise<void> {
    const current = await this.read();
    const next: Record<string, { models: readonly string[] }> = {};
    for (const [key, list] of Object.entries(current)) if (list) next[key] = { models: list };
    if (models) next[vendor] = { models: [...new Set(models.map(cleanModelId))].filter(Boolean) };
    else delete next[vendor];
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.#file);
  }

  /** The models an agent may use through `relay`: the official list for a vendor key. */
  async modelsFor(relay: Pick<Rly0Relay, "baseUrl" | "models">): Promise<readonly string[]> {
    const vendor = officialVendorOf(relay);
    if (!vendor) return relay.models;
    return (await this.read())[vendor] ?? [];
  }
}

/** Google's OpenAI-compatible list names models `models/gemini-…`; agents want the bare id. */
function cleanModelId(model: string): string {
  return model.replace(/^models\//u, "").trim();
}

/** Sub2API platform names that belong to each vendor. */
const EXPORT_PLATFORMS: Readonly<Record<Rly0OfficialVendor, readonly string[]>> = {
  openai: ["openai"],
  anthropic: ["anthropic", "claude"],
  google: ["gemini", "google", "antigravity"],
  xai: ["grok", "xai"],
};

/**
 * The vendor's key in a Sub2API account export (`{"accounts":[{"platform","credentials"}]}`),
 * or a bare `{"api_key": …}` JSON. Throws AUTH_FILE_* codes the page explains.
 */
export function keyFromAccountExport(content: string, vendor: Rly0OfficialVendor): string {
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^﻿/u, ""));
  } catch {
    throw Object.assign(new Error("AUTH_FILE_INVALID"), { code: -32000 });
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const pick = (credentials: Record<string, unknown>): string | null => {
    for (const key of ["api_key", "apiKey", "access_token", "setup_token", "key"]) {
      const candidate = credentials[key];
      if (
        typeof candidate === "string" &&
        RLY0_OFFICIAL_VENDORS[vendor].pattern.test(candidate.trim())
      )
        return candidate.trim();
    }
    return null;
  };
  if (Array.isArray(record.accounts)) {
    for (const item of record.accounts) {
      if (typeof item !== "object" || item === null) continue;
      const account = item as Record<string, unknown>;
      if (!EXPORT_PLATFORMS[vendor].includes(String(account.platform ?? "").toLowerCase()))
        continue;
      const found = pick((account.credentials ?? {}) as Record<string, unknown>);
      if (found) return found;
    }
  } else {
    const found = pick(record);
    if (found) return found;
  }
  throw Object.assign(new Error("AUTH_FILE_NOT_A_LOGIN"), { code: -32000 });
}
