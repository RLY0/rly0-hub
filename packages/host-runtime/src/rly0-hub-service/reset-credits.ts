import { z } from "zod";

/** Explicit redemption commands; a displayed snapshot is never a consumption command. */
export const resetPrepareParams = z.object({ id: z.string().regex(/^[0-9a-f]{12}$/u) }).strict();
export const resetAcknowledgeParams = resetPrepareParams.extend({ requestId: z.uuid() }).strict();
export const resetConsumeParams = resetPrepareParams
  .extend({
    requestId: z.uuid(),
    creditId: z.string().min(1).max(256),
    revision: z.string().regex(/^[0-9a-f]{64}$/u),
    confirmed: z.literal(true),
  })
  .strict();
export const resetPrepareResult = z.object({
  availableCount: z.number().int().min(0).max(1000).nullable(),
  pendingRequestId: z.uuid().nullable(),
  revision: z.string().regex(/^[0-9a-f]{64}$/u),
  creditId: z.string().min(1).max(256).nullable(),
  expiresAt: z.string().max(64).nullable(),
});
export const resetConsumeResult = z.object({
  outcome: z.enum(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"]),
});
