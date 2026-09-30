import { z } from "zod";

/**
 * Contracts for the appearance page's autostart-with-Windows toggle. Theme, accent color, quota
 * refresh interval and the low-quota alert threshold are renderer-local preferences (stored the
 * same way as the existing reasoning-soft-wrap toggle) and do not need a Host round trip; only
 * autostart touches the OS (the Windows registry) and therefore needs a Host RPC.
 */

export const RLY0_APPEARANCE_AUTOSTART_GET_METHOD = "codexhost/rly0/appearance/autostart/get";
export const RLY0_APPEARANCE_AUTOSTART_SET_METHOD = "codexhost/rly0/appearance/autostart/set";

export const rly0AppearanceAutostartGetParamsSchema = z.object({}).strict();
export type Rly0AppearanceAutostartGetParams = z.infer<
  typeof rly0AppearanceAutostartGetParamsSchema
>;

/** `supported` is false on any non-Windows platform. */
export const rly0AppearanceAutostartResultSchema = z
  .object({
    supported: z.boolean(),
    enabled: z.boolean(),
  })
  .strict();
export type Rly0AppearanceAutostartResult = z.infer<typeof rly0AppearanceAutostartResultSchema>;

export const rly0AppearanceAutostartSetParamsSchema = z.object({ enabled: z.boolean() }).strict();
export type Rly0AppearanceAutostartSetParams = z.infer<
  typeof rly0AppearanceAutostartSetParamsSchema
>;
