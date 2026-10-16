import {
  RLY0_CODEX_PROVIDER_ID,
  RLY0_CODEX_PROVIDER_NAME,
  RLY0_PROXY_DEFAULT_PORT,
  type Rly0ProxyStatusResult,
  type Rly0RelayListResult,
} from "@codexhost/shared-contracts";

/** The slice of the rly0-core bridge that relay model routing needs. */
export interface Rly0RelayRoutingCore {
  listRelays(): Promise<Rly0RelayListResult>;
  proxyStatus(): Promise<Rly0ProxyStatusResult>;
  proxyStart(params: { port?: number }): Promise<Rly0ProxyStatusResult>;
}

export interface Rly0RelayModelRouterOptions {
  /**
   * Reads the model names of the official catalog straight from Codex (`model/list`), for when a
   * relay model is chosen before any `model/list` response has passed through the Host. Never a
   * local cache or snapshot: a stale catalog is exactly what hides new official models.
   */
  readonly loadOfficialModels?: () => Promise<readonly string[]>;
}

export interface Rly0RelayModel {
  readonly model: string;
  readonly relayName: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CACHE_TTL_MS = 5_000;
const LIST_TIMEOUT_MS = 2_500;
const MAX_TRACKED_THREADS = 2_000;
/** After a failed official catalog read, relay decisions do not wait on another one for this long. */
const OFFICIAL_RETRY_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
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
export class Rly0RelayModelRouter {
  readonly #core: Rly0RelayRoutingCore;
  #cache: { at: number; models: readonly Rly0RelayModel[]; patterns: readonly string[] } | null =
    null;
  readonly #loadOfficialModels: (() => Promise<readonly string[]>) | undefined;
  #officialModels = new Set<string>();
  /** Whether the official catalog has been seen at least once (response or direct read). */
  #officialKnown = false;
  #officialLoad: Promise<void> | null = null;
  #officialFailedAt = -Infinity;
  readonly #threadProviders = new Map<string, string>();

  constructor(core: Rly0RelayRoutingCore, options: Rly0RelayModelRouterOptions = {}) {
    this.#core = core;
    this.#loadOfficialModels = options.loadOfficialModels;
  }

  /**
   * Makes sure official names are known before deciding a model is a relay model, so a relay
   * that also lists an official name can never take it over. When the official catalog cannot be
   * read the relay decision proceeds on the names already known (relay models stay usable).
   */
  async #ensureOfficialModels(): Promise<void> {
    const load = this.#loadOfficialModels;
    if (this.#officialKnown || !load) return;
    if (!this.#officialLoad && Date.now() - this.#officialFailedAt < OFFICIAL_RETRY_MS) return;
    this.#officialLoad ??= (async () => {
      const names = await withTimeout(load(), LIST_TIMEOUT_MS);
      if (names) {
        for (const name of names) if (name) this.#officialModels.add(name);
        this.#officialKnown = true;
      } else {
        this.#officialFailedAt = Date.now();
      }
    })().finally(() => {
      this.#officialLoad = null;
    });
    await this.#officialLoad;
  }

  async #relayModels(fresh = false): Promise<{
    models: readonly Rly0RelayModel[];
    patterns: readonly string[];
  }> {
    const now = Date.now();
    if (!fresh && this.#cache && now - this.#cache.at < CACHE_TTL_MS) return this.#cache;
    const listed = await withTimeout(this.#core.listRelays(), LIST_TIMEOUT_MS);
    if (!listed) return this.#cache ?? { models: [], patterns: [] };
    const models: Rly0RelayModel[] = [];
    const patterns: string[] = [];
    const seen = new Set<string>();
    if (listed.available) {
      for (const relay of listed.relays) {
        if (!relay.enabled || !relay.hasKey) continue;
        for (const raw of relay.models) {
          const model = raw.trim();
          if (!model) continue;
          if (model.endsWith("*")) {
            if (model.length > 1) patterns.push(model.slice(0, -1));
            continue;
          }
          if (seen.has(model)) continue;
          seen.add(model);
          models.push({ model, relayName: relay.name });
        }
      }
    }
    this.#cache = { at: now, models, patterns };
    return this.#cache;
  }

  /** Warms the relay list before a `model/list` response has to be rewritten synchronously. */
  async prepareModelList(): Promise<void> {
    await this.#relayModels(true);
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
    // Only the last page carries the extra entries.
    if (typeof result.nextCursor === "string" && result.nextCursor) return null;
    const relayModels = (this.#cache?.models ?? []).filter(
      ({ model }) => !this.#officialModels.has(model),
    );
    if (relayModels.length === 0) return null;
    const template =
      official.find((entry) => entry.isDefault !== true && entry.hidden !== true) ?? official[0];
    const additions = relayModels.map(({ model, relayName }) => {
      const entry: JsonRecord = { ...(template ?? {}) };
      delete entry.upgrade;
      delete entry.upgradeInfo;
      delete entry.availabilityNux;
      return {
        ...entry,
        id: model,
        model,
        displayName: model,
        description: `${relayName} · RLY/0`,
        hidden: false,
        isDefault: false,
        ...(template ? {} : { supportedReasoningEfforts: [] }),
      };
    });
    return { ...response, result: { ...result, data: [...result.data, ...additions] } };
  }

  async isRelayModel(model: unknown): Promise<boolean> {
    if (typeof model !== "string" || !model || this.#officialModels.has(model)) return false;
    const { models, patterns } = await this.#relayModels();
    const listed =
      models.some((entry) => entry.model === model) ||
      patterns.some((prefix) => model.startsWith(prefix));
    if (!listed) return false;
    await this.#ensureOfficialModels();
    return !this.#officialModels.has(model);
  }

  /** Starts the local proxy when needed and returns its OpenAI-compatible base URL. */
  async ensureProxy(): Promise<string> {
    const status = await this.#core.proxyStatus();
    if (status.available && status.running) return status.baseUrl;
    const port =
      status.available && !status.running && status.defaultPort
        ? status.defaultPort
        : RLY0_PROXY_DEFAULT_PORT;
    const started = await this.#core.proxyStart({ port });
    if (started.available && started.running) return started.baseUrl;
    throw new Error("RLY0_PROXY_UNAVAILABLE");
  }

  /**
   * For thread creation/resume params naming a relay model: the params to send instead
   * (provider switched to the local proxy), or `null` to forward the original request.
   */
  async rewriteThreadParams(params: JsonRecord): Promise<JsonRecord | null> {
    if (!(await this.isRelayModel(params.model))) {
      // A conversation started on a relay model is recorded with the `rly0` provider; resuming it
      // later needs the provider defined again even when the request names no model.
      if (typeof params.model === "string" && params.model) return null;
      const { models, patterns } = await this.#relayModels();
      if (models.length === 0 && patterns.length === 0) return null;
      const status = await withTimeout(this.#core.proxyStatus(), LIST_TIMEOUT_MS);
      const baseUrl =
        status?.available && status.running
          ? status.baseUrl
          : `http://127.0.0.1:${RLY0_PROXY_DEFAULT_PORT}/v1`;
      return this.#withProviderDefinition(params, baseUrl);
    }
    const baseUrl = await this.ensureProxy();
    return {
      ...this.#withProviderDefinition(params, baseUrl),
      modelProvider: RLY0_CODEX_PROVIDER_ID,
    };
  }

  #withProviderDefinition(params: JsonRecord, baseUrl: string): JsonRecord {
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
          // the proxy strips it before anything reaches a relay.
          requires_openai_auth: true,
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
    if (!threadId || !provider) return;
    this.#threadProviders.delete(threadId);
    this.#threadProviders.set(threadId, provider);
    if (this.#threadProviders.size > MAX_TRACKED_THREADS) {
      const oldest = this.#threadProviders.keys().next().value;
      if (oldest !== undefined) this.#threadProviders.delete(oldest);
    }
  }

  threadProvider(threadId: string): string | undefined {
    return this.#threadProviders.get(threadId);
  }
}

export const RLY0_RELAY_THREAD_MISMATCH_MESSAGE =
  "这个对话不是用中转模型开始的，无法中途切换到中转模型。请新建对话后再选择中转模型。 (This conversation was not started on a relay model; start a new conversation to use one.)";
export const RLY0_RELAY_PROXY_FAILED_MESSAGE =
  "RLY/0 本地代理启动失败，无法使用中转模型。请到 设置 → 中转站 查看。 (The RLY/0 local proxy could not start.)";
