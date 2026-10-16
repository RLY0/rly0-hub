import type { RendererModelClient } from "./renderer-model-client.js";

/**
 * Every RLY/0 method of `RendererModelClient`. The adapter's frozen `modelControl` facade only
 * exposes what it lists explicitly, so each RLY/0 capability must be forwarded from here or the
 * settings pages see it as missing and report the core as unavailable.
 */
export const RENDERER_RLY0_FORWARDED_METHODS = [
  "rly0CoreStatus",
  "listRly0Accounts",
  "importCurrentRly0Account",
  "switchRly0Account",
  "renameRly0Account",
  "removeRly0Account",
  "startRly0AddAccountLogin",
  "rly0AddAccountLoginStatus",
  "cancelRly0AddAccountLogin",
  "rly0AccountUsage",
  "rly0AccountUsageAll",
  "listRly0Mcp",
  "setRly0McpEnabled",
  "removeRly0Mcp",
  "addRly0Mcp",
  "listRly0Skills",
  "deactivateRly0Skill",
  "restoreRly0Skill",
  "importRly0Skill",
  "listRly0Threads",
  "listRly0ThreadsTrash",
  "trashRly0Threads",
  "restoreRly0Threads",
  "rly0DashboardHealth",
  "rly0DashboardThreadStats",
  "rly0MaintenanceDiagnostics",
  "rly0MaintenanceExportDiagnostics",
  "rly0MaintenanceCacheInfo",
  "rly0MaintenanceClearCache",
  "rly0MaintenanceForceQuitCodex",
  "rly0MaintenanceRestartCodex",
  "rly0MaintenanceBackupStatus",
  "rly0MaintenanceRestoreBackup",
  "rly0AppearanceAutostartStatus",
  "rly0OpenHub",
  "rly0AppearanceAutostartSet",
  "rly0ProxySettingsGet",
  "rly0ProxySettingsSet",
  "listRly0Relays",
  "addRly0Relay",
  "updateRly0Relay",
  "removeRly0Relay",
  "setRly0RelayEnabled",
  "testRly0Relay",
  "rly0ProxyStart",
  "rly0ProxyStop",
  "rly0ProxyStatus",
  "rly0RelayCodexConfigStatus",
  "rly0RelayCodexConfigApply",
  "rly0RelayCodexConfigRestore",
  "rly0RelayModelCatalogStatus",
  "rly0RelayAgentsGet",
  "rly0RelayAgentsSet",
  "rly0ClaudeCodeAuthStatus",
  "rly0AgentInstallStart",
  "rly0AgentInstallStatus",
  "rly0AgentOpenLogin",
  "rly0ClaudeCodeLogin",
  "rly0ClaudeCodeLogout",
] as const;

export type RendererRly0ForwardedMethod = (typeof RENDERER_RLY0_FORWARDED_METHODS)[number];

/** Builds late-bound forwarders that resolve the current Host's model client on every call. */
export function createRendererRly0Forwarders(
  currentClient: () => RendererModelClient,
): Record<RendererRly0ForwardedMethod, (...args: never[]) => Promise<unknown>> {
  const forwarders: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of RENDERER_RLY0_FORWARDED_METHODS) {
    forwarders[name] = (...args: unknown[]) => {
      const client = currentClient() as unknown as Record<string, unknown>;
      const method = client[name];
      if (typeof method !== "function") throw new Error(`${name} is unavailable`);
      return (method as (...input: unknown[]) => unknown).apply(client, args);
    };
  }
  return forwarders as Record<RendererRly0ForwardedMethod, (...args: never[]) => Promise<unknown>>;
}
