import { promises as fs } from "node:fs";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { RLY0_CODEX_PROVIDER_ID } from "@codexhost/shared-contracts";

import type { Rly0CoreCustomProvider } from "../rly0-core/index.js";
import { resolveCodexHome } from "../rly0-mcp/file-io.js";

/**
 * The providers a person defined in Codex's own `config.toml` (`[model_providers.<id>]`, e.g. a
 * relay at `https://api.shuaiapi.com/v1`), offered in the model menu of every conversation as
 * `cfg/<id>/<model>` once the unified channel is on. The Host only reads `config.toml`; the
 * routing fields go to the local proxy in memory (`proxyCustomProviders`). A provider's
 * `env_key` is passed by name and read by the proxy at request time, so no key is ever copied
 * into a Hub file.
 */
export const CUSTOM_MODEL_ID_PREFIX = "cfg/";

export interface Rly0CustomProvider extends Rly0CoreCustomProvider {
  /** Models `config.toml` pairs with this provider (top-level `model`, profiles). */
  readonly models: readonly string[];
  /** config.toml's top-level `model` when its `model_provider` is this provider. */
  readonly defaultModel?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 2048): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

const PROVIDER_ID = /^[A-Za-z0-9_.-]{1,128}$/u;

export function customModelId(providerId: string, model: string): string {
  return `${CUSTOM_MODEL_ID_PREFIX}${providerId}/${model}`;
}

export function isCustomSelector(model: unknown): model is string {
  return typeof model === "string" && model.startsWith(CUSTOM_MODEL_ID_PREFIX);
}

/** `cfg/<provider>/<model>` split, or `undefined` for anything else. */
export function parseCustomSelector(
  model: unknown,
): { readonly providerId: string; readonly model: string } | undefined {
  if (!isCustomSelector(model)) return undefined;
  const rest = model.slice(CUSTOM_MODEL_ID_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { providerId: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

/** Parses `config.toml` text; providers the proxy can serve, in file order. */
export function customProvidersFromConfig(content: string): Rly0CustomProvider[] {
  let config: JsonRecord;
  try {
    config = parseToml(content) as JsonRecord;
  } catch {
    return [];
  }
  const providers = isRecord(config.model_providers) ? config.model_providers : {};
  const models = new Map<string, Set<string>>();
  const pair = (provider: unknown, model: unknown) => {
    const id = text(provider, 128);
    const name = text(model, 256);
    if (!id || !name) return;
    const set = models.get(id) ?? new Set<string>();
    set.add(name);
    models.set(id, set);
  };
  pair(config.model_provider, config.model);
  if (isRecord(config.profiles)) {
    for (const profile of Object.values(config.profiles))
      if (isRecord(profile)) pair(profile.model_provider, profile.model);
  }
  const out: Rly0CustomProvider[] = [];
  for (const [id, raw] of Object.entries(providers)) {
    if (!isRecord(raw) || !PROVIDER_ID.test(id) || id === RLY0_CODEX_PROVIDER_ID) continue;
    const baseUrl = text(raw.base_url);
    if (!baseUrl || !/^https?:\/\//iu.test(baseUrl)) continue;
    // Codex talks to the unified provider over the Responses API only.
    const wire = text(raw.wire_api, 32);
    if (wire !== undefined && wire !== "responses") continue;
    const envKey = text(raw.env_key, 256);
    const bearerToken = text(raw.experimental_bearer_token, 8192);
    const headers = stringMap(raw.http_headers);
    const envHeaders = stringMap(raw.env_http_headers);
    const queryParams = stringMap(raw.query_params);
    const defaultModel =
      text(config.model_provider, 128) === id ? text(config.model, 256) : undefined;
    out.push({
      id,
      name: text(raw.name, 128) ?? id,
      baseUrl,
      ...(envKey ? { envKey } : {}),
      ...(bearerToken ? { bearerToken } : {}),
      requiresOpenaiAuth: raw.requires_openai_auth === true,
      ...(headers ? { headers } : {}),
      ...(envHeaders ? { envHeaders } : {}),
      ...(queryParams ? { queryParams } : {}),
      models: [...(models.get(id) ?? [])].filter(
        (model) => !model.startsWith(CUSTOM_MODEL_ID_PREFIX) && !model.startsWith("rly0/"),
      ),
      ...(defaultModel ? { defaultModel } : {}),
    });
  }
  return out;
}

/** Reads `${CODEX_HOME:-~/.codex}/config.toml`; a missing or unreadable file means none. */
export async function readCustomProviders(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Rly0CustomProvider[]> {
  try {
    const content = await fs.readFile(
      path.join(resolveCodexHome(environment), "config.toml"),
      "utf8",
    );
    return customProvidersFromConfig(content);
  } catch {
    return [];
  }
}

/** The fields the proxy routes with (no model list). */
export function coreCustomProviders(
  providers: readonly Rly0CustomProvider[],
): Rly0CoreCustomProvider[] {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    ...(provider.envKey ? { envKey: provider.envKey } : {}),
    ...(provider.bearerToken ? { bearerToken: provider.bearerToken } : {}),
    requiresOpenaiAuth: provider.requiresOpenaiAuth,
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(provider.envHeaders ? { envHeaders: provider.envHeaders } : {}),
    ...(provider.queryParams ? { queryParams: provider.queryParams } : {}),
  }));
}
