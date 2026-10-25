import { z } from "zod";

import { idleReleaseSettingsSchema } from "./idle-release.js";

/**
 * Codex-side preferences set in the RLY/0 Hub window (设置 → 通用 → Codex 里的显示). The Hub
 * service writes them to `codex-preferences.json` in the RLY/0 data folder; the renderer reads
 * them through the Host and applies them to its own local preferences. Absent fields leave the
 * renderer's current value alone.
 */
export const RLY0_CODEX_PREFERENCES_GET_METHOD = "codexhost/rly0/codexPreferences/get";
export const RLY0_CODEX_PREFERENCES_FILE = "codex-preferences.json";

export const RLY0_CODEX_ACCENT_COLORS = [
  "signal",
  "blue",
  "purple",
  "green",
  "orange",
  "rose",
] as const;
export const RLY0_CODEX_QUOTA_REFRESH = ["30s", "1m", "3m", "5m"] as const;

export const rly0CodexPreferenceValuesSchema = z
  .object({
    /** Wrap long reasoning lines in Codex transcripts. */
    reasoningSoftWrap: z.boolean().optional(),
    /** Accent of RLY/0 controls inside Codex (agent chips, model picker marks). */
    accentColor: z.enum(RLY0_CODEX_ACCENT_COLORS).optional(),
    /** How often Codex refreshes account quota in its composer. */
    quotaRefresh: z.enum(RLY0_CODEX_QUOTA_REFRESH).optional(),
    /** Codex's own low-quota notice. */
    quotaAlert: z
      .object({ enabled: z.boolean(), thresholdPercent: z.number().int().min(1).max(90) })
      .strict()
      .optional(),
    /** Release idle external agent processes. */
    idleRelease: idleReleaseSettingsSchema.optional(),
  })
  .strict();
export type Rly0CodexPreferenceValues = z.infer<typeof rly0CodexPreferenceValuesSchema>;

export const rly0CodexPreferencesSchema = rly0CodexPreferenceValuesSchema
  .extend({ updatedAt: z.number().int().nonnegative() })
  .strict();
export type Rly0CodexPreferences = z.infer<typeof rly0CodexPreferencesSchema>;

export const rly0CodexPreferencesGetParamsSchema = z.object({}).strict();
export const rly0CodexPreferencesGetResultSchema = z
  .object({ preferences: rly0CodexPreferencesSchema.nullable() })
  .strict();
export type Rly0CodexPreferencesGetResult = z.infer<typeof rly0CodexPreferencesGetResultSchema>;
