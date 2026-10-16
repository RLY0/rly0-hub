import { z } from "zod";

/**
 * Contracts for the relay ("中转") injection page. Relays and the local routing proxy live in the
 * optional, closed-source `rly0-core`; every core-backed result carries an `available` flag so a
 * missing core degrades to a typed result. API keys only travel renderer → host → core on
 * add/update; results expose `hasKey`/`keyMask` and never the key itself.
 *
 * The Codex config injection (`[model_providers.rly0]` in `${CODEX_HOME}/config.toml`) is
 * implemented in the open-source host and works without the core.
 */

export const RLY0_RELAY_LIST_METHOD = "codexhost/rly0/relay/list";
export const RLY0_RELAY_ADD_METHOD = "codexhost/rly0/relay/add";
export const RLY0_RELAY_UPDATE_METHOD = "codexhost/rly0/relay/update";
export const RLY0_RELAY_REMOVE_METHOD = "codexhost/rly0/relay/remove";
export const RLY0_RELAY_SET_ENABLED_METHOD = "codexhost/rly0/relay/setEnabled";
export const RLY0_RELAY_TEST_METHOD = "codexhost/rly0/relay/test";
export const RLY0_RELAY_BALANCE_METHOD = "codexhost/rly0/relay/balance";
export const RLY0_PROXY_START_METHOD = "codexhost/rly0/proxy/start";
export const RLY0_PROXY_STOP_METHOD = "codexhost/rly0/proxy/stop";
export const RLY0_PROXY_STATUS_METHOD = "codexhost/rly0/proxy/status";
export const RLY0_RELAY_CODEX_CONFIG_STATUS_METHOD = "codexhost/rly0/relay/codexConfig/status";
export const RLY0_RELAY_CODEX_CONFIG_APPLY_METHOD = "codexhost/rly0/relay/codexConfig/apply";
export const RLY0_RELAY_CODEX_CONFIG_RESTORE_METHOD = "codexhost/rly0/relay/codexConfig/restore";
export const RLY0_RELAY_MODEL_CATALOG_STATUS_METHOD = "codexhost/rly0/relay/modelCatalog/status";
export const RLY0_RELAY_AGENTS_GET_METHOD = "codexhost/rly0/relay/agents/get";
export const RLY0_RELAY_AGENTS_SET_METHOD = "codexhost/rly0/relay/agents/set";
export const RLY0_AGENTS_CLAUDE_AUTH_STATUS_METHOD = "codexhost/rly0/agents/claudeCode/authStatus";
export const RLY0_AGENTS_CLAUDE_AUTH_LOGIN_METHOD = "codexhost/rly0/agents/claudeCode/login";
export const RLY0_AGENTS_CLAUDE_AUTH_LOGOUT_METHOD = "codexhost/rly0/agents/claudeCode/logout";
export const RLY0_AGENTS_INSTALL_START_METHOD = "codexhost/rly0/agents/install/start";
export const RLY0_AGENTS_INSTALL_STATUS_METHOD = "codexhost/rly0/agents/install/status";
export const RLY0_AGENTS_OPEN_LOGIN_METHOD = "codexhost/rly0/agents/openLogin";

/** Not 25817: AiMaMi's router proxy uses that port, and the two are often installed together. */
export const RLY0_PROXY_DEFAULT_PORT = 25917;
/** Provider table name written into Codex's config.toml. */
export const RLY0_CODEX_PROVIDER_ID = "rly0";
export const RLY0_CODEX_PROVIDER_NAME = "RLY/0 Hub 本地代理";

export const rly0RelayIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
export type Rly0RelayId = z.infer<typeof rly0RelayIdSchema>;

export const rly0RelayNameSchema = z.string().trim().min(1).max(64);
export const rly0RelayBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .regex(/^https?:\/\/[^\s]+$/iu);
/** Model names or `prefix*` patterns. */
export const rly0RelayModelSchema = z.string().regex(/^[^\s"'\\]{1,128}$/u);
export const rly0RelayModelsSchema = z.array(rly0RelayModelSchema).max(256);
export const rly0RelayApiKeySchema = z.string().trim().min(1).max(512);

const unixSeconds = z.number().int().nonnegative().max(100_000_000_000);

export const rly0RelaySchema = z
  .object({
    id: rly0RelayIdSchema,
    name: z.string().max(64),
    baseUrl: z.string().max(2048),
    protocol: z.literal("responses"),
    models: z.array(z.string().max(128)).max(256),
    enabled: z.boolean(),
    routeLocked: z.boolean().optional(),
    addedAt: unixSeconds.optional(),
    updatedAt: unixSeconds.optional(),
    hasKey: z.boolean(),
    keyMask: z.string().max(64).optional(),
  })
  .strict();
export type Rly0Relay = z.infer<typeof rly0RelaySchema>;

const unavailable = z.object({ available: z.literal(false) }).strict();

export const rly0RelayListParamsSchema = z.object({}).strict();
export type Rly0RelayListParams = z.infer<typeof rly0RelayListParamsSchema>;
export const rly0RelayListResultSchema = z.discriminatedUnion("available", [
  unavailable,
  z.object({ available: z.literal(true), relays: z.array(rly0RelaySchema).max(256) }).strict(),
]);
export type Rly0RelayListResult = z.infer<typeof rly0RelayListResultSchema>;

export const rly0RelayAddParamsSchema = z
  .object({
    name: rly0RelayNameSchema,
    baseUrl: rly0RelayBaseUrlSchema,
    apiKey: rly0RelayApiKeySchema.optional(),
    models: rly0RelayModelsSchema.optional(),
    enabled: z.boolean().optional(),
    /** Send every model no relay lists to this relay instead of the official account. */
    routeLocked: z.boolean().optional(),
  })
  .strict();
export type Rly0RelayAddParams = z.infer<typeof rly0RelayAddParamsSchema>;
export const rly0RelayAddResultSchema = z.discriminatedUnion("available", [
  unavailable,
  z.object({ available: z.literal(true), id: rly0RelayIdSchema, relay: rly0RelaySchema }).strict(),
]);
export type Rly0RelayAddResult = z.infer<typeof rly0RelayAddResultSchema>;

export const rly0RelayUpdateParamsSchema = z
  .object({
    id: rly0RelayIdSchema,
    name: rly0RelayNameSchema.optional(),
    baseUrl: rly0RelayBaseUrlSchema.optional(),
    /** Omitted = keep the stored key. */
    apiKey: rly0RelayApiKeySchema.optional(),
    clearKey: z.boolean().optional(),
    models: rly0RelayModelsSchema.optional(),
    enabled: z.boolean().optional(),
    routeLocked: z.boolean().optional(),
  })
  .strict();
export type Rly0RelayUpdateParams = z.infer<typeof rly0RelayUpdateParamsSchema>;
export const rly0RelayMutationResultSchema = z.discriminatedUnion("available", [
  unavailable,
  z.object({ available: z.literal(true), relay: rly0RelaySchema }).strict(),
]);
export type Rly0RelayMutationResult = z.infer<typeof rly0RelayMutationResultSchema>;

export const rly0RelaySetEnabledParamsSchema = z
  .object({ id: rly0RelayIdSchema, enabled: z.boolean() })
  .strict();
export type Rly0RelaySetEnabledParams = z.infer<typeof rly0RelaySetEnabledParamsSchema>;

export const rly0RelayRemoveParamsSchema = z.object({ id: rly0RelayIdSchema }).strict();
export type Rly0RelayRemoveParams = z.infer<typeof rly0RelayRemoveParamsSchema>;
export const rly0RelayRemoveResultSchema = z.discriminatedUnion("available", [
  unavailable,
  z.object({ available: z.literal(true), ok: z.boolean() }).strict(),
]);
export type Rly0RelayRemoveResult = z.infer<typeof rly0RelayRemoveResultSchema>;

export const rly0RelayTestParamsSchema = z.object({ id: rly0RelayIdSchema }).strict();
export type Rly0RelayTestParams = z.infer<typeof rly0RelayTestParamsSchema>;
export const rly0RelayTestResultSchema = z.discriminatedUnion("available", [
  unavailable,
  z
    .object({
      available: z.literal(true),
      ok: z.boolean(),
      latencyMs: z.number().nonnegative().max(10_000_000),
      status: z.number().int().min(0).max(999).optional(),
      modelCount: z.number().int().nonnegative().max(100_000).optional(),
      models: z.array(z.string().max(128)).max(256).optional(),
      error: z.string().max(200).optional(),
    })
    .strict(),
]);
export type Rly0RelayTestResult = z.infer<typeof rly0RelayTestResultSchema>;

/** Balance of the relay key's account (Sub2API `/v1/usage`); the key itself never leaves rly0-core. */
export const rly0RelayBalanceParamsSchema = z.object({ id: rly0RelayIdSchema }).strict();
export type Rly0RelayBalanceParams = z.infer<typeof rly0RelayBalanceParamsSchema>;
const money = z.number().finite().min(-1e12).max(1e12);
export const rly0RelayBalanceResultSchema = z.discriminatedUnion("available", [
  unavailable,
  z
    .object({
      available: z.literal(true),
      ok: z.boolean(),
      valid: z.boolean().optional(),
      balance: money.nullable().optional(),
      unit: z.enum(["USD", "CNY"]).nullable().optional(),
      todayCost: money.optional(),
      totalCost: money.optional(),
      status: z.number().int().min(0).max(999).optional(),
      error: z.string().max(200).optional(),
    })
    .strict(),
]);
export type Rly0RelayBalanceResult = z.infer<typeof rly0RelayBalanceResultSchema>;

export const rly0ProxyRequestSchema = z
  .object({
    at: unixSeconds,
    method: z.string().max(16),
    path: z.string().max(512),
    model: z.string().max(128).optional(),
    relay: z.string().max(64).optional(),
    relayId: z.string().max(64).optional(),
    /** `official` when no relay claimed the model and Codex's own login handled it. */
    route: z.literal("official").optional(),
    status: z.number().int().min(0).max(999),
    ms: z.number().nonnegative().max(10_000_000),
  })
  .strict();
export type Rly0ProxyRequest = z.infer<typeof rly0ProxyRequestSchema>;

const counter = z.number().int().nonnegative();
const proxyPortSchema = z.number().int().min(1).max(65_535);

export const rly0ProxyRunningSchema = z
  .object({
    running: z.literal(true),
    port: proxyPortSchema,
    baseUrl: z.string().max(64),
    startedAt: unixSeconds.optional(),
    requests: counter,
    routed: counter,
    /** Requests handed back to the official account (absent from older cores). */
    official: counter.optional(),
    unrouted: counter,
    failed: counter,
    recent: z.array(rly0ProxyRequestSchema).max(200),
    alreadyRunning: z.boolean().optional(),
  })
  .strict();

export const rly0ProxyStatusResultSchema = z.union([
  unavailable,
  rly0ProxyRunningSchema.extend({ available: z.literal(true) }).strict(),
  z
    .object({
      available: z.literal(true),
      running: z.literal(false),
      defaultPort: proxyPortSchema.optional(),
    })
    .strict(),
]);
export type Rly0ProxyStatusResult = z.infer<typeof rly0ProxyStatusResultSchema>;

export const rly0ProxyStatusParamsSchema = z.object({}).strict();
export type Rly0ProxyStatusParams = z.infer<typeof rly0ProxyStatusParamsSchema>;
export const rly0ProxyStartParamsSchema = z.object({ port: proxyPortSchema.optional() }).strict();
export type Rly0ProxyStartParams = z.infer<typeof rly0ProxyStartParamsSchema>;
export const rly0ProxyStopParamsSchema = z.object({}).strict();
export type Rly0ProxyStopParams = z.infer<typeof rly0ProxyStopParamsSchema>;
export const rly0ProxyStopResultSchema = z.discriminatedUnion("available", [
  unavailable,
  z.object({ available: z.literal(true), stopped: z.boolean() }).strict(),
]);
export type Rly0ProxyStopResult = z.infer<typeof rly0ProxyStopResultSchema>;

/** The proxy base URL is the only value written as `base_url`; it must be loopback. */
export const rly0LocalProxyBaseUrlSchema = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}\/v1$/u)
  .refine((value) => {
    const port = Number(/:(\d{1,5})\//u.exec(value)?.[1]);
    return port >= 1 && port <= 65_535;
  });

/**
 * Where Codex's model picker gets its entries. The official part always comes from Codex's own live
 * `model/list` (never a local snapshot); relay models are only appended after it. `refresh` reads
 * the official catalog again right now, to check it is reachable.
 */
export const rly0RelayModelCatalogStatusParamsSchema = z
  .object({ refresh: z.boolean().optional() })
  .strict();
export type Rly0RelayModelCatalogStatusParams = z.infer<
  typeof rly0RelayModelCatalogStatusParamsSchema
>;
export const rly0RelayModelCatalogStatusResultSchema = z
  .object({
    /** The last complete official catalog seen, or null before Codex or Hub has read one. */
    official: z
      .object({
        /** Unix milliseconds. */
        fetchedAt: z.number().int().nonnegative(),
        count: z.number().int().nonnegative().max(10_000),
        /** `codex`: Codex's own request passed through Hub. `hub`: Hub read it directly. */
        via: z.enum(["codex", "hub"]),
      })
      .strict()
      .nullable(),
    /** The latest direct read failed (code-shaped), after `official` was recorded or not. */
    lastError: z
      .object({ at: z.number().int().nonnegative(), message: z.string().max(300) })
      .strict()
      .optional(),
    /** Relay models appended after the official entries. */
    appended: rly0RelayModelsSchema,
    /** Relay models not added because the official catalog already has that name. */
    shadowed: rly0RelayModelsSchema,
    /**
     * Relay models of other model families. They are not added to Codex: each is meant to run in
     * its own vendor's agent (e.g. Claude models in Claude Code through a relay).
     */
    delegated: rly0RelayModelsSchema,
  })
  .strict();
export type Rly0RelayModelCatalogStatusResult = z.infer<
  typeof rly0RelayModelCatalogStatusResultSchema
>;

export const rly0RelayCodexConfigStatusParamsSchema = z.object({}).strict();
export type Rly0RelayCodexConfigStatusParams = z.infer<
  typeof rly0RelayCodexConfigStatusParamsSchema
>;
export const rly0RelayCodexConfigStatusResultSchema = z
  .object({
    configPath: z.string().max(4096),
    configExists: z.boolean(),
    /** `[model_providers.rly0]` is present. */
    providerPresent: z.boolean(),
    providerBaseUrl: z.string().max(2048).optional(),
    modelProvider: z.string().max(128).optional(),
    model: z.string().max(256).optional(),
    /** A previous apply recorded restore state under the RLY/0 Hub data directory. */
    applied: z.boolean(),
    setDefault: z.boolean().optional(),
    parseError: z.string().max(300).optional(),
    /**
     * Top-level `model_catalog_json` found in config.toml (left by another tool such as AiMaMi).
     * Codex then shows that file instead of the live official catalog, so new official models
     * go missing. RLY/0 Hub never writes it; it only reports it.
     */
    modelCatalogJson: z.string().max(4096).optional(),
  })
  .strict();
export type Rly0RelayCodexConfigStatusResult = z.infer<
  typeof rly0RelayCodexConfigStatusResultSchema
>;

export const rly0RelayCodexConfigApplyParamsSchema = z
  .object({
    baseUrl: rly0LocalProxyBaseUrlSchema,
    setDefault: z.boolean(),
    model: rly0RelayModelSchema.optional(),
  })
  .strict()
  .refine((value) => !value.setDefault || value.model !== undefined, {
    message: "setDefault requires model",
    path: ["model"],
  });
export type Rly0RelayCodexConfigApplyParams = z.infer<typeof rly0RelayCodexConfigApplyParamsSchema>;

export const rly0RelayCodexConfigRestoreParamsSchema = z.object({}).strict();
export type Rly0RelayCodexConfigRestoreParams = z.infer<
  typeof rly0RelayCodexConfigRestoreParamsSchema
>;

export const rly0RelayCodexConfigMutationResultSchema = z
  .object({
    ok: z.boolean(),
    status: rly0RelayCodexConfigStatusResultSchema,
    /** Set by the Host after a successful write: whether the official backend hot-reloaded. */
    backendReload: z.enum(["reloaded", "deferred", "failed"]).optional(),
  })
  .strict();
export type Rly0RelayCodexConfigMutationResult = z.infer<
  typeof rly0RelayCodexConfigMutationResultSchema
>;

/**
 * Native agents driven by a relay. Claude Code gets RLY/0 Hub's local proxy as its Anthropic
 * endpoint (pinned to one relay); the relay key stays in rly0-core. Applied when the agent is
 * loaded, so a change needs a Codex restart once agents are running.
 */
export const rly0RelayAgentsGetParamsSchema = z.object({}).strict();
export type Rly0RelayAgentsGetParams = z.infer<typeof rly0RelayAgentsGetParamsSchema>;
export const rly0RelayAgentsSetParamsSchema = z
  .object({ claudeCode: rly0RelayIdSchema.nullable() })
  .strict();
export type Rly0RelayAgentsSetParams = z.infer<typeof rly0RelayAgentsSetParamsSchema>;
export const rly0RelayAgentsResultSchema = z
  .object({
    /** Saved choice: relay id, or null for the agent's own login. */
    claudeCode: rly0RelayIdSchema.nullable(),
    /** What the running agents use; null before agents are loaded. */
    active: z.object({ claudeCode: rly0RelayIdSchema.nullable() }).strict().nullable(),
    /** The saved choice differs from what is running: restart Codex to apply it. */
    restartRequired: z.boolean(),
  })
  .strict();
export type Rly0RelayAgentsResult = z.infer<typeof rly0RelayAgentsResultSchema>;

/** A native agent's own login, as the agent itself reports it (RLY/0 Hub never holds it). */
export const rly0AgentAuthStatusSchema = z
  .object({
    installed: z.boolean(),
    loggedIn: z.boolean(),
    method: z.string().max(200).optional(),
    email: z.string().max(200).optional(),
    plan: z.string().max(200).optional(),
    loginInProgress: z.boolean().optional(),
    error: z.enum(["STATUS_UNREADABLE", "STATUS_TIMEOUT", "STATUS_FAILED"]).optional(),
  })
  .strict();
export type Rly0AgentAuthStatus = z.infer<typeof rly0AgentAuthStatusSchema>;
export const rly0AgentAuthStatusParamsSchema = z.object({}).strict();
export const rly0AgentAuthLoginParamsSchema = z
  .object({ mode: z.enum(["claudeai", "console"]) })
  .strict();
export type Rly0AgentAuthLoginParams = z.infer<typeof rly0AgentAuthLoginParamsSchema>;
export const rly0AgentAuthLoginResultSchema = z
  .object({
    started: z.boolean(),
    /** The sign-in page, when the agent printed it, for opening by hand. */
    url: z
      .string()
      .max(2048)
      .regex(/^https:\/\//u)
      .optional(),
  })
  .strict();
export type Rly0AgentAuthLoginResult = z.infer<typeof rly0AgentAuthLoginResultSchema>;
export const rly0AgentAuthLogoutParamsSchema = z.object({}).strict();
export const rly0AgentAuthLogoutResultSchema = z.object({ ok: z.boolean() }).strict();
export type Rly0AgentAuthLogoutResult = z.infer<typeof rly0AgentAuthLogoutResultSchema>;

/** One-click installation of a native agent (see host `AgentInstaller`). */
export const rly0AgentIdParamsSchema = z
  .object({ agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u) })
  .strict();
export type Rly0AgentIdParams = z.infer<typeof rly0AgentIdParamsSchema>;
export const rly0AgentInstallStatusSchema = z
  .object({
    state: z.enum(["idle", "running", "succeeded", "failed"]),
    /** False for agents that can only be installed by hand (desktop apps). */
    automatic: z.boolean(),
    requirementReason: z
      .enum(["WINGET_UNAVAILABLE", "NETWORK", "PERMISSION", "INSTALL_FAILED", "NOT_DETECTED"])
      .optional(),
    canOpenLogin: z.boolean().optional(),
    step: z
      .enum(["installingNode", "installingGit", "officialInstaller", "npm", "npmMirror"])
      .optional(),
    error: z
      .enum([
        "NETWORK",
        "PERMISSION",
        "FAILED",
        "NODE_MISSING",
        "GIT_MISSING",
        "MANUAL",
        "UNSUPPORTED",
      ])
      .optional(),
    log: z.string().max(12_000).optional(),
    startedAt: z.number().int().nonnegative().optional(),
    finishedAt: z.number().int().nonnegative().optional(),
    manualUrl: z
      .string()
      .max(2048)
      .regex(/^https:\/\//u)
      .optional(),
  })
  .strict();
export type Rly0AgentInstallStatus = z.infer<typeof rly0AgentInstallStatusSchema>;
export const rly0AgentOpenLoginResultSchema = z.object({ ok: z.boolean() }).strict();
export type Rly0AgentOpenLoginResult = z.infer<typeof rly0AgentOpenLoginResultSchema>;
