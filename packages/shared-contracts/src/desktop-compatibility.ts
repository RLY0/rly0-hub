import { z } from "zod";

/** Local interface readiness, separate from account, quota and model availability. */
export const desktopCompatibilitySchema = z
  .object({
    checkedAt: z.string().max(64),
    state: z.enum([
      "not-running",
      "checking",
      "ready",
      "incompatible",
      "unverified",
      "unavailable",
    ]),
    desktopVersion: z.string().max(96).nullable(),
    previousCompatibleVersion: z.string().max(96).nullable(),
    versionChanged: z.boolean(),
    issue: z.enum([
      "NONE",
      "STATUS_UNAVAILABLE",
      "UNMANAGED_RUNTIME",
      "SESSION_MISMATCH",
      "CONTROLLER_STATUS_MISSING",
      "INTEGRATION_PENDING",
      "REQUEST_MANAGER_UNAVAILABLE",
      "CDP_UNAVAILABLE",
      "INTEGRATION_UNAVAILABLE",
    ]),
    message: z.string().max(500),
    checks: z
      .object({
        managedRuntime: z.boolean().nullable(),
        controllerAlive: z.boolean().nullable(),
        interfaceConnected: z.boolean().nullable(),
      })
      .strict(),
  })
  .strict();

export type DesktopCompatibility = z.infer<typeof desktopCompatibilitySchema>;
