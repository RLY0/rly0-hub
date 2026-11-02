import type { Rly0CodexPreferences } from "@codexhost/shared-contracts";

import {
  applyRendererAccentColor,
  setRendererAccentColor,
  setRendererQuotaAlertEnabled,
  setRendererQuotaAlertThresholdPercent,
  setRendererQuotaRefreshFrequency,
} from "./renderer-appearance-preferences.js";
import { writeIdleReleasePreference } from "./renderer-idle-release-preference.js";
import { setReasoningTranscriptSoftWrap } from "./renderer-transcript-dom.js";

/** When the Hub's Codex preferences were last applied in this Codex profile. */
export const CODEX_PREFERENCES_APPLIED_STORAGE_KEY = "codexhost.rly0-codex-preferences-applied.v1";

/**
 * Applies preferences set in the Hub window (设置 → 通用 → Codex 里) to this renderer's local
 * settings, once per Hub change. Returns whether anything was applied.
 */
export function applyCodexPreferences(
  owner: Window,
  preferences: Rly0CodexPreferences | null,
): boolean {
  if (!preferences) return false;
  try {
    const applied = Number(owner.localStorage.getItem(CODEX_PREFERENCES_APPLIED_STORAGE_KEY) ?? 0);
    if (Number.isFinite(applied) && applied >= preferences.updatedAt) return false;
    if (preferences.reasoningSoftWrap !== undefined)
      setReasoningTranscriptSoftWrap(owner, preferences.reasoningSoftWrap);
    if (preferences.accentColor !== undefined) {
      setRendererAccentColor(owner, preferences.accentColor);
      applyRendererAccentColor(owner.document, preferences.accentColor);
    }
    if (preferences.quotaRefresh !== undefined)
      setRendererQuotaRefreshFrequency(owner, preferences.quotaRefresh);
    if (preferences.quotaAlert !== undefined) {
      setRendererQuotaAlertEnabled(owner, preferences.quotaAlert.enabled);
      setRendererQuotaAlertThresholdPercent(owner, preferences.quotaAlert.thresholdPercent);
    }
    if (preferences.idleRelease !== undefined)
      writeIdleReleasePreference(owner, preferences.idleRelease);
    owner.localStorage.setItem(
      CODEX_PREFERENCES_APPLIED_STORAGE_KEY,
      String(preferences.updatedAt),
    );
    return true;
  } catch {
    // Storage can be unavailable; the renderer keeps its current settings.
    return false;
  }
}
