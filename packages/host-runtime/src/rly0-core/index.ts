import {
  rly0AccountUsageSchema,
  rly0ProxyRequestSchema,
  rly0ProxySettingsSchema,
  rly0RelaySchema,
  type Rly0Account,
  type Rly0AccountUsage,
  type Rly0AccountUsageEntry,
  type Rly0AccountsImportCurrentParams,
  type Rly0AccountsImportCurrentResult,
  type Rly0AccountsListResult,
  type Rly0AccountsRemoveParams,
  type Rly0AccountsRemoveResult,
  type Rly0AccountsRenameParams,
  type Rly0AccountsRenameResult,
  type Rly0AccountsSwitchParams,
  type Rly0AccountsSwitchResult,
  type Rly0AccountsUsageAllResult,
  type Rly0AccountsUsageParams,
  type Rly0AccountsUsageResult,
  type Rly0CoreStatusResult,
  type Rly0ProxyRequest,
  type Rly0ProxySettings,
  type Rly0ProxySettingsSetResult,
  type Rly0ProxyStartParams,
  type Rly0ProxyStatusResult,
  type Rly0ProxyStopResult,
  type Rly0Relay,
  type Rly0RelayAddParams,
  type Rly0RelayAddResult,
  type Rly0RelayListResult,
  type Rly0RelayMutationResult,
  type Rly0RelayRemoveParams,
  type Rly0RelayRemoveResult,
  type Rly0RelaySetEnabledParams,
  type Rly0RelayTestParams,
  type Rly0RelayBalanceParams,
  type Rly0RelayBalanceResult,
  type Rly0RelayTestResult,
  type Rly0RelayUpdateParams,
} from "@codexhost/shared-contracts";

import { Rly0CoreClient, type Rly0CoreClientOptions } from "./client.js";
import {
  applyProxyEnvironment,
  DEFAULT_RLY0_PROXY_SETTINGS,
  readRly0ProxySettingsSync,
  resolveRly0ProxySettingsPath,
  writeRly0ProxySettings,
} from "./proxy-settings.js";

export { Rly0CoreClient, resolveRly0CoreBinaryPath } from "./client.js";
export type { Rly0CoreClientOptions, Rly0CoreResponse } from "./client.js";
export {
  applyProxyEnvironment,
  DEFAULT_RLY0_PROXY_SETTINGS,
  readRly0ProxySettingsSync,
  resolveRly0ProxySettingsPath,
  writeRly0ProxySettings,
} from "./proxy-settings.js";

export type Rly0LiveAccount =
  | { readonly loggedIn: false }
  | {
      readonly loggedIn: true;
      readonly saved: boolean;
      readonly id?: string;
      readonly email?: string;
      readonly plan?: string;
    };

interface CoreHelloResult {
  readonly name: string;
  readonly version: string;
  readonly capabilities: string[];
}

/** Per-method timeouts: usage lookups hit the network and `usageAll` walks accounts serially. */
const USAGE_TIMEOUT_MS = 30_000;
const USAGE_ALL_TIMEOUT_MS = 90_000;
const RELAY_TEST_TIMEOUT_MS = 30_000;
const PROXY_START_TIMEOUT_MS = 15_000;

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{12}$/u;

export interface Rly0CoreBridgeOptions extends Omit<Rly0CoreClientOptions, "prepareEnvironment"> {
  /**
   * Where the outbound proxy choice is persisted. Defaults to
   * `<RLY/0 Hub data dir>/proxy-settings.json` when an `environment` is given; `null` (or no
   * environment) keeps the choice in memory only.
   */
  readonly proxySettingsPath?: string | null;
}

function coreError(code: string): Error {
  return Object.assign(new Error(code), { code: -32000 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function optionalBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Picks only the documented usage fields; returns `undefined` when the shape is unusable. */
export function sanitizeRly0Usage(raw: unknown): Rly0AccountUsage | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.windows)) return undefined;
  const windows = raw.windows.slice(0, 8).flatMap((window) => {
    if (!isRecord(window)) return [];
    if (window.kind !== "primary" && window.kind !== "secondary") return [];
    if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return [];
    return [
      compact({
        kind: window.kind,
        usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
        windowSeconds: optionalInt(window.windowSeconds),
        resetsAt: optionalInt(window.resetsAt),
      }),
    ];
  });
  const parsed = rly0AccountUsageSchema.safeParse(
    compact({
      windows,
      plan: optionalString(raw.plan, 64),
      fetchedAt: optionalInt(raw.fetchedAt),
      source: raw.source === "snapshot" ? "snapshot" : "live",
    }),
  );
  return parsed.success ? parsed.data : undefined;
}

function sanitizeAccount(raw: unknown): Rly0Account[] {
  if (!isRecord(raw) || typeof raw.id !== "string" || !ACCOUNT_ID_PATTERN.test(raw.id)) return [];
  const lastUsage = sanitizeRly0Usage(raw.lastUsage);
  return [
    compact({
      id: raw.id,
      alias: optionalString(raw.alias, 40),
      email: optionalString(raw.email, 320),
      plan: optionalString(raw.plan, 64),
      accountId: optionalString(raw.accountId, 256),
      addedAt: optionalString(raw.addedAt, 64),
      updatedAt: optionalString(raw.updatedAt, 64),
      current: raw.current === true,
      lastUsage,
    }),
  ];
}

/**
 * Picks the documented relay fields only. Anything key-shaped other than the core's own mask is
 * dropped here, so even a misbehaving core cannot push an API key through to the renderer.
 */
export function sanitizeRly0Relay(raw: unknown): Rly0Relay {
  if (!isRecord(raw)) throw coreError("RLY0_CORE_BAD_RESPONSE");
  const parsed = rly0RelaySchema.safeParse(
    compact({
      id: raw.id,
      name: optionalString(raw.name, 64) ?? "",
      baseUrl: optionalString(raw.baseUrl, 2048) ?? "",
      protocol: "responses",
      models: Array.isArray(raw.models)
        ? raw.models
            .filter((model): model is string => typeof model === "string")
            .slice(0, 256)
            .map((model) => model.slice(0, 128))
        : [],
      enabled: raw.enabled === true,
      routeLocked: optionalBool(raw.routeLocked),
      addedAt: optionalInt(raw.addedAt),
      updatedAt: optionalInt(raw.updatedAt),
      hasKey: raw.hasKey === true,
      keyMask: optionalString(raw.keyMask, 64),
    }),
  );
  if (!parsed.success) throw coreError("RLY0_CORE_BAD_RESPONSE");
  return parsed.data;
}

function sanitizeProxyRequest(raw: unknown): Rly0ProxyRequest[] {
  if (!isRecord(raw)) return [];
  const parsed = rly0ProxyRequestSchema.safeParse(
    compact({
      at: optionalInt(raw.at),
      method: optionalString(raw.method, 16),
      path: optionalString(raw.path, 512),
      model: optionalString(raw.model, 128),
      relay: optionalString(raw.relay, 64),
      relayId: optionalString(raw.relayId, 64),
      route: raw.route === "official" ? ("official" as const) : undefined,
      status: optionalInt(raw.status),
      ms: typeof raw.ms === "number" && Number.isFinite(raw.ms) ? Math.max(0, raw.ms) : undefined,
    }),
  );
  return parsed.success ? [parsed.data] : [];
}

function sanitizeProxyStatus(raw: unknown): Rly0ProxyStatusResult {
  if (!isRecord(raw) || raw.running !== true) {
    const defaultPort = isRecord(raw) ? optionalInt(raw.defaultPort) : undefined;
    return compact({ available: true as const, running: false as const, defaultPort });
  }
  const port = optionalInt(raw.port);
  if (port === undefined || port < 1 || port > 65_535) throw coreError("RLY0_CORE_BAD_RESPONSE");
  const recent = Array.isArray(raw.recent)
    ? raw.recent.slice(-200).flatMap(sanitizeProxyRequest)
    : [];
  return compact({
    available: true as const,
    running: true as const,
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    startedAt: optionalInt(raw.startedAt),
    requests: optionalInt(raw.requests) ?? 0,
    routed: optionalInt(raw.routed) ?? 0,
    official: optionalInt(raw.official),
    unrouted: optionalInt(raw.unrouted) ?? 0,
    failed: optionalInt(raw.failed) ?? 0,
    recent,
    alreadyRunning: optionalBool(raw.alreadyRunning),
  });
}

/**
 * Typed facade over `Rly0CoreClient`, shaping raw JSON-RPC results into the shared-contracts
 * result unions (always including the `available` discriminant) so `app-server-host.ts` only
 * has to parse and forward. Every result is rebuilt from an allowlist of documented fields.
 */
export class Rly0CoreBridge {
  readonly #client: Rly0CoreClient;
  readonly #proxySettingsPath: string | null;
  #proxySettings: Rly0ProxySettings | undefined;

  constructor(options: Rly0CoreBridgeOptions = {}) {
    const { proxySettingsPath, ...clientOptions } = options;
    this.#proxySettingsPath =
      proxySettingsPath !== undefined
        ? proxySettingsPath
        : options.environment
          ? resolveRly0ProxySettingsPath(options.environment)
          : null;
    this.#client = new Rly0CoreClient({
      ...clientOptions,
      prepareEnvironment: (environment) =>
        applyProxyEnvironment(environment, this.getProxySettings()),
    });
  }

  /** Lazily loaded so constructing the bridge never touches disk. */
  getProxySettings(): Rly0ProxySettings {
    if (this.#proxySettings === undefined) {
      this.#proxySettings = this.#proxySettingsPath
        ? readRly0ProxySettingsSync(this.#proxySettingsPath)
        : DEFAULT_RLY0_PROXY_SETTINGS;
    }
    return this.#proxySettings;
  }

  /**
   * Persists the proxy choice and, when rly0-core is already running, restarts it so the new
   * environment takes effect. A local routing proxy that was running is started again on the same
   * port.
   */
  async setProxySettings(settings: Rly0ProxySettings): Promise<Rly0ProxySettingsSetResult> {
    const next = rly0ProxySettingsSchema.parse(
      settings.mode === "custom" ? settings : { mode: settings.mode },
    );
    if (this.#proxySettingsPath) await writeRly0ProxySettings(this.#proxySettingsPath, next);
    this.#proxySettings = next;
    if (!this.#client.isRunning) return { settings: next, coreRestarted: false };
    let proxyPort: number | undefined;
    try {
      const status = await this.proxyStatus();
      if (status.available && status.running) proxyPort = status.port;
    } catch {
      proxyPort = undefined;
    }
    this.#client.restart();
    if (proxyPort !== undefined) {
      try {
        await this.proxyStart({ port: proxyPort });
      } catch {
        // The page shows the proxy as stopped; the user can start it again.
      }
    }
    return { settings: next, coreRestarted: true };
  }

  async status(): Promise<Rly0CoreStatusResult> {
    const response = await this.#client.request<CoreHelloResult>("core/hello", {});
    if (!response.available) return { available: false };
    return {
      available: true,
      name: response.result.name,
      version: response.result.version,
      capabilities: response.result.capabilities,
    };
  }

  async listAccounts(): Promise<Rly0AccountsListResult> {
    const response = await this.#client.request<{
      accounts?: unknown;
      liveLoggedIn?: unknown;
      liveUnsaved?: unknown;
    }>("accounts/list", {});
    if (!response.available) return { available: false, accounts: [] };
    const accounts = Array.isArray(response.result.accounts)
      ? response.result.accounts.slice(0, 64).flatMap(sanitizeAccount)
      : [];
    return compact({
      available: true as const,
      accounts,
      liveLoggedIn: optionalBool(response.result.liveLoggedIn),
      liveUnsaved: optionalBool(response.result.liveUnsaved),
    });
  }

  async importCurrent(
    params: Rly0AccountsImportCurrentParams,
  ): Promise<Rly0AccountsImportCurrentResult> {
    const response = await this.#client.request<{ id: string }>("accounts/importCurrent", params);
    if (!response.available) return { available: false };
    return { available: true, id: response.result.id };
  }

  /** Saves the login found in a temporary `rly0-login-*` CODEX_HOME (the "add account" flow). */
  async importFrom(params: {
    codexHome: string;
    alias?: string;
  }): Promise<Rly0AccountsImportCurrentResult> {
    const response = await this.#client.request<{ id: string }>("accounts/importFrom", params);
    if (!response.available) return { available: false };
    return { available: true, id: response.result.id };
  }

  async switchAccount(params: Rly0AccountsSwitchParams): Promise<Rly0AccountsSwitchResult> {
    const response = await this.#client.request<{
      switched: boolean;
      requiresRestart?: boolean;
      alias?: string;
      alreadyCurrent?: boolean;
    }>("accounts/switch", params);
    if (!response.available) return { available: false, switched: false };
    return { available: true, ...response.result };
  }

  async rename(params: Rly0AccountsRenameParams): Promise<Rly0AccountsRenameResult> {
    const response = await this.#client.request<{ ok: boolean }>("accounts/rename", params);
    if (!response.available) return { available: false, ok: false };
    return { available: true, ok: response.result.ok };
  }

  async remove(params: Rly0AccountsRemoveParams): Promise<Rly0AccountsRemoveResult> {
    const response = await this.#client.request<{ ok: boolean }>("accounts/remove", params);
    if (!response.available) return { available: false, ok: false };
    return { available: true, ok: response.result.ok };
  }

  /** Who is logged into Codex now, saved or not. Identity claims only. */
  async currentAccount(): Promise<Rly0LiveAccount> {
    const response = await this.#client.request<Record<string, unknown>>("accounts/current", {});
    if (!response.available || !isRecord(response.result) || response.result.loggedIn !== true) {
      return { loggedIn: false };
    }
    const raw = response.result;
    const email = optionalString(raw.email, 320);
    const plan = optionalString(raw.plan, 64);
    return {
      loggedIn: true,
      saved: raw.saved === true,
      ...(typeof raw.id === "string" && ACCOUNT_ID_PATTERN.test(raw.id) ? { id: raw.id } : {}),
      ...(email ? { email } : {}),
      ...(plan ? { plan } : {}),
    };
  }

  /** Quota of the live Codex login, saved or not. */
  async usageCurrent(): Promise<Rly0AccountsUsageResult> {
    const response = await this.#client.request<unknown>(
      "accounts/usageCurrent",
      {},
      {
        timeoutMs: USAGE_TIMEOUT_MS,
      },
    );
    if (!response.available) return { available: false };
    const usage = sanitizeRly0Usage(response.result);
    if (!usage) throw coreError("USAGE_BAD_RESPONSE");
    return { available: true, usage };
  }

  async usage(params: Rly0AccountsUsageParams): Promise<Rly0AccountsUsageResult> {
    const response = await this.#client.request<unknown>("accounts/usage", params, {
      timeoutMs: USAGE_TIMEOUT_MS,
    });
    if (!response.available) return { available: false };
    const usage = sanitizeRly0Usage(response.result);
    if (!usage) throw coreError("USAGE_BAD_RESPONSE");
    return { available: true, usage };
  }

  async usageAll(): Promise<Rly0AccountsUsageAllResult> {
    const response = await this.#client.request<{ results?: unknown }>(
      "accounts/usageAll",
      {},
      { timeoutMs: USAGE_ALL_TIMEOUT_MS },
    );
    if (!response.available) return { available: false };
    const raw = Array.isArray(response.result?.results) ? response.result.results : [];
    const results = raw.slice(0, 64).flatMap((entry): Rly0AccountUsageEntry[] => {
      if (!isRecord(entry) || typeof entry.id !== "string" || !ACCOUNT_ID_PATTERN.test(entry.id)) {
        return [];
      }
      if ("usage" in entry) {
        const usage = sanitizeRly0Usage(entry.usage);
        return [usage ? { id: entry.id, usage } : { id: entry.id, error: "USAGE_BAD_RESPONSE" }];
      }
      const code =
        typeof entry.error === "string" && ERROR_CODE_PATTERN.test(entry.error)
          ? entry.error
          : "USAGE_BAD_RESPONSE";
      return [{ id: entry.id, error: code }];
    });
    return { available: true, results };
  }

  async listRelays(): Promise<Rly0RelayListResult> {
    const response = await this.#client.request<{ relays?: unknown }>("relay/list", {});
    if (!response.available) return { available: false };
    const relays = Array.isArray(response.result?.relays)
      ? response.result.relays.slice(0, 256).map(sanitizeRly0Relay)
      : [];
    return { available: true, relays };
  }

  async addRelay(params: Rly0RelayAddParams): Promise<Rly0RelayAddResult> {
    const response = await this.#client.request<{ id?: unknown; relay?: unknown }>(
      "relay/add",
      params,
    );
    if (!response.available) return { available: false };
    const relay = sanitizeRly0Relay(response.result?.relay);
    return { available: true, id: relay.id, relay };
  }

  async updateRelay(params: Rly0RelayUpdateParams): Promise<Rly0RelayMutationResult> {
    const response = await this.#client.request<{ relay?: unknown }>("relay/update", params);
    if (!response.available) return { available: false };
    return { available: true, relay: sanitizeRly0Relay(response.result?.relay) };
  }

  async setRelayEnabled(params: Rly0RelaySetEnabledParams): Promise<Rly0RelayMutationResult> {
    const response = await this.#client.request<{ relay?: unknown }>("relay/setEnabled", params);
    if (!response.available) return { available: false };
    return { available: true, relay: sanitizeRly0Relay(response.result?.relay) };
  }

  async removeRelay(params: Rly0RelayRemoveParams): Promise<Rly0RelayRemoveResult> {
    const response = await this.#client.request<{ ok?: unknown }>("relay/remove", params);
    if (!response.available) return { available: false };
    return { available: true, ok: response.result?.ok === true };
  }

  async relayBalance(params: Rly0RelayBalanceParams): Promise<Rly0RelayBalanceResult> {
    const response = await this.#client.request<Record<string, unknown>>("relay/balance", params, {
      timeoutMs: RELAY_TEST_TIMEOUT_MS,
    });
    if (!response.available) return { available: false };
    const raw = isRecord(response.result) ? response.result : {};
    const money = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12
        ? value
        : undefined;
    const status = optionalInt(raw.status);
    const error = optionalString(raw.error, 200);
    return compact({
      available: true as const,
      ok: raw.ok === true,
      valid: optionalBool(raw.valid),
      balance: raw.balance === null ? null : money(raw.balance),
      unit:
        raw.unit === "USD" || raw.unit === "CNY"
          ? (raw.unit as "USD" | "CNY")
          : raw.unit === null
            ? null
            : undefined,
      todayCost: money(raw.todayCost),
      totalCost: money(raw.totalCost),
      rate:
        typeof raw.rate === "number" &&
        Number.isFinite(raw.rate) &&
        raw.rate >= 0 &&
        raw.rate <= 1000
          ? raw.rate
          : undefined,
      status: status !== undefined && status <= 999 ? status : undefined,
      error:
        error === undefined
          ? undefined
          : ERROR_CODE_PATTERN.test(error)
            ? error
            : "RELAY_BALANCE_FAILED",
    });
  }

  async testRelay(params: Rly0RelayTestParams): Promise<Rly0RelayTestResult> {
    const response = await this.#client.request<Record<string, unknown>>("relay/test", params, {
      timeoutMs: RELAY_TEST_TIMEOUT_MS,
    });
    if (!response.available) return { available: false };
    const raw = isRecord(response.result) ? response.result : {};
    const status = optionalInt(raw.status);
    const error = optionalString(raw.error, 200);
    return compact({
      available: true as const,
      ok: raw.ok === true,
      latencyMs:
        typeof raw.latencyMs === "number" && Number.isFinite(raw.latencyMs)
          ? Math.min(10_000_000, Math.max(0, raw.latencyMs))
          : 0,
      status: status !== undefined && status <= 999 ? status : undefined,
      modelCount: optionalInt(raw.modelCount),
      models: Array.isArray(raw.models)
        ? raw.models
            .filter((model): model is string => typeof model === "string" && model.length <= 128)
            .slice(0, 256)
        : undefined,
      // Only forward code-shaped errors; free text from upstream could echo request details.
      error:
        error === undefined
          ? undefined
          : ERROR_CODE_PATTERN.test(error)
            ? error
            : "RELAY_TEST_FAILED",
    });
  }

  async proxyStart(params: Rly0ProxyStartParams): Promise<Rly0ProxyStatusResult> {
    const response = await this.#client.request<unknown>("proxy/start", params, {
      timeoutMs: PROXY_START_TIMEOUT_MS,
    });
    if (!response.available) return { available: false };
    return sanitizeProxyStatus(response.result);
  }

  async proxyStop(): Promise<Rly0ProxyStopResult> {
    const response = await this.#client.request<{ stopped?: unknown }>("proxy/stop", {});
    if (!response.available) return { available: false };
    return { available: true, stopped: response.result?.stopped === true };
  }

  async proxyStatus(): Promise<Rly0ProxyStatusResult> {
    const response = await this.#client.request<unknown>("proxy/status", {});
    if (!response.available) return { available: false };
    return sanitizeProxyStatus(response.result);
  }

  async dispose(): Promise<void> {
    await this.#client.dispose();
  }
}

/**
 * Maps a rejected `Rly0CoreBridge` call to a JSON-RPC error to send to the renderer. rly0-core's
 * own business errors already carry a short code (e.g. `CODEX_NOT_LOGGED_IN`) as `error.message`
 * with `error.code === -32000`; that code is forwarded only when it is code-shaped, so free text
 * (which could echo request details) never leaves the host. Anything else (timeout, crash,
 * malformed response) collapses to a generic code so no path/stack detail can leak.
 */
export function rly0CoreRpcError(error: unknown): { code: number; message: string } {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (error instanceof Error && typeof code === "number") {
    return {
      code,
      message: ERROR_CODE_PATTERN.test(error.message) ? error.message : "RLY0_CORE_ERROR",
    };
  }
  if (error instanceof Error) {
    for (const known of ["RLY0_CORE_TIMEOUT", "RLY0_CORE_EXITED", "RLY0_CORE_RESTARTED"]) {
      if (error.message === known) return { code: -32000, message: known };
    }
  }
  return { code: -32000, message: "RLY0_CORE_ERROR" };
}
