import { customModelId, type Rly0CustomProvider } from "./custom-providers.js";

/**
 * The model menu with the unified channel on: every channel in one list, in groups — the official
 * account (or API key) Codex is signed in with, RLY/0 relays, then providers of config.toml — and
 * each row's name says its channel, so the Composer label shows where the next request goes.
 * Plain text in Codex's own fields: it survives Codex updates, unlike decorating Codex's menu.
 */

/** How Codex is signed in: a ChatGPT account (with its email when known) or an API key. */
export type Rly0OfficialAccount =
  { readonly kind: "chatgpt"; readonly email?: string } | { readonly kind: "apiKey" };

export const UNIFIED_GROUP_OFFICIAL = "官方账号";
export const UNIFIED_GROUP_RELAY = "零号中转";
export const UNIFIED_GROUP_CUSTOM = "自定义中转";
export const UNIFIED_GROUP_API_KEY = "API Key";

type JsonRecord = Record<string, unknown>;

function name(entry: JsonRecord): string {
  return typeof entry.displayName === "string" && entry.displayName
    ? entry.displayName
    : String(entry.model ?? entry.id ?? "");
}

/** An official row named after its channel. */
export function unifiedOfficialRow(
  entry: JsonRecord,
  account: Rly0OfficialAccount | null,
): JsonRecord {
  const base = name(entry);
  if (account?.kind === "apiKey")
    return {
      ...entry,
      displayName: `${UNIFIED_GROUP_API_KEY} · ${base}`,
      description: `${UNIFIED_GROUP_API_KEY} · OpenAI 官方`,
    };
  return {
    ...entry,
    displayName: `官方 · ${base}`,
    description:
      account?.kind === "chatgpt" && account.email
        ? `${UNIFIED_GROUP_OFFICIAL} 当前：${account.email}`
        : UNIFIED_GROUP_OFFICIAL,
  };
}

/** A relay row (already `relayName · model`) with its group in the description. */
export function unifiedRelayRow(entry: JsonRecord, relayName: string): JsonRecord {
  return { ...entry, description: `${UNIFIED_GROUP_RELAY} · ${relayName}` };
}

/**
 * Whether the proxy can find a key for the provider. One that only reuses Codex's login works
 * with an API key, never with a ChatGPT login (that login is not sent to a third party).
 */
export function customProviderUsable(
  provider: Rly0CustomProvider,
  account: Rly0OfficialAccount | null,
): boolean {
  if (provider.bearerToken || provider.envKey || !provider.requiresOpenaiAuth) return true;
  return account?.kind === "apiKey";
}

/**
 * Rows for providers of config.toml: the models config.toml pairs with each, else the official
 * model names (such providers usually serve the same GPT models).
 */
export function unifiedCustomRows(
  providers: readonly Rly0CustomProvider[],
  officialNames: readonly string[],
  account: Rly0OfficialAccount | null,
  template: JsonRecord | undefined,
): JsonRecord[] {
  const rows: JsonRecord[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!customProviderUsable(provider, account)) continue;
    const models = provider.models.length ? provider.models : officialNames;
    for (const model of models) {
      const id = customModelId(provider.id, model);
      if (seen.has(id)) continue;
      seen.add(id);
      const entry: JsonRecord = { ...(template ?? {}) };
      delete entry.upgrade;
      delete entry.upgradeInfo;
      delete entry.availabilityNux;
      rows.push({
        ...entry,
        id,
        model: id,
        displayName: `${provider.name} · ${model}`,
        description: `${UNIFIED_GROUP_CUSTOM} · config.toml`,
        hidden: false,
        isDefault: false,
        ...(template ? {} : { supportedReasoningEfforts: [] }),
      });
    }
  }
  return rows;
}
