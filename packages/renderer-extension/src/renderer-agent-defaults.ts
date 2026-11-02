import {
  catalogModelForRef,
  harnessPluginIdSchema,
  rly0AgentNewThreadDefaultsSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type Rly0AgentDefaults,
  type Rly0AgentNewThreadDefaults,
} from "@codexhost/shared-contracts";

import type { ExternalRendererAgent } from "./agent-selection-state.js";
import { thinkingOptionsForModel } from "./renderer-model-picker.js";
import { claudeNewThreadPermissionMode } from "./renderer-permission-mode-preference.js";

/**
 * New-Thread defaults set in the RLY/0 Hub window (AI 助手 → 新对话默认设置). The Hub saves them
 * with its Codex preferences; `applyCodexPreferences` copies them here, and every new local Thread
 * of that Agent starts with them. Started Threads keep their own configuration.
 */
export const RLY0_AGENT_DEFAULTS_STORAGE_KEY = "codexhost.rly0-agent-defaults.v1";

export interface AgentDefaultsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function rendererStorage(): AgentDefaultsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function writeHubAgentDefaults(
  storage: AgentDefaultsStorage | null,
  defaults: Rly0AgentDefaults,
): void {
  if (!storage) return;
  try {
    storage.setItem(RLY0_AGENT_DEFAULTS_STORAGE_KEY, JSON.stringify(defaults));
  } catch {
    // The renderer keeps its remembered choices when storage is unavailable.
  }
}

/** The Hub defaults for one Agent. Only local Threads use them: the Hub configures this computer. */
export function readHubAgentDefaults(
  agent: ExternalRendererAgent,
  hostId: string | null,
  storage: AgentDefaultsStorage | null = rendererStorage(),
): Rly0AgentNewThreadDefaults | undefined {
  if (hostId !== "local" || !storage || !harnessPluginIdSchema.safeParse(agent).success) {
    return undefined;
  }
  try {
    const raw = storage.getItem(RLY0_AGENT_DEFAULTS_STORAGE_KEY);
    if (!raw) return undefined;
    const all: unknown = JSON.parse(raw);
    if (typeof all !== "object" || all === null || Array.isArray(all)) return undefined;
    const parsed = rly0AgentNewThreadDefaultsSchema.safeParse(
      (all as Record<string, unknown>)[agent],
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface NewThreadModelConfiguration {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

/**
 * Lays the Hub's Model and Thinking defaults over the remembered new-Thread choice. Each value
 * the current catalog does not offer is skipped, so that field keeps the remembered choice, then
 * the Agent's own default. A remembered Thinking option the resulting Model lacks is dropped.
 */
export function withHubModelDefaults(
  catalog: HarnessModelCatalog,
  hub: Rly0AgentNewThreadDefaults | undefined,
  remembered: NewThreadModelConfiguration | undefined,
): NewThreadModelConfiguration | undefined {
  if (!hub) return remembered;
  const model = catalogModelForRef(catalog, hub.model)?.ref ?? remembered?.model;
  const target = model ?? catalog.defaultModel;
  const offered = (id: HarnessThinkingOptionId | undefined) =>
    id && target && thinkingOptionsForModel(catalog, target).some((option) => option.id === id)
      ? id
      : undefined;
  const thinkingOptionId = offered(hub.thinkingOptionId) ?? offered(remembered?.thinkingOptionId);
  const permissionModeId = remembered?.permissionModeId;
  if (!model && !thinkingOptionId && !permissionModeId) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(permissionModeId ? { permissionModeId } : {}),
  };
}

/**
 * The permission mode a new Thread starts with ahead of remembered choices: the Hub default when
 * the catalog lists it. Without a Hub default, a local Claude Code Thread keeps bypassing
 * permission checks (the RLY/0 default since 0.11.26). A Hub default the catalog no longer lists
 * returns undefined, so the remembered choice or the Agent's own default applies.
 */
export function newThreadPermissionModeDefault(
  agent: ExternalRendererAgent,
  hostId: string | null,
  catalog: HarnessPermissionModeCatalog | undefined,
  hub: Rly0AgentNewThreadDefaults | undefined,
): HarnessPermissionModeId | undefined {
  if (hub?.permissionModeId) {
    return catalog?.modes.find(({ id }) => id === hub.permissionModeId)?.id;
  }
  return claudeNewThreadPermissionMode(agent, hostId, catalog);
}
