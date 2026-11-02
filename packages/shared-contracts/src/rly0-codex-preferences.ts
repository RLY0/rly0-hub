import { z } from "zod";

import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "./harness-models.js";
import { harnessPermissionModeIdSchema } from "./harness-permission-modes.js";
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

/**
 * What a new Thread of one external Agent starts with (设置 → AI 助手 → 新对话默认设置). Values are
 * that Agent's own catalog ids; an id the current catalog no longer lists is ignored by the
 * renderer, which then keeps its remembered choice or the Agent's own default.
 */
export const rly0AgentNewThreadDefaultsSchema = z
  .object({
    permissionModeId: harnessPermissionModeIdSchema.optional(),
    model: harnessModelRefSchema.optional(),
    thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
  })
  .strict();
export type Rly0AgentNewThreadDefaults = z.infer<typeof rly0AgentNewThreadDefaultsSchema>;

export const RLY0_AGENT_DEFAULTS_MAX_AGENTS = 32;
export const rly0AgentDefaultsSchema = z
  .record(
    z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)
      .max(128),
    rly0AgentNewThreadDefaultsSchema,
  )
  .refine((value) => Object.keys(value).length <= RLY0_AGENT_DEFAULTS_MAX_AGENTS, {
    message: "Too many Agents",
  });
export type Rly0AgentDefaults = z.infer<typeof rly0AgentDefaultsSchema>;

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
    /** New-Thread defaults per external Agent; saved whole, so a cleared Agent disappears. */
    agentDefaults: rly0AgentDefaultsSchema.optional(),
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
