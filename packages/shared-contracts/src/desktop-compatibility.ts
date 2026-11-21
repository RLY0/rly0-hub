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

/** Platform names used by the exact Desktop version lists (Node `process.platform` mapped). */
export type CodexDesktopPlatform = "macos" | "windows";
export function codexDesktopPlatform(platform: string): CodexDesktopPlatform | null {
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : null;
}

/**
 * Exact Codex Desktop versions this Hub build has been verified against, per platform. Only these
 * open in full mode without a remote list; anything else, including a newer build of a verified
 * family (26.1117.4957 after 26.1117.3838 on 2026-11-21), opens in core mode until it is verified.
 * Families are no longer trusted: one family can change the composer between builds.
 */
export const RLY0_VERIFIED_DESKTOP_VERSIONS: readonly {
  readonly version: string;
  readonly platform: CodexDesktopPlatform;
}[] = [
  { version: "26.1106.51428", platform: "macos" },
  // Adapted against this exact build's source in 0.11.44 (37-slot Agent binding, turn context).
  { version: "26.1117.31558", platform: "macos" },
  { version: "26.1117.3838", platform: "windows" },
  // Codex mode passed the Windows UI check; ChatGPT Work new chats get the Agent picker bridge.
  { version: "26.1117.4957", platform: "windows" },
];

export function desktopVersionFamily(version: string): string | null {
  const match = /^(\d+)\.(\d+)(?:[.+-]|$)/u.exec(version);
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * Numeric core of a Desktop version with trailing `.0` components dropped, so the Windows package
 * version `26.1117.3838.0` and the listed `26.1117.3838` are the same build. Null when not numeric.
 */
export function normalizeDesktopVersion(version: string): string | null {
  const match = /^(\d+(?:\.\d+)+)(?:[+-]|$)/u.exec(version.trim());
  if (!match?.[1]) return null;
  const parts = match[1].split(".").map((part) => String(Number(part)));
  while (parts.length > 3 && parts[parts.length - 1] === "0") parts.pop();
  return parts.join(".");
}

/** Same build: exact numeric match after normalization; never a family or prefix match. */
export function sameDesktopVersion(a: string, b: string): boolean {
  const left = normalizeDesktopVersion(a);
  return left !== null && left === normalizeDesktopVersion(b);
}

/** True only for an exact built-in version of this platform (unknown platform: never). */
export function isVerifiedDesktopVersion(version: string, platform: string): boolean {
  const name = codexDesktopPlatform(platform);
  return (
    name !== null &&
    RLY0_VERIFIED_DESKTOP_VERSIONS.some(
      (entry) => entry.platform === name && sameDesktopVersion(entry.version, version),
    )
  );
}
