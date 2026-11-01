import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_PERMISSION_MODE_PREFERENCE_KEY,
  readClaudePermissionModePreference,
  writeClaudePermissionModePreference,
  type PermissionModePreferenceStorage,
} from "../src/index.js";
import { claudeNewThreadPermissionMode } from "../src/renderer-permission-mode-preference.js";

const catalog = harnessPermissionModeCatalogSchema.parse({
  defaultModeId: "default",
  modes: [
    { id: "default", label: "Default" },
    { id: "plan", label: "Plan" },
  ],
});

function memoryStorage(): PermissionModePreferenceStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("Claude Permission Mode preference", () => {
  it("persists the last selected catalog mode for a new Session", () => {
    const storage = memoryStorage();
    const plan = harnessPermissionModeIdSchema.parse("plan");

    writeClaudePermissionModePreference(plan, storage);

    expect(storage.values.get(CLAUDE_PERMISSION_MODE_PREFERENCE_KEY)).toBe("plan");
    expect(readClaudePermissionModePreference(catalog, storage)).toBe(plan);
  });

  it("ignores a stored mode that is absent from the current catalog", () => {
    const storage = memoryStorage();
    storage.values.set(CLAUDE_PERMISSION_MODE_PREFERENCE_KEY, "removed-mode");

    expect(readClaudePermissionModePreference(catalog, storage)).toBeUndefined();
  });
});

describe("New Claude Code Thread permission mode", () => {
  const bypassCatalog = harnessPermissionModeCatalogSchema.parse({
    defaultModeId: "default",
    modes: [
      { id: "default", label: "Default" },
      { id: "bypassPermissions", label: "Bypass permissions", dangerous: true },
    ],
  });

  it("forces bypassed permissions for a new local Claude Code Thread", () => {
    expect(claudeNewThreadPermissionMode("claude-code", "local", bypassCatalog)).toBe(
      "bypassPermissions",
    );
  });

  it("leaves other Agents, remote Hosts and catalogs without bypass to the usual chain", () => {
    expect(claudeNewThreadPermissionMode("grok", "local", bypassCatalog)).toBeUndefined();
    expect(claudeNewThreadPermissionMode("claude-code", "remote", bypassCatalog)).toBeUndefined();
    expect(claudeNewThreadPermissionMode("claude-code", null, bypassCatalog)).toBeUndefined();
    expect(claudeNewThreadPermissionMode("claude-code", "local", catalog)).toBeUndefined();
    expect(claudeNewThreadPermissionMode("claude-code", "local", undefined)).toBeUndefined();
  });
});
