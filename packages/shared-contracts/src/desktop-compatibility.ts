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
      /** Opened without the interface integration because this Desktop version is unverified. */
      "safe-mode",
      "core-mode",
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
      "UNVERIFIED_VERSION",
    ]),
    message: z.string().max(500),
    /** The Controller's own error text when the interface did not connect; sanitized on export. */
    rendererError: z.string().max(500).nullable().optional(),
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

/**
 * Desktop version families (`major.minor`, e.g. `26.1103` for `26.1103.5130.0`) this Hub build
 * has been verified against. A fresh install with no proven version yet opens these in full
 * mode; any other version opens in safe mode until the interface integration is proven.
 */
export const RLY0_VERIFIED_DESKTOP_VERSION_FAMILIES: readonly string[] = ["26.1029", "26.1103"];

export function desktopVersionFamily(version: string): string | null {
  const match = /^(\d+)\.(\d+)(?:[.+-]|$)/u.exec(version);
  return match ? `${match[1]}.${match[2]}` : null;
}

export function isVerifiedDesktopVersionFamily(version: string): boolean {
  const family = desktopVersionFamily(version);
  return family !== null && RLY0_VERIFIED_DESKTOP_VERSION_FAMILIES.includes(family);
}
