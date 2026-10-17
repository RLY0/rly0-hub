import { z } from "zod";

/**
 * Contracts for the optional, closed-source `rly0-core` bridge. It stores multiple saved Codex
 * logins on disk and can switch the active `~/.codex/auth.json` between them. The binary is not
 * part of this repository and may be absent; every result below carries an `available` flag so a
 * missing bridge degrades to a typed result instead of an RPC failure.
 */

export const RLY0_CORE_STATUS_METHOD = "codexhost/rly0/core/status";
export const RLY0_ACCOUNTS_LIST_METHOD = "codexhost/rly0/accounts/list";
export const RLY0_ACCOUNTS_IMPORT_CURRENT_METHOD = "codexhost/rly0/accounts/importCurrent";
export const RLY0_ACCOUNTS_SWITCH_METHOD = "codexhost/rly0/accounts/switch";
export const RLY0_ACCOUNTS_RENAME_METHOD = "codexhost/rly0/accounts/rename";
export const RLY0_ACCOUNTS_REMOVE_METHOD = "codexhost/rly0/accounts/remove";

/** rly0-core mints ids as 12 lowercase hex characters. */
export const rly0AccountIdSchema = z.string().regex(/^[0-9a-f]{12}$/u);
export type Rly0AccountId = z.infer<typeof rly0AccountIdSchema>;

export const rly0AliasSchema = z.string().trim().min(1).max(40);

export const rly0CoreStatusParamsSchema = z.object({}).strict();
export type Rly0CoreStatusParams = z.infer<typeof rly0CoreStatusParamsSchema>;

export const rly0CoreStatusResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      name: z.string().max(200),
      version: z.string().max(64),
      capabilities: z.array(z.string().max(64)).max(32),
    })
    .strict(),
]);
export type Rly0CoreStatusResult = z.infer<typeof rly0CoreStatusResultSchema>;

export const RLY0_ACCOUNTS_USAGE_METHOD = "codexhost/rly0/accounts/usage";
export const RLY0_ACCOUNTS_USAGE_ALL_METHOD = "codexhost/rly0/accounts/usageAll";
export const RLY0_PROXY_SETTINGS_GET_METHOD = "codexhost/rly0/settings/proxy/get";
export const RLY0_PROXY_SETTINGS_SET_METHOD = "codexhost/rly0/settings/proxy/set";

/** One rate-limit window reported by `accounts/usage`. Times are unix seconds. */
export const rly0UsageWindowSchema = z
  .object({
    kind: z.enum(["primary", "secondary"]),
    usedPercent: z.number().finite().min(0).max(100),
    windowSeconds: z.number().int().nonnegative().max(10_000_000_000).optional(),
    resetsAt: z.number().int().nonnegative().max(100_000_000_000).optional(),
  })
  .strict();
export type Rly0UsageWindow = z.infer<typeof rly0UsageWindowSchema>;

export const rly0AccountUsageSchema = z
  .object({
    windows: z.array(rly0UsageWindowSchema).max(8),
    plan: z.string().max(64).optional(),
    /** Rate-limit reset cards OpenAI gave the account (wham/usage rate_limit_reset_credits). */
    resetCredits: z.number().int().nonnegative().max(1000).optional(),
    fetchedAt: z.number().int().nonnegative().max(100_000_000_000),
    source: z.enum(["live", "snapshot"]),
  })
  .strict();
export type Rly0AccountUsage = z.infer<typeof rly0AccountUsageSchema>;

/** Error codes rly0-core reports for usage lookups; anything else maps to a generic message. */
export const RLY0_USAGE_ERROR_CODES = [
  "USAGE_TOKEN_EXPIRED",
  "USAGE_BLOCKED",
  "USAGE_NETWORK",
  "USAGE_BAD_RESPONSE",
  "ACCOUNT_TOKEN_MISSING",
] as const;
export const rly0UsageErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);

export const rly0AccountSchema = z
  .object({
    id: rly0AccountIdSchema,
    alias: z.string().max(40).optional(),
    email: z.string().max(320).optional(),
    plan: z.string().max(64).optional(),
    accountId: z.string().max(256).optional(),
    addedAt: z.string().max(64).optional(),
    updatedAt: z.string().max(64).optional(),
    current: z.boolean(),
    lastUsage: rly0AccountUsageSchema.optional(),
  })
  .strict();
export type Rly0Account = z.infer<typeof rly0AccountSchema>;

export const rly0AccountsListParamsSchema = z.object({}).strict();
export type Rly0AccountsListParams = z.infer<typeof rly0AccountsListParamsSchema>;

export const rly0AccountsListResultSchema = z.discriminatedUnion("available", [
  z
    .object({ available: z.literal(false), accounts: z.array(rly0AccountSchema).length(0) })
    .strict(),
  z
    .object({
      available: z.literal(true),
      accounts: z.array(rly0AccountSchema).max(64),
      liveLoggedIn: z.boolean().optional(),
      liveUnsaved: z.boolean().optional(),
    })
    .strict(),
]);
export type Rly0AccountsListResult = z.infer<typeof rly0AccountsListResultSchema>;

export const rly0AccountsImportCurrentParamsSchema = z
  .object({ alias: rly0AliasSchema.optional() })
  .strict();
export type Rly0AccountsImportCurrentParams = z.infer<typeof rly0AccountsImportCurrentParamsSchema>;

export const rly0AccountsImportCurrentResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z.object({ available: z.literal(true), id: rly0AccountIdSchema }).strict(),
]);
export type Rly0AccountsImportCurrentResult = z.infer<typeof rly0AccountsImportCurrentResultSchema>;

/**
 * "Add account": the Host runs the official ChatGPT browser login in a throw-away CODEX_HOME and
 * hands the result to rly0-core. The live Codex login is never changed. The renderer polls
 * `status` until the state leaves `pending`.
 */
export const RLY0_ACCOUNTS_ADD_LOGIN_START_METHOD = "codexhost/rly0/accounts/addLogin/start";
export const RLY0_ACCOUNTS_ADD_LOGIN_STATUS_METHOD = "codexhost/rly0/accounts/addLogin/status";
export const RLY0_ACCOUNTS_ADD_LOGIN_CANCEL_METHOD = "codexhost/rly0/accounts/addLogin/cancel";

const rly0AddLoginIdSchema = z.string().regex(/^[0-9a-f]{16}$/u);

export const rly0AccountsAddLoginStartParamsSchema = z
  .object({ alias: rly0AliasSchema.optional() })
  .strict();
export type Rly0AccountsAddLoginStartParams = z.infer<typeof rly0AccountsAddLoginStartParamsSchema>;

export const rly0AccountsAddLoginStartResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      loginId: rly0AddLoginIdSchema,
      authUrl: z.string().url().max(4096),
    })
    .strict(),
]);
export type Rly0AccountsAddLoginStartResult = z.infer<typeof rly0AccountsAddLoginStartResultSchema>;

export const rly0AccountsAddLoginStatusParamsSchema = z
  .object({ loginId: rly0AddLoginIdSchema })
  .strict();
export type Rly0AccountsAddLoginStatusParams = z.infer<
  typeof rly0AccountsAddLoginStatusParamsSchema
>;

export const rly0AccountsAddLoginStatusResultSchema = z.discriminatedUnion("state", [
  z.object({ available: z.literal(true), state: z.literal("pending") }).strict(),
  z
    .object({ available: z.literal(true), state: z.literal("completed"), id: rly0AccountIdSchema })
    .strict(),
  z
    .object({
      available: z.literal(true),
      state: z.literal("failed"),
      error: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u),
    })
    .strict(),
  z.object({ available: z.literal(true), state: z.literal("cancelled") }).strict(),
]);
export type Rly0AccountsAddLoginStatusResult = z.infer<
  typeof rly0AccountsAddLoginStatusResultSchema
>;

export const rly0AccountsAddLoginCancelParamsSchema = rly0AccountsAddLoginStatusParamsSchema;
export type Rly0AccountsAddLoginCancelParams = Rly0AccountsAddLoginStatusParams;
export const rly0AccountsAddLoginCancelResultSchema = z
  .object({ available: z.literal(true), cancelled: z.boolean() })
  .strict();
export type Rly0AccountsAddLoginCancelResult = z.infer<
  typeof rly0AccountsAddLoginCancelResultSchema
>;

export const rly0AccountsSwitchParamsSchema = z.object({ id: rly0AccountIdSchema }).strict();
export type Rly0AccountsSwitchParams = z.infer<typeof rly0AccountsSwitchParamsSchema>;

export const rly0AccountsSwitchResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), switched: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      switched: z.boolean(),
      requiresRestart: z.boolean().optional(),
      alias: z.string().max(40).optional(),
      alreadyCurrent: z.boolean().optional(),
      /** Set by the Host after a real switch: whether the official backend hot-reloaded. */
      backendReload: z.enum(["reloaded", "deferred", "failed"]).optional(),
    })
    .strict(),
]);
export type Rly0AccountsSwitchResult = z.infer<typeof rly0AccountsSwitchResultSchema>;

export const rly0AccountsRenameParamsSchema = z
  .object({ id: rly0AccountIdSchema, alias: rly0AliasSchema })
  .strict();
export type Rly0AccountsRenameParams = z.infer<typeof rly0AccountsRenameParamsSchema>;

export const rly0AccountsRenameResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), ok: z.literal(false) }).strict(),
  z.object({ available: z.literal(true), ok: z.boolean() }).strict(),
]);
export type Rly0AccountsRenameResult = z.infer<typeof rly0AccountsRenameResultSchema>;

export const rly0AccountsRemoveParamsSchema = z.object({ id: rly0AccountIdSchema }).strict();
export type Rly0AccountsRemoveParams = z.infer<typeof rly0AccountsRemoveParamsSchema>;

export const rly0AccountsRemoveResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), ok: z.literal(false) }).strict(),
  z.object({ available: z.literal(true), ok: z.boolean() }).strict(),
]);
export type Rly0AccountsRemoveResult = z.infer<typeof rly0AccountsRemoveResultSchema>;

export const rly0AccountsUsageParamsSchema = z.object({ id: rly0AccountIdSchema }).strict();
export type Rly0AccountsUsageParams = z.infer<typeof rly0AccountsUsageParamsSchema>;

export const rly0AccountsUsageResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z.object({ available: z.literal(true), usage: rly0AccountUsageSchema }).strict(),
]);
export type Rly0AccountsUsageResult = z.infer<typeof rly0AccountsUsageResultSchema>;

export const rly0AccountsUsageAllParamsSchema = z.object({}).strict();
export type Rly0AccountsUsageAllParams = z.infer<typeof rly0AccountsUsageAllParamsSchema>;

export const rly0AccountUsageEntrySchema = z.union([
  z.object({ id: rly0AccountIdSchema, usage: rly0AccountUsageSchema }).strict(),
  z.object({ id: rly0AccountIdSchema, error: rly0UsageErrorCodeSchema }).strict(),
]);
export type Rly0AccountUsageEntry = z.infer<typeof rly0AccountUsageEntrySchema>;

export const rly0AccountsUsageAllResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({ available: z.literal(true), results: z.array(rly0AccountUsageEntrySchema).max(64) })
    .strict(),
]);
export type Rly0AccountsUsageAllResult = z.infer<typeof rly0AccountsUsageAllResultSchema>;

/**
 * Outbound proxy used by the rly0-core child process. `system` keeps the inherited
 * HTTPS_PROXY/HTTP_PROXY variables, `direct` strips them, `custom` sets both to `url`.
 */
export const rly0ProxyModeSchema = z.enum(["direct", "system", "custom"]);
export type Rly0ProxyMode = z.infer<typeof rly0ProxyModeSchema>;

export const rly0ProxyUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^https?:\/\/[^\s]+$/iu);

export const rly0ProxySettingsSchema = z
  .object({ mode: rly0ProxyModeSchema, url: rly0ProxyUrlSchema.optional() })
  .strict()
  .refine((value) => value.mode !== "custom" || value.url !== undefined, {
    message: "custom proxy requires url",
    path: ["url"],
  });
export type Rly0ProxySettings = z.infer<typeof rly0ProxySettingsSchema>;

export const rly0ProxySettingsGetParamsSchema = z.object({}).strict();
export type Rly0ProxySettingsGetParams = z.infer<typeof rly0ProxySettingsGetParamsSchema>;
export const rly0ProxySettingsGetResultSchema = z
  .object({ settings: rly0ProxySettingsSchema })
  .strict();
export type Rly0ProxySettingsGetResult = z.infer<typeof rly0ProxySettingsGetResultSchema>;

export const rly0ProxySettingsSetParamsSchema = z
  .object({ settings: rly0ProxySettingsSchema })
  .strict();
export type Rly0ProxySettingsSetParams = z.infer<typeof rly0ProxySettingsSetParamsSchema>;
export const rly0ProxySettingsSetResultSchema = z
  .object({ settings: rly0ProxySettingsSchema, coreRestarted: z.boolean() })
  .strict();
export type Rly0ProxySettingsSetResult = z.infer<typeof rly0ProxySettingsSetResultSchema>;
