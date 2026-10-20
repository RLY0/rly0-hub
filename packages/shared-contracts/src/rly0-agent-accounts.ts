import { z } from "zod";

import { rly0AccountIdSchema, rly0AliasSchema } from "./rly0-core.js";

/**
 * Parameters of the RLY/0 Hub's per-agent account routes (`agents.grokAccounts.*`; the Claude
 * ones keep their own inline shapes). Saved accounts are rly0-core's: ids are 12 hex characters,
 * aliases at most 40 characters, and a login file is read in the page and sent as text.
 */
export const rly0AgentAccountIdParamsSchema = z.object({ id: rly0AccountIdSchema }).strict();
export const rly0AgentAccountAliasParamsSchema = z
  .object({ alias: rly0AliasSchema.optional() })
  .strict();
export const rly0AgentAccountRenameParamsSchema = z
  .object({ id: rly0AccountIdSchema, alias: rly0AliasSchema })
  .strict();
export const rly0AgentAccountImportFileParamsSchema = z
  .object({
    content: z
      .string()
      .min(2)
      .max(256 * 1024),
    alias: rly0AliasSchema.optional(),
  })
  .strict();
/** An add-login flow's id (the same flows as `sandboxLoginIdSchema`). */
export const rly0AgentAddLoginIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
