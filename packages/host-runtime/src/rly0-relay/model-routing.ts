import {
  RLY0_CODEX_PROVIDER_ID,
  RLY0_CODEX_PROVIDER_NAME,
  RLY0_PROXY_DEFAULT_PORT,
  RLY0_RELAY_MODEL_ID_PREFIX,
  type Rly0ProxyStatusResult,
  type Rly0RelayListResult,
  type Rly0RelayModelCatalogStatusResult,
} from "@codexhost/shared-contracts";

import type { Rly0CoreCustomProvider } from "../rly0-core/index.js";
import {
  coreCustomProviders,
  customModelId,
  parseCustomSelector,
  type Rly0CustomProvider,
} from "./custom-providers.js";
import {
  isRelaySelector,
  OFFICIAL_CODEX_PROVIDER_ID,
  type StoredThreadRoute,
  turnRequestModel,
  withTurnRequestModel,
} from "./thread-provider.js";
import { unifiedBaseUrl } from "./unified-channel.js";
import {
  type Rly0OfficialAccount,
  unifiedCustomRows,
  unifiedOfficialRow,
  unifiedRelayRow,
} from "./unified-menu.js";

/** The slice of the rly0-core bridge that relay model routing needs. */
export interface Rly0RelayRoutingCore {
  listRelays(): Promise<Rly0RelayListResult>;
  proxyStatus(): Promise<Rly0ProxyStatusResult>;
  proxyStart(params: { port?: number }): Promise<Rly0ProxyStatusResult>;
  /** Older cores lack it; `cfg/` choices then fail closed at the proxy. */
  proxyCustomProviders?(providers: readonly Rly0CoreCustomProvider[]): Promise<unknown>;
}

export interface Rly0RelayModelRouterOptions {
  /**
   * Reads the model names of the official catalog straight from Codex (`model/list`), for when a
   * relay model is chosen before any `model/list` response has passed through the Host. Never a
   * local cache or snapshot: a stale catalog is exactly what hides new official models.
   */
  readonly loadOfficialModels?: () => Promise<Rly0OfficialCatalogRead>;
  /**
   * False in no-account mode: the per-thread provider definition must match the one written to
   * config.toml, or Codex would ask for a login again.
   */
  readonly providerRequiresOpenaiAuth?: () => Promise<boolean>;
  /**
   * No-account mode (config.toml's `rly0` provider asks for no login), with the default model it
   * wrote; `null` when the mode is off. In that mode only relay models can answer, so the picker
   * shows only relay models and official names are moved onto the matching relay model.
   */
  readonly noAccountMode?: () => Promise<Rly0NoAccountMode | null>;
  /**
   * The unified channel (unified-channel.ts): every Thread runs on `rly0` through the proxy's
   * `/u/v1` path and the chosen model alone picks the upstream. Absent means off.
   */
  readonly unifiedChannel?: () => Promise<boolean>;
  /** Providers of Codex's config.toml (custom-providers.ts), offered as `cfg/<id>/<model>`. */
  readonly customProviders?: () => Promise<readonly Rly0CustomProvider[]>;
  /** How Codex is signed in (`account/read`), named in the unified menu. */
  readonly officialAccount?: () => Promise<Rly0OfficialAccount | null>;
  readonly now?: () => number;
}

export interface Rly0NoAccountMode {
  /** The default model written to config.toml (a bare relay model name). */
  readonly model?: string;
}

/** Suffix for official entries kept in no-account mode only because no relay model is known. */
export const RLY0_NO_ACCOUNT_OFFICIAL_LABEL = "走零号中转";

/** One complete read of the official catalog: every `model`/`id` name, and the entry count. */
export interface Rly0OfficialCatalogRead {
  readonly names: readonly string[];
  readonly count: number;
}

type OfficialSnapshot = NonNullable<Rly0RelayModelCatalogStatusResult["official"]>;

export interface Rly0RelayModel {
  readonly model: string;
  readonly relayName: string;
  readonly relayId: string;
}

/** Stable, non-secret selector; the core unwraps it only after validating the named relay. */
export function relayModelId(relayId: string, model: string): string {
  return `${RLY0_RELAY_MODEL_ID_PREFIX}${relayId}/${model}`;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CACHE_TTL_MS = 5_000;
const LIST_TIMEOUT_MS = 2_500;
const MAX_TRACKED_THREADS = 2_000;
/** The preferred proxy port and the next few are tried when a port is already taken. */
const PROXY_PORT_ATTEMPTS = 10;
/** After a failed official catalog read, relay decisions do not wait on another one for this long. */
const OFFICIAL_RETRY_MS = 60_000;

/** Sets `key` as the newest entry, dropping the oldest beyond `MAX_TRACKED_THREADS`. */
function remember(map: Map<string, string>, key: string, value: string): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_THREADS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** Resolves `undefined` on timeout; a rejection resolves `undefined` too unless `rethrow` is set. */
function withTimeout<T>(promise: Promise<T>, ms: number, rethrow = false): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (rethrow) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(undefined);
      },
    );
  });
}

/**
 * Makes the models of the user's enabled relays selectable in Codex's own model picker and routes
 * the threads that use them through the RLY/0 local proxy.
 *
 * - `model/list` responses get one extra entry per relay model (exact names only; `prefix*`
 *   patterns cannot be listed). Names Codex already offers are never shadowed, so an official
 *   model is never silently re-routed to a relay. The official entries themselves are forwarded
 *   exactly as Codex returned them, and an official error is forwarded unchanged: the Host never
 *   substitutes a local catalog (no `model_catalog_json`, no cached snapshot).
 * - A `thread/start|resume|fork` whose model is a relay model gets `modelProvider: "rly0"` plus a
 *   per-thread provider definition in `config`, so nothing in the user's `config.toml` has to be
 *   changed. The proxy is started first when it is not running.
 * - Everything else passes through untouched.
 */
/**
 * Codex is the official agent for OpenAI's models only. Relay models of other families (Claude,
 * Gemini, DeepSeek, ...) belong in their own vendor's agent, so they are never offered in Codex.
 */
export function isCodexFamilyModel(model: string): boolean {
  return /^(?:gpt-|chatgpt-|codex-|o\d)/iu.test(model.trim());
}

export class Rly0RelayModelRouter {
  readonly #core: Rly0RelayRoutingCore;
  #cache: {
    at: number;
    models: readonly Rly0RelayModel[];
    patterns: readonly string[];
    delegated: readonly string[];
  } | null = null;
  readonly #loadOfficialModels: (() => Promise<Rly0OfficialCatalogRead>) | undefined;
  readonly #providerRequiresOpenaiAuth: (() => Promise<boolean>) | undefined;
  readonly #noAccountMode: (() => Promise<Rly0NoAccountMode | null>) | undefined;
  #noAccount: { at: number; mode: Rly0NoAccountMode | null } | null = null;
  readonly #unifiedChannel: (() => Promise<boolean>) | undefined;
  #unified: { at: number; on: boolean } | null = null;
  readonly #customProviders: (() => Promise<readonly Rly0CustomProvider[]>) | undefined;
  #custom: { at: number; list: readonly Rly0CustomProvider[]; pushed: string } | null = null;
  readonly #officialAccount: (() => Promise<Rly0OfficialAccount | null>) | undefined;
  #account: Rly0OfficialAccount | null = null;
  readonly #now: () => number;
  /** Entries on earlier pages of the `model/list` currently being paged through. */
  #pagedCount = 0;
  #officialSnapshot: OfficialSnapshot | null = null;
  #lastOfficialError: { at: number; message: string } | undefined;
  #officialModels = new Set<string>();
  /** Visible official names of the `model/list` being paged through (custom rows reuse them). */
  readonly #officialVisible = new Set<string>();
  /** Whether the official catalog has been seen at least once (response or direct read). */
  #officialKnown = false;
  #officialLoad: Promise<void> | null = null;
  #officialFailedAt = -Infinity;
  readonly #threadProviders = new Map<string, string>();
  /** Last known model choice per Thread (resume response, turn, settings update). */
  readonly #threadModels = new Map<string, string>();
  /** First provider other than `rly0` seen per Thread: where an official model goes back to. */
  readonly #originalProviders = new Map<string, string>();

  constructor(core: Rly0RelayRoutingCore, options: Rly0RelayModelRouterOptions = {}) {
    this.#core = core;
    this.#loadOfficialModels = options.loadOfficialModels;
    this.#providerRequiresOpenaiAuth = options.providerRequiresOpenaiAuth;
    this.#noAccountMode = options.noAccountMode;
    this.#unifiedChannel = options.unifiedChannel;
    this.#customProviders = options.customProviders;
    this.#officialAccount = options.officialAccount;
    this.#now = options.now ?? Date.now;
  }

  /** Whether the unified channel is on (cached briefly); unreadable counts as off. */
  async unifiedOn(fresh = false): Promise<boolean> {
    if (!this.#unifiedChannel) return false;
    const now = Date.now();
    if (!fresh && this.#unified && now - this.#unified.at < CACHE_TTL_MS) return this.#unified.on;
    let on = false;
    try {
      on = await this.#unifiedChannel();
    } catch {
      on = false;
    }
    this.#unified = { at: now, on };
    return on;
  }

  /**
   * Providers of config.toml, read again after a short cache and handed to the proxy whenever
   * the list changed or `push` asks (a restarted core forgets it).
   */
  async #readCustom(fresh = false, push = false): Promise<readonly Rly0CustomProvider[]> {
    if (!this.#customProviders) return [];
    const now = Date.now();
    let current = this.#custom;
    if (fresh || !current || now - current.at >= CACHE_TTL_MS) {
      let list: readonly Rly0CustomProvider[] = current?.list ?? [];
      try {
        list = (await withTimeout(this.#customProviders(), LIST_TIMEOUT_MS)) ?? list;
      } catch {
        // keep the last list
      }
      current = { at: now, list, pushed: current?.pushed ?? "" };
      this.#custom = current;
    }
    const payload = coreCustomProviders(current.list);
    const fingerprint = JSON.stringify(payload);
    if ((push || fingerprint !== current.pushed) && this.#core.proxyCustomProviders) {
      try {
        await withTimeout(this.#core.proxyCustomProviders(payload), LIST_TIMEOUT_MS, true);
        current.pushed = fingerprint;
      } catch {
        current.pushed = "";
      }
    }
    return current.list;
  }

  async #readAccount(): Promise<void> {
    if (!this.#officialAccount) return;
    try {
      this.#account =
        (await withTimeout(this.#officialAccount(), LIST_TIMEOUT_MS)) ?? this.#account;
    } catch {
      // keep the last known account
    }
  }

  /** A `cfg/<id>/<model>` choice names a provider config.toml still defines. */
  async isCustomModel(model: unknown): Promise<boolean> {
    const selected = parseCustomSelector(model);
    if (!selected) return false;
    const list = await this.#readCustom(false, true);
    if (!list.some((provider) => provider.id === selected.providerId))
      throw new Error("CUSTOM_PROVIDER_NOT_AVAILABLE");
    return true;
  }

  /**
   * Reads the official catalog directly. Names only ever accumulate, so an official model seen once
   * (even a hidden one) can never be taken over by a relay later.
   */
  async #readOfficial(): Promise<void> {
    const load = this.#loadOfficialModels;
    if (!load) return;
    let read: Rly0OfficialCatalogRead | undefined;
    let message = "OFFICIAL_CATALOG_TIMEOUT";
    try {
      read = await withTimeout(load(), LIST_TIMEOUT_MS, true);
    } catch (error) {
      message = error instanceof Error && error.message ? error.message : "OFFICIAL_CATALOG_FAILED";
    }
    const at = this.#now();
    if (!read) {
      this.#officialFailedAt = Date.now();
      this.#lastOfficialError = { at, message: message.slice(0, 300) };
      return;
    }
    for (const name of read.names) if (name) this.#officialModels.add(name);
    this.#officialKnown = true;
    this.#lastOfficialError = undefined;
    this.#officialSnapshot = { fetchedAt: at, count: read.count, via: "hub" };
  }

  /** What the model picker is built from; `refresh` reads the official catalog again first. */
  async catalogStatus(refresh = false): Promise<Rly0RelayModelCatalogStatusResult> {
    if (refresh) await this.#readOfficial();
    const { models, delegated } = await this.#relayModels(refresh);
    const appended: string[] = [];
    const shadowed: string[] = [];
    for (const { model, relayId } of models) {
      appended.push(relayModelId(relayId, model));
    }
    return {
      official: this.#officialSnapshot,
      ...(this.#lastOfficialError ? { lastError: this.#lastOfficialError } : {}),
      appended,
      shadowed,
      delegated: [...delegated],
    };
  }

  /**
   * Makes sure official names are known before deciding a model is a relay model, so a relay
   * that also lists an official name can never take it over. When the official catalog cannot be
   * read the relay decision proceeds on the names already known (relay models stay usable).
   */
  async #ensureOfficialModels(): Promise<void> {
    if (this.#officialKnown || !this.#loadOfficialModels) return;
    if (!this.#officialLoad && Date.now() - this.#officialFailedAt < OFFICIAL_RETRY_MS) return;
    this.#officialLoad ??= this.#readOfficial().finally(() => {
      this.#officialLoad = null;
    });
    await this.#officialLoad;
  }

  async #relayModels(fresh = false): Promise<{
    models: readonly Rly0RelayModel[];
    patterns: readonly string[];
    delegated: readonly string[];
  }> {
    const now = Date.now();
    if (!fresh && this.#cache && now - this.#cache.at < CACHE_TTL_MS) return this.#cache;
    const listed = await withTimeout(this.#core.listRelays(), LIST_TIMEOUT_MS);
    if (!listed) return this.#cache ?? { models: [], patterns: [], delegated: [] };
    const models: Rly0RelayModel[] = [];
    const patterns: string[] = [];
    const delegated: string[] = [];
    const seen = new Set<string>();
    if (listed.available) {
      for (const relay of listed.relays) {
        if (!relay.enabled || !relay.hasKey) continue;
        for (const raw of relay.models) {
          const model = raw.trim();
          if (!model) continue;
          if (model.endsWith("*")) {
            const prefix = model.slice(0, -1);
            if (prefix && isCodexFamilyModel(prefix)) patterns.push(prefix);
            continue;
          }
          const selector = relayModelId(relay.id, model);
          if (seen.has(selector)) continue;
          seen.add(selector);
          if (isCodexFamilyModel(model))
            models.push({ model, relayName: relay.name, relayId: relay.id });
          else if (!delegated.includes(model)) delegated.push(model);
        }
      }
    }
    this.#cache = { at: now, models, patterns, delegated };
    return this.#cache;
  }

  /** Warms the relay list and the mode before a `model/list` response is rewritten synchronously. */
  async prepareModelList(): Promise<void> {
    const unified = await this.unifiedOn(true);
    await Promise.all([
      this.#relayModels(true),
      this.#readNoAccount(true),
      ...(unified ? [this.#readCustom(true), this.#readAccount()] : []),
    ]);
  }

  /** No-account mode as last read (cached briefly); an unreadable mode counts as off. */
  async #readNoAccount(fresh = false): Promise<Rly0NoAccountMode | null> {
    const now = Date.now();
    if (!fresh && this.#noAccount && now - this.#noAccount.at < CACHE_TTL_MS)
      return this.#noAccount.mode;
    let mode: Rly0NoAccountMode | null = null;
    try {
      mode = (await this.#noAccountMode?.()) ?? null;
    } catch {
      mode = null;
    }
    this.#noAccount = { at: now, mode };
    return mode;
  }

  /**
   * In no-account mode, the relay selector a bare model name moves to: the same model on the first
   * relay offering it, else the configured default, else the first relay model. `undefined` when
   * nothing changes (mode off, already a selector, or no relay model known).
   */
  async #noAccountSelector(model: unknown): Promise<string | undefined> {
    if (typeof model !== "string" || !model || isRelaySelector(model)) return undefined;
    const mode = await this.#readNoAccount();
    if (!mode) return undefined;
    const { models } = await this.#relayModels();
    const target =
      models.find((entry) => entry.model === model) ??
      (mode.model ? models.find((entry) => entry.model === mode.model) : undefined) ??
      models[0];
    return target ? relayModelId(target.relayId, target.model) : undefined;
  }

  /**
   * `turn/start` params with an official model name moved onto its relay model in no-account mode,
   * or `null` when nothing changes. Only for threads already on the `rly0` provider.
   */
  async migrateTurnParams(params: JsonRecord): Promise<JsonRecord | null> {
    const selector = await this.#noAccountSelector(turnRequestModel(params));
    return selector ? withTurnRequestModel(params, selector) : null;
  }

  /**
   * `thread/resume` params that load the Thread on the provider its model needs, or `null` to
   * forward the original request. Codex keeps a resumed Thread's stored provider unless the resume
   * names a model or provider, so an older Thread started with the ChatGPT login would otherwise
   * send relay model ids to the official backend. Read the stored Thread only when it matters:
   * - no-account mode, no model named, stored on another provider: the matching relay model (or
   *   the configured default) on `rly0`;
   * - no-account mode off, an official model named, stored on `rly0`: back on the provider the
   *   Thread had before (Codex's `openai` when the Host never saw another one).
   * Everything else is `rewriteThreadParams`.
   */
  async rewriteResumeParams(
    input: JsonRecord,
    readStored: (threadId: string) => Promise<StoredThreadRoute | undefined>,
  ): Promise<JsonRecord | null> {
    const threadId = typeof input.threadId === "string" && input.threadId ? input.threadId : null;
    const named = typeof input.model === "string" && input.model ? input.model : undefined;
    if (!threadId || typeof input.modelProvider === "string")
      return this.rewriteThreadParams(input);
    if (await this.unifiedOn()) return this.#unifiedResume(threadId, input, named, readStored);
    const noAccount = await this.#readNoAccount();
    if (noAccount && !named) {
      const stored = await this.#storedRoute(threadId, readStored);
      if (stored?.provider && stored.provider !== RLY0_CODEX_PROVIDER_ID) {
        const selector = await this.#noAccountSelector(
          stored.model && !isRelaySelector(stored.model) ? stored.model : (noAccount.model ?? "*"),
        );
        if (selector) return this.rewriteThreadParams({ ...input, model: selector });
      }
    } else if (!noAccount && named && !isRelaySelector(named)) {
      const stored = await this.#storedRoute(threadId, readStored);
      if (stored?.provider === RLY0_CODEX_PROVIDER_ID) {
        return {
          ...input,
          modelProvider: this.#originalProviders.get(threadId) ?? OFFICIAL_CODEX_PROVIDER_ID,
        };
      }
    }
    return this.rewriteThreadParams(input);
  }

  /**
   * Unified channel: a Thread stored on another provider (an older one started with the ChatGPT
   * login: `openai`, or a provider of config.toml) is loaded on `rly0` with the model it had, so
   * any channel can answer its next turn. One stored on `rly0` keeps its stored pair and only gets
   * the provider definition (naming a provider without a model would reset the model).
   */
  async #unifiedResume(
    threadId: string,
    input: JsonRecord,
    named: string | undefined,
    readStored: (threadId: string) => Promise<StoredThreadRoute | undefined>,
  ): Promise<JsonRecord | null> {
    if (named) return this.rewriteThreadParams(input);
    // Without RLY/0 Hub's own proxy nothing changes, so the stored Thread is not even read.
    try {
      await this.ensureProxy();
    } catch {
      return null;
    }
    const known = this.#threadProviders.get(threadId);
    const stored =
      known === RLY0_CODEX_PROVIDER_ID
        ? { provider: known }
        : await withTimeout(readStored(threadId), LIST_TIMEOUT_MS);
    if (stored?.provider === RLY0_CODEX_PROVIDER_ID) return this.#unifiedDefinitionOnly(input);
    const model = stored?.model ?? this.#threadModels.get(threadId);
    if (!model) return this.#unifiedDefinitionOnly(input);
    // A stored provider of config.toml keeps answering through it: its model as `cfg/<id>/...`.
    const custom =
      stored?.provider && stored.provider !== OFFICIAL_CODEX_PROVIDER_ID
        ? (await this.#readCustom()).find((provider) => provider.id === stored.provider)
        : undefined;
    return this.rewriteThreadParams({
      ...input,
      model: custom && !isRelaySelector(model) ? customModelId(custom.id, model) : model,
    });
  }

  async #unifiedDefinitionOnly(input: JsonRecord): Promise<JsonRecord | null> {
    let baseUrl: string;
    try {
      baseUrl = unifiedBaseUrl(await this.ensureProxy());
    } catch {
      return null;
    }
    return this.#withProviderDefinition(input, baseUrl, await this.#requiresAuth());
  }

  /**
   * The `thread/resume` a Thread is restored with on a new backend (after a backend reload, for
   * example an account switch). The Thread is loaded again there, so with the unified channel on
   * it moves onto `rly0` (keeping its model); with it off a `rly0` Thread on an official model
   * goes back to the provider it had before. Anything else is returned unchanged.
   */
  async restoreParams(params: JsonRecord): Promise<JsonRecord> {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (!threadId) return params;
    const model =
      (typeof params.model === "string" && params.model ? params.model : undefined) ??
      this.#threadModels.get(threadId);
    const provider =
      typeof params.modelProvider === "string"
        ? params.modelProvider
        : this.#threadProviders.get(threadId);
    if (await this.unifiedOn()) {
      if (provider === RLY0_CODEX_PROVIDER_ID)
        return (await this.#unifiedDefinitionOnly(params)) ?? params;
      if (!model) return params;
      return (await this.rewriteThreadParams({ ...params, model })) ?? params;
    }
    if (
      provider === RLY0_CODEX_PROVIDER_ID &&
      model &&
      !isRelaySelector(model) &&
      !parseCustomSelector(model) &&
      (await this.#requiresAuth())
    ) {
      const providerKey = `model_providers.${RLY0_CODEX_PROVIDER_ID}`;
      const config = isRecord(params.config)
        ? Object.fromEntries(Object.entries(params.config).filter(([key]) => key !== providerKey))
        : undefined;
      return {
        ...params,
        ...(config ? { config } : {}),
        model,
        modelProvider: this.#originalProviders.get(threadId) ?? OFFICIAL_CODEX_PROVIDER_ID,
      };
    }
    return params;
  }

  /**
   * `thread/fork` params that continue a Thread in a new one on the provider `model` needs, for a
   * Thread already loaded on another provider (Codex cannot change a loaded Thread's provider).
   */
  async forkParams(threadId: string, model: string): Promise<JsonRecord> {
    const base: JsonRecord = { threadId, model, excludeTurns: true };
    if ((await this.unifiedOn()) || isRelaySelector(model) || parseCustomSelector(model)) {
      const next = await this.rewriteThreadParams(base);
      if (!next) throw new Error("RLY0_PROXY_UNAVAILABLE");
      return next;
    }
    return {
      ...base,
      modelProvider: this.#originalProviders.get(threadId) ?? OFFICIAL_CODEX_PROVIDER_ID,
    };
  }

  async #storedRoute(
    threadId: string,
    readStored: (threadId: string) => Promise<StoredThreadRoute | undefined>,
  ): Promise<StoredThreadRoute | undefined> {
    const known = this.#threadProviders.get(threadId);
    if (known) return { provider: known };
    // A slow or failed read leaves the resume as Desktop sent it.
    return withTimeout(readStored(threadId), LIST_TIMEOUT_MS);
  }

  /**
   * The model a `turn/start` runs with: the one it names (a collaboration mode's first), else the
   * Thread's last known choice (resume response, earlier turn, `thread/settings/update`).
   */
  turnModel(threadId: string, params: JsonRecord): string | undefined {
    return turnRequestModel(params) ?? this.#threadModels.get(threadId);
  }

  /** Remembers a model choice that Codex will apply to the Thread's later turns. */
  noteThreadModel(threadId: string, model: unknown): void {
    if (typeof model !== "string" || !model) return;
    remember(this.#threadModels, threadId, model);
  }

  /** Appends relay models to a `model/list` result. Returns `null` when nothing changes. */
  rewriteModelListResponse(response: JsonRecord): JsonRecord | null {
    const result = response.result;
    if (!isRecord(result) || !Array.isArray(result.data)) return null;
    const official = result.data.filter(isRecord);
    for (const entry of official) {
      if (typeof entry.model === "string") this.#officialModels.add(entry.model);
      if (typeof entry.id === "string") this.#officialModels.add(entry.id);
    }
    this.#officialKnown = true;
    const unified = this.#unified?.on === true;
    for (const entry of official)
      if (entry.hidden !== true && typeof entry.model === "string")
        this.#officialVisible.add(entry.model);
    // Only the last page carries the extra entries.
    if (typeof result.nextCursor === "string" && result.nextCursor) {
      this.#pagedCount += official.length;
      // No-account mode: no official model can answer, so its rows are left out of every page.
      if (this.#noAccount?.mode && (this.#cache?.models.length ?? 0) > 0)
        return { ...response, result: { ...result, data: [] } };
      if (unified)
        return { ...response, result: { ...result, data: this.#unifiedOfficial(result.data) } };
      return null;
    }
    this.#officialSnapshot = {
      fetchedAt: this.#now(),
      count: this.#pagedCount + official.length,
      via: "codex",
    };
    this.#pagedCount = 0;
    const relayModels = this.#cache?.models ?? [];
    const noAccount = this.#noAccount?.mode ?? null;
    const visibleNames = [...this.#officialVisible];
    this.#officialVisible.clear();
    const customTemplate =
      official.find((entry) => entry.isDefault !== true && entry.hidden !== true) ?? official[0];
    const custom = unified
      ? unifiedCustomRows(this.#custom?.list ?? [], visibleNames, this.#account, customTemplate)
      : [];
    if (noAccount && relayModels.length === 0) {
      // Nothing to replace them with: keep the official rows, but say where they really go.
      return {
        ...response,
        result: {
          ...result,
          data: result.data
            .map((entry: unknown) =>
              isRecord(entry)
                ? {
                    ...entry,
                    displayName: `${typeof entry.displayName === "string" ? entry.displayName : String(entry.model ?? "")} · ${RLY0_NO_ACCOUNT_OFFICIAL_LABEL}`,
                  }
                : entry,
            )
            .concat(custom),
        },
      };
    }
    if (relayModels.length === 0 && !unified) return null;
    const template =
      official.find((entry) => entry.isDefault !== true && entry.hidden !== true) ?? official[0];
    const additions = relayModels
      .map(({ model, relayName, relayId }) => {
        const entry: JsonRecord = { ...(template ?? {}) };
        delete entry.upgrade;
        delete entry.upgradeInfo;
        delete entry.availabilityNux;
        return {
          ...entry,
          id: relayModelId(relayId, model),
          model: relayModelId(relayId, model),
          // Relay first, behind a relay mark, so relay models stand out from official ones and two
          // relays offering the same model are easy to tell apart. Plain text: it survives Codex
          // updates, unlike decorating Codex's own menu.
          displayName: `${relayName} · ${model}`,
          description: `${relayName} · RLY/0`,
          hidden: false,
          isDefault: false,
          ...(template ? {} : { supportedReasoningEfforts: [] }),
        };
      })
      .map((entry, index) =>
        unified ? unifiedRelayRow(entry, relayModels[index]?.relayName ?? "") : entry,
      );
    if (noAccount) {
      // Only relay models, grouped by relay; the configured default stays the default.
      const preferred =
        relayModels.find((entry) => entry.model === noAccount.model) ?? relayModels[0];
      const defaultId = preferred ? relayModelId(preferred.relayId, preferred.model) : undefined;
      const only = additions.map((entry) => ({ ...entry, isDefault: entry.id === defaultId }));
      return { ...response, result: { ...result, data: [...only, ...custom] } };
    }
    if (unified)
      return {
        ...response,
        result: {
          ...result,
          data: [...this.#unifiedOfficial(result.data), ...additions, ...custom],
        },
      };
    return { ...response, result: { ...result, data: [...result.data, ...additions] } };
  }

  #unifiedOfficial(data: unknown[]): unknown[] {
    return data.map((entry) =>
      isRecord(entry) ? unifiedOfficialRow(entry, this.#account) : entry,
    );
  }

  async isRelayModel(model: unknown): Promise<boolean> {
    // Bare names always belong to the native provider. Relay ownership must be explicit,
    // independent of official catalog availability, pagination or future official models.
    if (typeof model !== "string" || !model.startsWith("rly0/")) return false;
    const { models } = await this.#relayModels();
    if (!models.some((entry) => relayModelId(entry.relayId, entry.model) === model))
      throw new Error("RELAY_MODEL_NOT_AVAILABLE");
    return true;
  }

  async requiresOfficialAuth(): Promise<boolean> {
    return this.#requiresAuth();
  }

  async isOfficialModel(model: unknown): Promise<boolean> {
    if (typeof model !== "string") return false;
    await this.#ensureOfficialModels();
    return this.#officialModels.has(model);
  }

  /**
   * Starts the local proxy when needed and returns its OpenAI-compatible base URL. When the
   * preferred port is taken (for example by another relay tool such as AiMaMi), the next free one
   * of a few nearby ports is used; the returned URL is always the proxy RLY/0 Hub itself started.
   */
  async ensureProxy(): Promise<string> {
    const status = await this.#core.proxyStatus();
    if (status.available && status.running) return status.baseUrl;
    const preferred =
      status.available && !status.running && status.defaultPort
        ? status.defaultPort
        : RLY0_PROXY_DEFAULT_PORT;
    for (let offset = 0; offset < PROXY_PORT_ATTEMPTS; offset += 1) {
      const port = preferred + offset;
      if (port > 65_535) break;
      let started: Rly0ProxyStatusResult;
      try {
        started = await this.#core.proxyStart({ port });
      } catch (error) {
        if (error instanceof Error && error.message.includes("PORT_IN_USE")) continue;
        throw error;
      }
      if (started.available && started.running) return started.baseUrl;
      throw new Error("RLY0_PROXY_UNAVAILABLE");
    }
    throw new Error("RLY0_PROXY_UNAVAILABLE");
  }

  /**
   * For thread creation/resume params naming a relay model: the params to send instead
   * (provider switched to the local proxy), or `null` to forward the original request.
   */
  async rewriteThreadParams(input: JsonRecord): Promise<JsonRecord | null> {
    // No-account mode: an official name (an older thread, or Codex's remembered choice) moves to
    // the matching relay model, so it keeps working and shows as the relay model it really is.
    const selector = await this.#noAccountSelector(input.model);
    const params = selector ? { ...input, model: selector } : input;
    if (await this.unifiedOn()) return this.#unifiedThreadParams(params);
    if (!(await this.isRelayModel(params.model))) {
      // A conversation started on a relay model is recorded with the `rly0` provider; resuming it
      // later needs the provider defined again even when the request names no model.
      if (typeof params.model === "string" && params.model) return null;
      const { models, patterns } = await this.#relayModels();
      if (models.length === 0 && patterns.length === 0) return null;
      // Never guess a port: whatever else listens there (another relay tool) would receive the
      // conversation and Codex's login. Without RLY/0 Hub's own proxy the provider stays undefined.
      let baseUrl: string;
      try {
        baseUrl = await this.ensureProxy();
      } catch {
        return null;
      }
      return this.#withProviderDefinition(params, baseUrl, await this.#requiresAuth());
    }
    const baseUrl = await this.ensureProxy();
    return {
      ...this.#withProviderDefinition(params, baseUrl, await this.#requiresAuth()),
      modelProvider: RLY0_CODEX_PROVIDER_ID,
    };
  }

  /** Unified channel: every Thread on `rly0`; the proxy picks the upstream per request. */
  async #unifiedThreadParams(input: JsonRecord): Promise<JsonRecord | null> {
    const selected = typeof input.model === "string" && input.model ? input.model : undefined;
    await this.isRelayModel(selected);
    await this.isCustomModel(selected);
    let baseUrl: string;
    try {
      baseUrl = unifiedBaseUrl(await this.ensureProxy());
    } catch (error) {
      // Without RLY/0 Hub's own proxy the Thread stays on its native provider.
      if (isRelaySelector(selected) || parseCustomSelector(selected)) throw error;
      return null;
    }
    let params = input;
    // A new Thread without a model whose config.toml default is one of its providers keeps it.
    if (!selected && typeof input.threadId !== "string") {
      const preferred = (await this.#readCustom(false, true)).find((p) => p.defaultModel);
      if (preferred?.defaultModel)
        params = { ...input, model: customModelId(preferred.id, preferred.defaultModel) };
    }
    return {
      ...this.#withProviderDefinition(params, baseUrl, await this.#requiresAuth()),
      modelProvider: RLY0_CODEX_PROVIDER_ID,
    };
  }

  async #requiresAuth(): Promise<boolean> {
    try {
      return (await this.#providerRequiresOpenaiAuth?.()) ?? true;
    } catch {
      return true;
    }
  }

  #withProviderDefinition(params: JsonRecord, baseUrl: string, requiresAuth: boolean): JsonRecord {
    const config = isRecord(params.config) ? params.config : {};
    return {
      ...params,
      config: {
        ...config,
        [`model_providers.${RLY0_CODEX_PROVIDER_ID}`]: {
          name: RLY0_CODEX_PROVIDER_NAME,
          base_url: baseUrl,
          wire_api: "responses",
          // Codex attaches its login so the proxy can hand official models back to the account;
          // the proxy strips it before anything reaches a relay. Not in no-account mode.
          requires_openai_auth: requiresAuth,
        },
      },
    };
  }

  /** Records which provider an official thread runs on, from any thread response. */
  observeResponse(value: unknown): void {
    if (!isRecord(value) || !isRecord(value.result)) return;
    const result = value.result;
    const thread = isRecord(result.thread) ? result.thread : null;
    const threadId = thread && typeof thread.id === "string" ? thread.id : null;
    const provider =
      typeof result.modelProvider === "string"
        ? result.modelProvider
        : thread && typeof thread.modelProvider === "string"
          ? thread.modelProvider
          : null;
    if (!threadId || !provider) {
      // `thread/list` rows carry each stored Thread's provider; a loaded Thread's own response wins.
      if (!thread && Array.isArray(result.data)) {
        for (const row of result.data) {
          if (!isRecord(row) || typeof row.id !== "string" || typeof row.modelProvider !== "string")
            continue;
          if (!row.modelProvider || this.#threadProviders.has(row.id)) continue;
          this.#recordProvider(row.id, row.modelProvider);
        }
      }
      return;
    }
    this.#recordProvider(threadId, provider);
    // The model the loaded Thread really runs with (a resume response's `model`).
    if (typeof result.model === "string") this.noteThreadModel(threadId, result.model);
  }

  #recordProvider(threadId: string, provider: string): void {
    if (provider !== RLY0_CODEX_PROVIDER_ID && !this.#originalProviders.has(threadId))
      remember(this.#originalProviders, threadId, provider);
    remember(this.#threadProviders, threadId, provider);
  }

  threadProvider(threadId: string): string | undefined {
    return this.#threadProviders.get(threadId);
  }
}

export const RLY0_RELAY_PROXY_FAILED_MESSAGE =
  "RLY/0 本地代理启动失败，无法使用中转模型。请到 设置 → 中转站 查看。 (The RLY/0 local proxy could not start.)";
