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

/** Opens the standalone RLY/0 Hub window (bin/rly0-hub.exe) from inside Codex. */
export const RLY0_HUB_OPEN_METHOD = "codexhost/rly0/hub/open";
export const rly0HubOpenParamsSchema = z.object({}).strict();
export type Rly0HubOpenParams = z.infer<typeof rly0HubOpenParamsSchema>;
/** `available` is false when this build has no Hub window (source checkout, other platforms). */
export const rly0HubOpenResultSchema = z
  .object({ available: z.boolean(), ok: z.boolean() })
  .strict();
export type Rly0HubOpenResult = z.infer<typeof rly0HubOpenResultSchema>;

/** Detect the independent window without opening it. */
export const RLY0_HUB_STATUS_METHOD = "codexhost/rly0/hub/status";
export const rly0HubStatusResultSchema = z.object({ available: z.boolean() }).strict();
