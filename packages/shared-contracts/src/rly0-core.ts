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
export const rly0AccountIdSchema = z
  .string()
  .regex(/^[0-9a-f]{12}$/u);
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
  })
  .strict();
export type Rly0Account = z.infer<typeof rly0AccountSchema>;

export const rly0AccountsListParamsSchema = z.object({}).strict();
export type Rly0AccountsListParams = z.infer<typeof rly0AccountsListParamsSchema>;

export const rly0AccountsListResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), accounts: z.array(rly0AccountSchema).length(0) }).strict(),
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
export type Rly0AccountsImportCurrentResult = z.infer<
  typeof rly0AccountsImportCurrentResultSchema
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
