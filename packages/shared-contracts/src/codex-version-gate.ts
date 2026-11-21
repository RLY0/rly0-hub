import { z } from "zod";
import {
  codexDesktopPlatform,
  desktopVersionFamily,
  isVerifiedDesktopVersion,
  sameDesktopVersion,
} from "./desktop-compatibility.js";

export const CODEX_RENDERER_FEATURES = [
  "usage",
  "composer",
  "sidebar-icons",
  "settings",
  "schedules",
  "delegation",
  "questions",
  "reasoning-wrap",
  "draft-prewarm",
  "native-rpc",
  "rpc-steering",
] as const;
export type CodexRendererFeature = (typeof CODEX_RENDERER_FEATURES)[number];
const family = z.string().regex(/^\d+\.\d+$/u);
const exactVersion = z.string().regex(/^\d+\.\d+\.\d+(?:\.\d+)?$/u);
/** Free-form so a future platform name never invalidates the whole document; unknown never matches. */
const platformName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);
export const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const hubVersion = z.string().regex(SEMVER_PATTERN);
function safeCompare(
  compare: (a: string, b: string) => number,
  a: string,
  b: string,
): number | null {
  try {
    return compare(a, b);
  } catch {
    return null;
  }
}
/** Unknown keys and future feature ids are accepted; invalid known fields reject the document. */
export const codexCompatManifestSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.iso.datetime({ offset: true }),
  /**
   * Legacy family entries. Still parsed so older documents and older Hubs keep working, but no
   * longer trusted: a family-only document verifies nothing here (safe side, core mode).
   */
  verified: z.array(z.object({ family, minHub: hubVersion })).max(1000),
  /** Exact Desktop builds the Hub is verified on; `platform` absent means every platform. */
  verifiedVersions: z
    .array(
      z.object({ version: exactVersion, platform: platformName.optional(), minHub: hubVersion }),
    )
    .max(1000)
    .optional(),
  disabled: z
    .array(
      z.object({
        feature: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
        codexFamilies: z.array(family).max(1000).optional(),
        /** Exact builds; with codexFamilies both must match when both are given. */
        codexVersions: z.array(exactVersion).max(1000).optional(),
        hubBelow: hubVersion.optional(),
        reason: z.string().min(1).max(500),
      }),
    )
    .max(1000),
});
export type CodexCompatManifest = z.infer<typeof codexCompatManifestSchema>;
export interface CodexRendererPolicy {
  schemaVersion: 1;
  mode: "full" | "core" | "safe";
  disabled: CodexRendererFeature[];
  /**
   * Hub manages Codex updates and no release is in progress: the renderer forces Sparkle background
   * downloads off. Delivered beside `policy` in codex-renderer-policy.json; absent means pass through.
   */
  holdUpdates?: boolean | undefined;
}
/** Numeric Desktop versions (not semver); Sparkle short versions have four components. */
export function compareCodexVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  if (!/^\d+(?:\.\d+)+$/u.test(a) || !/^\d+(?:\.\d+)+$/u.test(b))
    throw new Error("CODEX_VERSION_INVALID");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
/**
 * Exact-version gate: the built-in list of this platform, or a remote `verifiedVersions` entry for
 * this exact build and platform whose minHub this Hub meets. Families never verify a build.
 */
export function codexVersionVerified(
  version: string | null,
  hub: string,
  manifest: CodexCompatManifest | null,
  compareHub: (a: string, b: string) => number,
  platform: string,
): boolean {
  if (!version) return false;
  const name = codexDesktopPlatform(platform);
  return (
    isVerifiedDesktopVersion(version, platform) ||
    !!manifest?.verifiedVersions?.some(
      (entry) =>
        (entry.platform === undefined || entry.platform === name) &&
        sameDesktopVersion(entry.version, version) &&
        (safeCompare(compareHub, hub, entry.minHub) ?? -1) >= 0,
    )
  );
}
export function codexRendererPolicy(
  version: string | null,
  hub: string,
  manifest: CodexCompatManifest | null,
  compareHub: (a: string, b: string) => number,
  platform: string,
): CodexRendererPolicy {
  const disabled = CODEX_RENDERER_FEATURES.filter((feature) =>
    manifest?.disabled.some(
      (entry) =>
        entry.feature === feature &&
        (!entry.codexFamilies ||
          (version !== null &&
            entry.codexFamilies.includes(desktopVersionFamily(version) ?? ""))) &&
        (!entry.codexVersions ||
          (version !== null &&
            entry.codexVersions.some((listed) => sameDesktopVersion(listed, version)))) &&
        (!entry.hubBelow || (safeCompare(compareHub, hub, entry.hubBelow) ?? -1) < 0),
    ),
  );
  const full = codexVersionVerified(version, hub, manifest, compareHub, platform);
  // The composer and its routing policy are one dependency group. Removing either removes the group.
  const core = !full || disabled.includes("composer") || disabled.includes("draft-prewarm");
  return {
    schemaVersion: 1,
    mode: core ? (disabled.includes("usage") ? "safe" : "core") : "full",
    disabled: [...disabled],
  };
}
export const codexRendererPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["full", "core", "safe"]),
    disabled: z.array(z.enum(CODEX_RENDERER_FEATURES)),
    holdUpdates: z.boolean().optional(),
  })
  .strict();
export const codexUpdateSettingsSchema = z.object({
  defaulted: z.boolean().catch(true),
  enabled: z.boolean().catch(false),
  noticeAcknowledged: z.boolean().optional().catch(undefined),
  originalAutoUpdate: z.boolean().nullable().optional().catch(undefined),
  originalCheckPreferences: z
    .object({
      automaticChecks: z.boolean().nullable(),
      lastCheckTime: z.string().max(100).nullable(),
    })
    .optional()
    .catch(undefined),
});
export type CodexUpdateSettings = z.infer<typeof codexUpdateSettingsSchema>;
