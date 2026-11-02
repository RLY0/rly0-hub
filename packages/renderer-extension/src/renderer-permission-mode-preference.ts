import {
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export const CLAUDE_PERMISSION_MODE_PREFERENCE_KEY = "codexhost.claude-code.permission-mode.v1";

// RLY/0 (user decision 2026-11-01): a new local Claude Code Thread starts with permission checks
// bypassed, overriding remembered choices, until the person sets a default permission in the Hub
// (renderer-agent-defaults.ts, which calls this only when no Hub default is set). Undefined when
// the catalog omits bypass (e.g. root without IS_SANDBOX), so the usual preference chain and
// Harness default still apply.
export const CLAUDE_NEW_THREAD_PERMISSION_MODE_ID = "bypassPermissions";

export function claudeNewThreadPermissionMode(
  agent: string,
  hostId: string | null,
  catalog: HarnessPermissionModeCatalog | undefined,
): HarnessPermissionModeId | undefined {
  if (agent !== "claude-code" || hostId !== "local" || !catalog) return undefined;
  return catalog.modes.find(({ id }) => id === CLAUDE_NEW_THREAD_PERMISSION_MODE_ID)?.id;
}

export interface PermissionModePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function rendererStorage(): PermissionModePreferenceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readClaudePermissionModePreference(
  catalog: HarnessPermissionModeCatalog,
  storage: PermissionModePreferenceStorage | null = rendererStorage(),
): HarnessPermissionModeId | undefined {
  if (!storage) return undefined;
  try {
    const parsed = harnessPermissionModeIdSchema.safeParse(
      storage.getItem(CLAUDE_PERMISSION_MODE_PREFERENCE_KEY),
    );
    return parsed.success && catalog.modes.some(({ id }) => id === parsed.data)
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeClaudePermissionModePreference(
  permissionModeId: HarnessPermissionModeId,
  storage: PermissionModePreferenceStorage | null = rendererStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(CLAUDE_PERMISSION_MODE_PREFERENCE_KEY, permissionModeId);
  } catch {
    // Preference persistence must not prevent native mode selection.
  }
}
