import {
  HARNESS_LAUNCH_SETTINGS_GET_METHOD,
  HARNESS_LAUNCH_SETTINGS_SET_METHOD,
  harnessLaunchSettingsGetSchema,
  harnessLaunchSettingsSetSchema,
  harnessLaunchSettingsSchema,
  type HarnessLaunchSettings,
  type HarnessLaunchSettingsGet,
  type HarnessLaunchSettingsSet,
  IDLE_RELEASE_SETTINGS_METHOD,
  LOADED_SESSIONS_METHOD,
  loadedSessionsSchema,
  type LoadedSession,
  idleReleaseSettingsSchema,
  type IdleReleaseSettings,
  harnessAccountInspectParamsSchema,
  harnessAccountInspectResultSchema,
  harnessAccountSourceListResultSchema,
  type HarnessAccountInspectParams,
  type HarnessAccountInspectResult,
  type HarnessAccountSourceListResult,
  harnessAccountListParamsSchema,
  harnessAccountListResultSchema,
  type HarnessAccountListParams,
  type HarnessAccountListResult,
  codexAccountUsageParamsSchema,
  codexAccountUsageResultSchema,
  type CodexAccountUsageParams,
  type CodexAccountUsageResult,
  codexAccountChangedSchema,
  codexAccountListResultSchema,
  externalThreadForkParamsSchema,
  externalThreadForkResultSchema,
  harnessCommandCatalogSchema,
  harnessCommandsInspectParamsSchema,
  harnessConfigurationStateSchema,
  harnessInspectParamsSchema,
  harnessInspectionSchema,
  harnessPluginListResultSchema,
  type HarnessPluginListResult,
  harnessWebUiOpenParamsSchema,
  harnessWebUiOpenResultSchema,
  harnessModelSelectionStateSchema,
  hostThreadIdSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadCommandExecuteParamsSchema,
  threadCommandExecuteResultSchema,
  threadCommandsInspectParamsSchema,
  threadModelSelectParamsSchema,
  threadPermissionModeSelectParamsSchema,
  threadThinkingSelectParamsSchema,
  threadOwnershipListParamsSchema,
  threadOwnershipListResultSchema,
  threadUsageInspectionParamsSchema,
  threadUsageInspectionSchema,
  updateCheckResultSchema,
  updateEmptyParamsSchema,
  updateStartResultSchema,
  updateStatusResultSchema,
  RLY0_CORE_STATUS_METHOD,
  RLY0_ACCOUNTS_LIST_METHOD,
  RLY0_ACCOUNTS_IMPORT_CURRENT_METHOD,
  RLY0_ACCOUNTS_SWITCH_METHOD,
  RLY0_ACCOUNTS_RENAME_METHOD,
  RLY0_ACCOUNTS_REMOVE_METHOD,
  RLY0_ACCOUNTS_ADD_LOGIN_START_METHOD,
  RLY0_ACCOUNTS_ADD_LOGIN_STATUS_METHOD,
  RLY0_ACCOUNTS_ADD_LOGIN_CANCEL_METHOD,
  rly0AccountsAddLoginStartParamsSchema,
  rly0AccountsAddLoginStartResultSchema,
  rly0AccountsAddLoginStatusParamsSchema,
  rly0AccountsAddLoginStatusResultSchema,
  rly0AccountsAddLoginCancelParamsSchema,
  rly0AccountsAddLoginCancelResultSchema,
  type Rly0AccountsAddLoginStartParams,
  type Rly0AccountsAddLoginStartResult,
  type Rly0AccountsAddLoginStatusParams,
  type Rly0AccountsAddLoginStatusResult,
  type Rly0AccountsAddLoginCancelParams,
  type Rly0AccountsAddLoginCancelResult,
  RLY0_MCP_LIST_METHOD,
  RLY0_MCP_SET_ENABLED_METHOD,
  RLY0_MCP_REMOVE_METHOD,
  RLY0_MCP_ADD_METHOD,
  RLY0_SKILLS_LIST_METHOD,
  RLY0_SKILLS_DEACTIVATE_METHOD,
  RLY0_SKILLS_RESTORE_METHOD,
  RLY0_SKILLS_IMPORT_METHOD,
  RLY0_THREADS_LIST_METHOD,
  RLY0_THREADS_LIST_TRASH_METHOD,
  RLY0_THREADS_TRASH_METHOD,
  RLY0_THREADS_RESTORE_METHOD,
  RLY0_DASHBOARD_HEALTH_METHOD,
  RLY0_DASHBOARD_THREAD_STATS_METHOD,
  RLY0_MAINTENANCE_DIAGNOSTICS_METHOD,
  RLY0_MAINTENANCE_EXPORT_DIAGNOSTICS_METHOD,
  RLY0_MAINTENANCE_CACHE_INFO_METHOD,
  RLY0_MAINTENANCE_CLEAR_CACHE_METHOD,
  RLY0_MAINTENANCE_FORCE_QUIT_CODEX_METHOD,
  RLY0_MAINTENANCE_RESTART_CODEX_METHOD,
  RLY0_MAINTENANCE_BACKUP_STATUS_METHOD,
  RLY0_MAINTENANCE_RESTORE_BACKUP_METHOD,
  rly0MaintenanceBackupStatusResultSchema,
  rly0MaintenanceRestoreBackupResultSchema,
  type Rly0MaintenanceBackupStatusResult,
  type Rly0MaintenanceRestoreBackupResult,
  RLY0_APPEARANCE_AUTOSTART_GET_METHOD,
  RLY0_APPEARANCE_AUTOSTART_SET_METHOD,
  rly0MaintenanceDiagnosticsResultSchema,
  rly0MaintenanceExportDiagnosticsResultSchema,
  rly0MaintenanceCacheInfoResultSchema,
  rly0MaintenanceClearCacheResultSchema,
  rly0MaintenanceProcessActionResultSchema,
  rly0AppearanceAutostartResultSchema,
  rly0AppearanceAutostartSetParamsSchema,
  rly0CoreStatusResultSchema,
  rly0AccountsListResultSchema,
  rly0AccountsImportCurrentParamsSchema,
  rly0AccountsImportCurrentResultSchema,
  rly0AccountsSwitchParamsSchema,
  rly0AccountsSwitchResultSchema,
  rly0AccountsRenameParamsSchema,
  rly0AccountsRenameResultSchema,
  rly0AccountsRemoveParamsSchema,
  rly0AccountsRemoveResultSchema,
  rly0McpListResultSchema,
  rly0McpSetEnabledParamsSchema,
  rly0McpMutationResultSchema,
  rly0McpRemoveParamsSchema,
  rly0McpAddParamsSchema,
  rly0SkillsListResultSchema,
  rly0SkillsDeactivateParamsSchema,
  rly0SkillsDeactivateResultSchema,
  rly0SkillsRestoreParamsSchema,
  rly0SkillsRestoreResultSchema,
  rly0SkillsImportParamsSchema,
  rly0SkillsImportResultSchema,
  rly0ThreadsListParamsSchema,
  rly0ThreadsListResultSchema,
  rly0ThreadsListTrashResultSchema,
  rly0ThreadsMoveParamsSchema,
  rly0ThreadsMoveResultSchema,
  rly0DashboardHealthResultSchema,
  rly0DashboardThreadStatsResultSchema,
  type Rly0CoreStatusResult,
  type Rly0AccountsListResult,
  type Rly0AccountsImportCurrentParams,
  type Rly0AccountsImportCurrentResult,
  type Rly0AccountsSwitchParams,
  type Rly0AccountsSwitchResult,
  type Rly0AccountsRenameParams,
  type Rly0AccountsRenameResult,
  type Rly0AccountsRemoveParams,
  type Rly0AccountsRemoveResult,
  type Rly0McpListResult,
  type Rly0McpSetEnabledParams,
  type Rly0McpMutationResult,
  type Rly0McpRemoveParams,
  type Rly0McpAddParams,
  type Rly0SkillsListResult,
  type Rly0SkillsDeactivateParams,
  type Rly0SkillsDeactivateResult,
  type Rly0SkillsRestoreParams,
  type Rly0SkillsRestoreResult,
  type Rly0SkillsImportParams,
  type Rly0SkillsImportResult,
  type Rly0ThreadsListParams,
  type Rly0ThreadsListResult,
  type Rly0ThreadsListTrashResult,
  type Rly0ThreadsMoveParams,
  type Rly0ThreadsMoveResult,
  type Rly0DashboardHealthResult,
  type Rly0DashboardThreadStatsResult,
  type Rly0MaintenanceDiagnosticsResult,
  type Rly0MaintenanceExportDiagnosticsResult,
  type Rly0MaintenanceCacheInfoResult,
  type Rly0MaintenanceClearCacheResult,
  type Rly0MaintenanceProcessActionResult,
  type Rly0AppearanceAutostartResult,
  type Rly0AppearanceAutostartSetParams,
  RLY0_ACCOUNTS_USAGE_METHOD,
  RLY0_ACCOUNTS_USAGE_ALL_METHOD,
  RLY0_PROXY_SETTINGS_GET_METHOD,
  RLY0_PROXY_SETTINGS_SET_METHOD,
  RLY0_RELAY_LIST_METHOD,
  RLY0_RELAY_ADD_METHOD,
  RLY0_RELAY_UPDATE_METHOD,
  RLY0_RELAY_REMOVE_METHOD,
  RLY0_RELAY_SET_ENABLED_METHOD,
  RLY0_RELAY_TEST_METHOD,
  RLY0_PROXY_START_METHOD,
  RLY0_PROXY_STOP_METHOD,
  RLY0_PROXY_STATUS_METHOD,
  RLY0_RELAY_MODEL_CATALOG_STATUS_METHOD,
  RLY0_RELAY_CODEX_CONFIG_STATUS_METHOD,
  RLY0_RELAY_CODEX_CONFIG_APPLY_METHOD,
  RLY0_RELAY_CODEX_CONFIG_RESTORE_METHOD,
  rly0AccountsUsageParamsSchema,
  rly0AccountsUsageResultSchema,
  rly0AccountsUsageAllResultSchema,
  rly0ProxySettingsGetResultSchema,
  rly0ProxySettingsSetParamsSchema,
  rly0ProxySettingsSetResultSchema,
  rly0RelayListResultSchema,
  rly0RelayAddParamsSchema,
  rly0RelayAddResultSchema,
  rly0RelayUpdateParamsSchema,
  rly0RelayMutationResultSchema,
  rly0RelayRemoveParamsSchema,
  rly0RelayRemoveResultSchema,
  rly0RelaySetEnabledParamsSchema,
  rly0RelayTestParamsSchema,
  rly0RelayTestResultSchema,
  rly0ProxyStartParamsSchema,
  rly0ProxyStatusResultSchema,
  rly0ProxyStopResultSchema,
  rly0RelayCodexConfigStatusResultSchema,
  rly0RelayModelCatalogStatusParamsSchema,
  rly0RelayModelCatalogStatusResultSchema,
  rly0RelayCodexConfigApplyParamsSchema,
  rly0RelayCodexConfigMutationResultSchema,
  type Rly0AccountsUsageParams,
  type Rly0AccountsUsageResult,
  type Rly0AccountsUsageAllResult,
  type Rly0ProxySettingsGetResult,
  type Rly0ProxySettingsSetParams,
  type Rly0ProxySettingsSetResult,
  type Rly0RelayListResult,
  type Rly0RelayAddParams,
  type Rly0RelayAddResult,
  type Rly0RelayUpdateParams,
  type Rly0RelayMutationResult,
  type Rly0RelayRemoveParams,
  type Rly0RelayRemoveResult,
  type Rly0RelaySetEnabledParams,
  type Rly0RelayTestParams,
  type Rly0RelayTestResult,
  type Rly0ProxyStartParams,
  type Rly0ProxyStatusResult,
  type Rly0ProxyStopResult,
  type Rly0RelayCodexConfigStatusResult,
  type Rly0RelayModelCatalogStatusParams,
  type Rly0RelayModelCatalogStatusResult,
  type Rly0RelayCodexConfigApplyParams,
  type Rly0RelayCodexConfigMutationResult,
  type ExternalThreadForkParams,
  type ExternalThreadForkResult,
  type CodexAccountChanged,
  type CodexAccountListResult,
  type HarnessCommandCatalog,
  type HarnessCommandsInspectParams,
  type HarnessConfigurationState,
  type HarnessInspection,
  type HarnessInspectParams,
  type HarnessWebUiOpenParams,
  type HarnessModelSelectionState,
  type ThreadInspection,
  type ThreadInspectionParams,
  type ThreadCommandExecuteParams,
  type ThreadCommandExecuteResult,
  type ThreadCommandsInspectParams,
  type ThreadModelSelectParams,
  type ThreadPermissionModeSelectParams,
  type ThreadThinkingSelectParams,
  type ThreadOwnershipListParams,
  type ThreadOwnershipListResult,
  type ThreadUsageInspection,
  type ThreadUsageInspectionParams,
  type UpdateCheckResult,
  type UpdateStartResult,
  type UpdateStatusResult,
} from "@codexhost/shared-contracts";

import {
  createRendererRequestSender,
  RendererMethodUnavailableError,
  type RendererRequestOptions,
} from "./renderer-request-sender.js";
import {
  createRendererSessionImportClient,
  type RendererSessionImportClient,
} from "./renderer-session-import-client.js";

export const HARNESS_INSPECT_METHOD = "codexhost/harness/inspect";
export const HARNESS_PLUGIN_LIST_METHOD = "codexhost/harness/plugins/list";
import {
  CREDENTIAL_IMPORTS_METHOD,
  credentialImportsParamsSchema,
  credentialImportsResultSchema,
  type CredentialImportsRequest,
  type CredentialImportsResult,
} from "@codexhost/shared-contracts";

export const HARNESS_ACCOUNT_SOURCES_METHOD = "codexhost/harness/accounts/sources";
export const HARNESS_ACCOUNT_INSPECT_METHOD = "codexhost/harness/accounts/inspect";
export const HARNESS_WEB_UI_OPEN_METHOD = "codexhost/harness/web-ui/open";
export const THREAD_FORK_METHOD = "codexhost/thread/fork";
export const THREAD_INSPECT_METHOD = "codexhost/thread/inspect";
export const HARNESS_COMMANDS_INSPECT_METHOD = "codexhost/harness/commands/inspect";
export const THREAD_COMMANDS_INSPECT_METHOD = "codexhost/thread/commands/inspect";
export const THREAD_COMMAND_EXECUTE_METHOD = "codexhost/thread/command/execute";
export const THREAD_MODEL_SELECT_METHOD = "codexhost/thread/model/select";
export const THREAD_THINKING_SELECT_METHOD = "codexhost/thread/thinking/select";
export const THREAD_PERMISSION_MODE_SELECT_METHOD = "codexhost/thread/permission-mode/select";
export const THREAD_OWNERSHIP_LIST_METHOD = "codexhost/thread/ownership/list";
export const THREAD_USAGE_INSPECT_METHOD = "codexhost/thread/usage/inspect";
export const THREAD_USAGE_UPDATED_METHOD = "codexhost/thread/usage/updated";
export const THREAD_TOKEN_USAGE_UPDATED_METHOD = "thread/tokenUsage/updated";
/**
 * Codex Desktop does not dispatch the custom `codexhost/thread/usage/updated`
 * notification to renderer callbacks, and the native token-usage carrier is
 * only projected once Context usage is known. Turn completion is dispatched,
 * so it is the guaranteed point to re-read account quota after a reply.
 */
export const TURN_COMPLETED_METHOD = "turn/completed";
const THREAD_USAGE_REFRESH_METHODS = [
  THREAD_TOKEN_USAGE_UPDATED_METHOD,
  THREAD_USAGE_UPDATED_METHOD,
  TURN_COMPLETED_METHOD,
] as const;
export const UPDATE_CHECK_METHOD = "codexhost/update/check";
export const UPDATE_START_METHOD = "codexhost/update/start";
export const UPDATE_STATUS_METHOD = "codexhost/update/status";
export const CODEX_ACCOUNT_LIST_METHOD = "codexhost/account/list";
export const CODEX_ACCOUNT_REFRESH_METHOD = "codexhost/account/refresh";
export const CODEX_ACCOUNT_CHANGED_METHOD = "codexhost/account/changed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notifiedThreadId(notification: unknown): ThreadUsageInspectionParams["threadId"] | null {
  if (
    !isRecord(notification) ||
    !(THREAD_USAGE_REFRESH_METHODS as readonly unknown[]).includes(notification.method)
  ) {
    return null;
  }
  const params = notification.params;
  if (!isRecord(params)) return null;
  const parsed = hostThreadIdSchema.safeParse(params.threadId);
  return parsed.success ? parsed.data : null;
}

interface RequestManagerCandidate {
  addNotificationCallback?: (
    method: string | readonly string[],
    callback: (notification: unknown) => void,
  ) => () => void;
  sendRequest?: (method: string, params: unknown, options?: unknown) => Promise<unknown> | unknown;
  requestClient?: RequestManagerCandidate;
}

function notificationTarget(manager: RequestManagerCandidate): RequestManagerCandidate | null {
  if (typeof manager.addNotificationCallback === "function") return manager;
  const nested = manager.requestClient;
  return nested && typeof nested.addNotificationCallback === "function" ? nested : null;
}

export interface RendererModelClient extends Partial<RendererSessionImportClient> {
  getHarnessLaunchSettings?(input: HarnessLaunchSettingsGet): Promise<HarnessLaunchSettings>;
  setHarnessLaunchSettings?(input: HarnessLaunchSettingsSet): Promise<HarnessLaunchSettings>;
  setIdleReleaseSettings?(settings: IdleReleaseSettings): Promise<IdleReleaseSettings>;
  listLoadedSessions?(): Promise<LoadedSession[]>;
  currentHostId?(): string | null;
  listHarnessPlugins?(): Promise<HarnessPluginListResult>;
  clientForHost?(hostId: string): RendererModelClient | null;
  forkThread(input: ExternalThreadForkParams): Promise<ExternalThreadForkResult>;
  inspectHarness(
    input: HarnessInspectParams,
    options?: RendererRequestOptions,
  ): Promise<HarnessInspection>;
  openHarnessWebUi?(input: HarnessWebUiOpenParams): Promise<void>;
  inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection>;
  inspectHarnessCommands(input: HarnessCommandsInspectParams): Promise<HarnessCommandCatalog>;
  inspectThreadCommands(input: ThreadCommandsInspectParams): Promise<HarnessCommandCatalog>;
  executeThreadCommand(input: ThreadCommandExecuteParams): Promise<ThreadCommandExecuteResult>;
  listThreadOwnership(input: ThreadOwnershipListParams): Promise<ThreadOwnershipListResult>;
  inspectThreadUsage(input: ThreadUsageInspectionParams): Promise<ThreadUsageInspection>;
  subscribeThreadUsage?(listener: (update: ThreadUsageInspection) => void): () => void;
  selectThreadModel(input: ThreadModelSelectParams): Promise<HarnessModelSelectionState>;
  selectThreadThinking(input: ThreadThinkingSelectParams): Promise<HarnessModelSelectionState>;
  selectThreadPermissionMode(
    input: ThreadPermissionModeSelectParams,
  ): Promise<HarnessConfigurationState>;
  checkUpdate(): Promise<UpdateCheckResult>;
  startUpdate(): Promise<UpdateStartResult>;
  readUpdateStatus(): Promise<UpdateStatusResult>;
  inspectCodexAccountUsage?(input: CodexAccountUsageParams): Promise<CodexAccountUsageResult>;
  listHarnessAccountSources?(): Promise<HarnessAccountSourceListResult>;
  inspectHarnessAccount?(input: HarnessAccountInspectParams): Promise<HarnessAccountInspectResult>;
  listHarnessAccounts?(input?: HarnessAccountListParams): Promise<HarnessAccountListResult>;
  credentialImports?(
    request: CredentialImportsRequest,
    targetHarnessId?: string,
  ): Promise<CredentialImportsResult>;
  listCodexAccounts(): Promise<CodexAccountListResult>;
  refreshCodexAccounts(): Promise<CodexAccountListResult>;
  subscribeCodexAccounts?(listener: (state: CodexAccountChanged) => void): () => void;
  listRly0Mcp?(): Promise<Rly0McpListResult>;
  setRly0McpEnabled?(input: Rly0McpSetEnabledParams): Promise<Rly0McpMutationResult>;
  removeRly0Mcp?(input: Rly0McpRemoveParams): Promise<Rly0McpMutationResult>;
  addRly0Mcp?(input: Rly0McpAddParams): Promise<Rly0McpMutationResult>;
  listRly0Skills?(): Promise<Rly0SkillsListResult>;
  deactivateRly0Skill?(input: Rly0SkillsDeactivateParams): Promise<Rly0SkillsDeactivateResult>;
  restoreRly0Skill?(input: Rly0SkillsRestoreParams): Promise<Rly0SkillsRestoreResult>;
  importRly0Skill?(input: Rly0SkillsImportParams): Promise<Rly0SkillsImportResult>;
  listRly0Threads?(input?: Rly0ThreadsListParams): Promise<Rly0ThreadsListResult>;
  listRly0ThreadsTrash?(): Promise<Rly0ThreadsListTrashResult>;
  trashRly0Threads?(input: Rly0ThreadsMoveParams): Promise<Rly0ThreadsMoveResult>;
  restoreRly0Threads?(input: Rly0ThreadsMoveParams): Promise<Rly0ThreadsMoveResult>;
  rly0DashboardHealth?(): Promise<Rly0DashboardHealthResult>;
  rly0DashboardThreadStats?(): Promise<Rly0DashboardThreadStatsResult>;
  rly0MaintenanceDiagnostics?(): Promise<Rly0MaintenanceDiagnosticsResult>;
  rly0MaintenanceExportDiagnostics?(): Promise<Rly0MaintenanceExportDiagnosticsResult>;
  rly0MaintenanceCacheInfo?(): Promise<Rly0MaintenanceCacheInfoResult>;
  rly0MaintenanceClearCache?(): Promise<Rly0MaintenanceClearCacheResult>;
  rly0MaintenanceForceQuitCodex?(): Promise<Rly0MaintenanceProcessActionResult>;
  rly0MaintenanceRestartCodex?(): Promise<Rly0MaintenanceProcessActionResult>;
  rly0MaintenanceBackupStatus?(): Promise<Rly0MaintenanceBackupStatusResult>;
  rly0MaintenanceRestoreBackup?(): Promise<Rly0MaintenanceRestoreBackupResult>;
  rly0AppearanceAutostartStatus?(): Promise<Rly0AppearanceAutostartResult>;
  rly0AppearanceAutostartSet?(
    input: Rly0AppearanceAutostartSetParams,
  ): Promise<Rly0AppearanceAutostartResult>;
  rly0AccountUsage?(input: Rly0AccountsUsageParams): Promise<Rly0AccountsUsageResult>;
  rly0AccountUsageAll?(): Promise<Rly0AccountsUsageAllResult>;
  rly0ProxySettingsGet?(): Promise<Rly0ProxySettingsGetResult>;
  rly0ProxySettingsSet?(input: Rly0ProxySettingsSetParams): Promise<Rly0ProxySettingsSetResult>;
  listRly0Relays?(): Promise<Rly0RelayListResult>;
  addRly0Relay?(input: Rly0RelayAddParams): Promise<Rly0RelayAddResult>;
  updateRly0Relay?(input: Rly0RelayUpdateParams): Promise<Rly0RelayMutationResult>;
  removeRly0Relay?(input: Rly0RelayRemoveParams): Promise<Rly0RelayRemoveResult>;
  setRly0RelayEnabled?(input: Rly0RelaySetEnabledParams): Promise<Rly0RelayMutationResult>;
  testRly0Relay?(input: Rly0RelayTestParams): Promise<Rly0RelayTestResult>;
  rly0ProxyStart?(input?: Rly0ProxyStartParams): Promise<Rly0ProxyStatusResult>;
  rly0ProxyStop?(): Promise<Rly0ProxyStopResult>;
  rly0ProxyStatus?(): Promise<Rly0ProxyStatusResult>;
  rly0RelayCodexConfigStatus?(): Promise<Rly0RelayCodexConfigStatusResult>;
  rly0RelayModelCatalogStatus?(
    input?: Rly0RelayModelCatalogStatusParams,
  ): Promise<Rly0RelayModelCatalogStatusResult>;
  rly0RelayCodexConfigApply?(
    input: Rly0RelayCodexConfigApplyParams,
  ): Promise<Rly0RelayCodexConfigMutationResult>;
  rly0RelayCodexConfigRestore?(): Promise<Rly0RelayCodexConfigMutationResult>;
}

export function createThreadUsageSubscriptionRelay(): {
  connect(client: Pick<RendererModelClient, "subscribeThreadUsage"> | null): void;
  subscribe(listener: (update: ThreadUsageInspection) => void): () => void;
  dispose(): void;
} {
  const listeners = new Set<(update: ThreadUsageInspection) => void>();
  let removeNotificationCallback: (() => void) | null = null;
  let connectedClient: Pick<RendererModelClient, "subscribeThreadUsage"> | null = null;
  let generation = 0;
  const disconnect = (): void => {
    generation += 1;
    removeNotificationCallback?.();
    removeNotificationCallback = null;
    connectedClient = null;
  };
  return {
    connect(client) {
      if (client === connectedClient && removeNotificationCallback) return;
      disconnect();
      if (!client || listeners.size === 0) return;
      connectedClient = client;
      const subscriptionGeneration = generation;
      try {
        removeNotificationCallback =
          client.subscribeThreadUsage?.((update) => {
            if (subscriptionGeneration !== generation) return;
            for (const listener of listeners) listener(update);
          }) ?? null;
      } catch {
        disconnect();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        disconnect();
      };
    },
    dispose() {
      disconnect();
      listeners.clear();
    },
  };
}

export function createRendererModelClient(
  candidates: readonly RequestManagerCandidate[],
): RendererModelClient | null {
  const managers = candidates.filter(
    (
      candidate,
    ): candidate is RequestManagerCandidate &
      Required<Pick<RequestManagerCandidate, "sendRequest">> =>
      typeof candidate.sendRequest === "function",
  );
  const source = managers[0];
  if (managers.length !== 1 || !source) return null;
  const manager = {
    sendRequest: createRendererRequestSender((method, params, options) =>
      options === undefined
        ? source.sendRequest(method, params)
        : source.sendRequest(method, params, options),
    ),
  };

  const inspectHarness = async (
    input: HarnessInspectParams,
    options?: RendererRequestOptions,
  ): Promise<HarnessInspection> => {
    const params = harnessInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(HARNESS_INSPECT_METHOD, params, options);
    return harnessInspectionSchema.parse(result);
  };
  const inspectHarnessCommands = async (
    input: HarnessCommandsInspectParams,
  ): Promise<HarnessCommandCatalog> => {
    const params = harnessCommandsInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(HARNESS_COMMANDS_INSPECT_METHOD, params);
    return harnessCommandCatalogSchema.parse(result);
  };
  const inspectThreadCommands = async (
    input: ThreadCommandsInspectParams,
  ): Promise<HarnessCommandCatalog> => {
    const params = threadCommandsInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_COMMANDS_INSPECT_METHOD, params);
    return harnessCommandCatalogSchema.parse(result);
  };
  const executeThreadCommand = async (
    input: ThreadCommandExecuteParams,
  ): Promise<ThreadCommandExecuteResult> => {
    const params = threadCommandExecuteParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_COMMAND_EXECUTE_METHOD, params);
    return threadCommandExecuteResultSchema.parse(result);
  };
  const inspectThreadUsage = async (
    input: ThreadUsageInspectionParams,
  ): Promise<ThreadUsageInspection> => {
    const params = threadUsageInspectionParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_USAGE_INSPECT_METHOD, params);
    return threadUsageInspectionSchema.parse(result);
  };
  const selectThreadModel = async (
    input: ThreadModelSelectParams,
  ): Promise<HarnessModelSelectionState> => {
    const params = threadModelSelectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_MODEL_SELECT_METHOD, params);
    return harnessModelSelectionStateSchema.parse(result);
  };
  const selectThreadThinking = async (
    input: ThreadThinkingSelectParams,
  ): Promise<HarnessModelSelectionState> => {
    const params = threadThinkingSelectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_THINKING_SELECT_METHOD, params);
    return harnessModelSelectionStateSchema.parse(result);
  };
  const selectThreadPermissionMode = async (
    input: ThreadPermissionModeSelectParams,
  ): Promise<HarnessConfigurationState> => {
    const params = threadPermissionModeSelectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_PERMISSION_MODE_SELECT_METHOD, params);
    return harnessConfigurationStateSchema.parse(result);
  };

  return Object.freeze({
    async getHarnessLaunchSettings(
      input: HarnessLaunchSettingsGet,
    ): Promise<HarnessLaunchSettings> {
      return harnessLaunchSettingsSchema.parse(
        await manager.sendRequest(
          HARNESS_LAUNCH_SETTINGS_GET_METHOD,
          harnessLaunchSettingsGetSchema.parse(input),
        ),
      );
    },
    async setHarnessLaunchSettings(
      input: HarnessLaunchSettingsSet,
    ): Promise<HarnessLaunchSettings> {
      return harnessLaunchSettingsSchema.parse(
        await manager.sendRequest(
          HARNESS_LAUNCH_SETTINGS_SET_METHOD,
          harnessLaunchSettingsSetSchema.parse(input),
        ),
      );
    },
    async listLoadedSessions(): Promise<LoadedSession[]> {
      return loadedSessionsSchema.parse(await manager.sendRequest(LOADED_SESSIONS_METHOD, {}));
    },
    async setIdleReleaseSettings(settings: IdleReleaseSettings): Promise<IdleReleaseSettings> {
      const params = idleReleaseSettingsSchema.parse(settings);
      return idleReleaseSettingsSchema.parse(
        await manager.sendRequest(IDLE_RELEASE_SETTINGS_METHOD, params),
      );
    },
    ...createRendererSessionImportClient(async (method, params) =>
      manager.sendRequest(method, params),
    ),
    async forkThread(input: ExternalThreadForkParams): Promise<ExternalThreadForkResult> {
      const params = externalThreadForkParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_FORK_METHOD, params);
      return externalThreadForkResultSchema.parse(result);
    },
    inspectHarness,
    async listHarnessPlugins(): Promise<HarnessPluginListResult> {
      return harnessPluginListResultSchema.parse(
        await manager.sendRequest(HARNESS_PLUGIN_LIST_METHOD, {}),
      );
    },
    async openHarnessWebUi(input: HarnessWebUiOpenParams): Promise<void> {
      const params = harnessWebUiOpenParamsSchema.parse(input);
      const result = await manager.sendRequest(HARNESS_WEB_UI_OPEN_METHOD, params);
      harnessWebUiOpenResultSchema.parse(result);
    },
    async inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection> {
      const params = threadInspectionParamsSchema.parse(input);
      let result: unknown;
      try {
        result = await manager.sendRequest(THREAD_INSPECT_METHOD, params);
      } catch (error) {
        if (!(error instanceof RendererMethodUnavailableError)) throw error;

        // Stock Codex has no Host inspection API. Verify its native Thread on
        // this same connection; neither an RPC failure nor a missing Account
        // establishes ownership. Match the external markers used by the Host.
        const native = await manager.sendRequest("thread/read", {
          threadId: params.threadId,
          includeTurns: false,
        });
        const thread = isRecord(native) ? native.thread : null;
        if (
          !isRecord(thread) ||
          thread.id !== params.threadId ||
          typeof thread.modelProvider !== "string" ||
          !thread.modelProvider ||
          thread.modelProvider === "codexhost" ||
          typeof thread.cliVersion !== "string" ||
          !thread.cliVersion ||
          thread.cliVersion === "codexhost"
        ) {
          throw new Error("Native Thread response cannot establish Codex ownership");
        }
        return { owner: "codex", locked: true };
      }
      return threadInspectionSchema.parse(result);
    },
    inspectHarnessCommands,
    inspectThreadCommands,
    executeThreadCommand,
    async listThreadOwnership(
      input: ThreadOwnershipListParams,
    ): Promise<ThreadOwnershipListResult> {
      const params = threadOwnershipListParamsSchema.parse(input);
      const value = await manager.sendRequest(THREAD_OWNERSHIP_LIST_METHOD, params);
      const result = threadOwnershipListResultSchema.parse(value);
      if (
        result.threads.length !== params.threadIds.length ||
        result.threads.some((thread, index) => thread.threadId !== params.threadIds[index])
      ) {
        throw new Error("Thread ownership-list result does not match the requested IDs");
      }
      return result;
    },
    inspectThreadUsage,
    subscribeThreadUsage(listener: (update: ThreadUsageInspection) => void): () => void {
      const notifications = notificationTarget(source);
      if (!notifications?.addNotificationCallback) {
        throw new Error("Renderer Usage notification callback is unavailable");
      }
      let disposed = false;
      const generations = new Map<ThreadUsageInspectionParams["threadId"], number>();
      const removeNotificationCallback = notifications.addNotificationCallback(
        THREAD_USAGE_REFRESH_METHODS,
        (notification) => {
          const threadId = notifiedThreadId(notification);
          if (!threadId) return;
          const generation = (generations.get(threadId) ?? 0) + 1;
          generations.set(threadId, generation);
          void inspectThreadUsage({ threadId })
            .then((update) => {
              if (!disposed && generations.get(threadId) === generation) listener(update);
            })
            .catch(() => undefined);
        },
      );
      return () => {
        if (disposed) return;
        disposed = true;
        generations.clear();
        removeNotificationCallback();
      };
    },
    selectThreadModel,
    selectThreadThinking,
    selectThreadPermissionMode,
    async checkUpdate(): Promise<UpdateCheckResult> {
      const result = await manager.sendRequest(
        UPDATE_CHECK_METHOD,
        updateEmptyParamsSchema.parse({}),
      );
      return updateCheckResultSchema.parse(result);
    },
    async startUpdate(): Promise<UpdateStartResult> {
      const result = await manager.sendRequest(
        UPDATE_START_METHOD,
        updateEmptyParamsSchema.parse({}),
      );
      return updateStartResultSchema.parse(result);
    },
    async readUpdateStatus(): Promise<UpdateStatusResult> {
      const result = await manager.sendRequest(
        UPDATE_STATUS_METHOD,
        updateEmptyParamsSchema.parse({}),
      );
      return updateStatusResultSchema.parse(result);
    },
    async inspectCodexAccountUsage(
      input: CodexAccountUsageParams,
    ): Promise<CodexAccountUsageResult> {
      const result = await manager.sendRequest(
        "codexhost/account/usage/inspect",
        codexAccountUsageParamsSchema.parse(input),
      );
      return codexAccountUsageResultSchema.parse(result);
    },
    async listHarnessAccountSources(): Promise<HarnessAccountSourceListResult> {
      return harnessAccountSourceListResultSchema.parse(
        await manager.sendRequest(HARNESS_ACCOUNT_SOURCES_METHOD, {}),
      );
    },
    async inspectHarnessAccount(
      input: HarnessAccountInspectParams,
    ): Promise<HarnessAccountInspectResult> {
      return harnessAccountInspectResultSchema.parse(
        await manager.sendRequest(
          HARNESS_ACCOUNT_INSPECT_METHOD,
          harnessAccountInspectParamsSchema.parse(input),
        ),
      );
    },
    async credentialImports(
      request: CredentialImportsRequest,
      targetHarnessId?: string,
    ): Promise<CredentialImportsResult> {
      return credentialImportsResultSchema.parse(
        await manager.sendRequest(
          CREDENTIAL_IMPORTS_METHOD,
          credentialImportsParamsSchema.parse({ request, targetHarnessId }),
        ),
      );
    },
    async listHarnessAccounts(
      input: HarnessAccountListParams = {},
    ): Promise<HarnessAccountListResult> {
      return harnessAccountListResultSchema.parse(
        await manager.sendRequest(
          "codexhost/harness/accounts/list",
          harnessAccountListParamsSchema.parse(input),
        ),
      );
    },
    async listCodexAccounts(): Promise<CodexAccountListResult> {
      const result = await manager.sendRequest(CODEX_ACCOUNT_LIST_METHOD, {});
      return codexAccountListResultSchema.parse(result);
    },
    async refreshCodexAccounts(): Promise<CodexAccountListResult> {
      const result = await manager.sendRequest(CODEX_ACCOUNT_REFRESH_METHOD, {});
      return codexAccountListResultSchema.parse(result);
    },
    subscribeCodexAccounts(listener: (state: CodexAccountChanged) => void): () => void {
      const notifications = notificationTarget(source);
      if (!notifications?.addNotificationCallback) {
        throw new Error("Renderer Account notification callback is unavailable");
      }
      return notifications.addNotificationCallback(CODEX_ACCOUNT_CHANGED_METHOD, (notification) => {
        if (!isRecord(notification) || notification.method !== CODEX_ACCOUNT_CHANGED_METHOD) return;
        const state = codexAccountChangedSchema.safeParse(notification.params);
        if (state.success) listener(state.data);
      });
    },
    async rly0CoreStatus(): Promise<Rly0CoreStatusResult> {
      return rly0CoreStatusResultSchema.parse(
        await manager.sendRequest(RLY0_CORE_STATUS_METHOD, {}),
      );
    },
    async listRly0Accounts(): Promise<Rly0AccountsListResult> {
      return rly0AccountsListResultSchema.parse(
        await manager.sendRequest(RLY0_ACCOUNTS_LIST_METHOD, {}),
      );
    },
    async importCurrentRly0Account(
      input: Rly0AccountsImportCurrentParams,
    ): Promise<Rly0AccountsImportCurrentResult> {
      return rly0AccountsImportCurrentResultSchema.parse(
        await manager.sendRequest(
          RLY0_ACCOUNTS_IMPORT_CURRENT_METHOD,
          rly0AccountsImportCurrentParamsSchema.parse(input),
        ),
      );
    },
    async switchRly0Account(input: Rly0AccountsSwitchParams): Promise<Rly0AccountsSwitchResult> {
      return rly0AccountsSwitchResultSchema.parse(
        await manager.sendRequest(
          RLY0_ACCOUNTS_SWITCH_METHOD,
          rly0AccountsSwitchParamsSchema.parse(input),
        ),
      );
    },
    async renameRly0Account(input: Rly0AccountsRenameParams): Promise<Rly0AccountsRenameResult> {
      return rly0AccountsRenameResultSchema.parse(
        await manager.sendRequest(
          RLY0_ACCOUNTS_RENAME_METHOD,
          rly0AccountsRenameParamsSchema.parse(input),
        ),
      );
    },
    async removeRly0Account(input: Rly0AccountsRemoveParams): Promise<Rly0AccountsRemoveResult> {
      return rly0AccountsRemoveResultSchema.parse(
        await manager.sendRequest(
          RLY0_ACCOUNTS_REMOVE_METHOD,
          rly0AccountsRemoveParamsSchema.parse(input),
        ),
      );
    },
    async startRly0AddAccountLogin(
      input: Rly0AccountsAddLoginStartParams,
    ): Promise<Rly0AccountsAddLoginStartResult> {
      return rly0AccountsAddLoginStartResultSchema.parse(
        await manager.sendRequest(
          RLY0_ACCOUNTS_ADD_LOGIN_START_METHOD,
          rly0AccountsAddLoginStartParamsSchema.parse(input),
        ),
      );
    },
    async rly0AddAccountLoginStatus(
      input: Rly0AccountsAddLoginStatusParams,
    ): Promise<Rly0AccountsAddLoginStatusResult> {
      return rly0AccountsAddLoginStatusResultSchema.parse(
        await manager.sendRequest(
          RLY0_ACCOUNTS_ADD_LOGIN_STATUS_METHOD,
          rly0AccountsAddLoginStatusParamsSchema.parse(input),
        ),
      );
    },
    async cancelRly0AddAccountLogin(
      input: Rly0AccountsAddLoginCancelParams,
    ): Promise<Rly0AccountsAddLoginCancelResult> {
      return rly0AccountsAddLoginCancelResultSchema.parse(
        await manager.sendRequest(
          RLY0_ACCOUNTS_ADD_LOGIN_CANCEL_METHOD,
          rly0AccountsAddLoginCancelParamsSchema.parse(input),
        ),
      );
    },
    async listRly0Mcp(): Promise<Rly0McpListResult> {
      return rly0McpListResultSchema.parse(await manager.sendRequest(RLY0_MCP_LIST_METHOD, {}));
    },
    async setRly0McpEnabled(input: Rly0McpSetEnabledParams): Promise<Rly0McpMutationResult> {
      return rly0McpMutationResultSchema.parse(
        await manager.sendRequest(
          RLY0_MCP_SET_ENABLED_METHOD,
          rly0McpSetEnabledParamsSchema.parse(input),
        ),
      );
    },
    async removeRly0Mcp(input: Rly0McpRemoveParams): Promise<Rly0McpMutationResult> {
      return rly0McpMutationResultSchema.parse(
        await manager.sendRequest(RLY0_MCP_REMOVE_METHOD, rly0McpRemoveParamsSchema.parse(input)),
      );
    },
    async addRly0Mcp(input: Rly0McpAddParams): Promise<Rly0McpMutationResult> {
      return rly0McpMutationResultSchema.parse(
        await manager.sendRequest(RLY0_MCP_ADD_METHOD, rly0McpAddParamsSchema.parse(input)),
      );
    },
    async listRly0Skills(): Promise<Rly0SkillsListResult> {
      return rly0SkillsListResultSchema.parse(
        await manager.sendRequest(RLY0_SKILLS_LIST_METHOD, {}),
      );
    },
    async deactivateRly0Skill(
      input: Rly0SkillsDeactivateParams,
    ): Promise<Rly0SkillsDeactivateResult> {
      return rly0SkillsDeactivateResultSchema.parse(
        await manager.sendRequest(
          RLY0_SKILLS_DEACTIVATE_METHOD,
          rly0SkillsDeactivateParamsSchema.parse(input),
        ),
      );
    },
    async restoreRly0Skill(input: Rly0SkillsRestoreParams): Promise<Rly0SkillsRestoreResult> {
      return rly0SkillsRestoreResultSchema.parse(
        await manager.sendRequest(
          RLY0_SKILLS_RESTORE_METHOD,
          rly0SkillsRestoreParamsSchema.parse(input),
        ),
      );
    },
    async importRly0Skill(input: Rly0SkillsImportParams): Promise<Rly0SkillsImportResult> {
      return rly0SkillsImportResultSchema.parse(
        await manager.sendRequest(
          RLY0_SKILLS_IMPORT_METHOD,
          rly0SkillsImportParamsSchema.parse(input),
        ),
      );
    },
    async listRly0Threads(input: Rly0ThreadsListParams = {}): Promise<Rly0ThreadsListResult> {
      return rly0ThreadsListResultSchema.parse(
        await manager.sendRequest(
          RLY0_THREADS_LIST_METHOD,
          rly0ThreadsListParamsSchema.parse(input),
        ),
      );
    },
    async listRly0ThreadsTrash(): Promise<Rly0ThreadsListTrashResult> {
      return rly0ThreadsListTrashResultSchema.parse(
        await manager.sendRequest(RLY0_THREADS_LIST_TRASH_METHOD, {}),
      );
    },
    async trashRly0Threads(input: Rly0ThreadsMoveParams): Promise<Rly0ThreadsMoveResult> {
      return rly0ThreadsMoveResultSchema.parse(
        await manager.sendRequest(
          RLY0_THREADS_TRASH_METHOD,
          rly0ThreadsMoveParamsSchema.parse(input),
        ),
      );
    },
    async restoreRly0Threads(input: Rly0ThreadsMoveParams): Promise<Rly0ThreadsMoveResult> {
      return rly0ThreadsMoveResultSchema.parse(
        await manager.sendRequest(
          RLY0_THREADS_RESTORE_METHOD,
          rly0ThreadsMoveParamsSchema.parse(input),
        ),
      );
    },
    async rly0DashboardHealth(): Promise<Rly0DashboardHealthResult> {
      return rly0DashboardHealthResultSchema.parse(
        await manager.sendRequest(RLY0_DASHBOARD_HEALTH_METHOD, {}),
      );
    },
    async rly0DashboardThreadStats(): Promise<Rly0DashboardThreadStatsResult> {
      return rly0DashboardThreadStatsResultSchema.parse(
        await manager.sendRequest(RLY0_DASHBOARD_THREAD_STATS_METHOD, {}),
      );
    },
    async rly0MaintenanceDiagnostics(): Promise<Rly0MaintenanceDiagnosticsResult> {
      return rly0MaintenanceDiagnosticsResultSchema.parse(
        await manager.sendRequest(RLY0_MAINTENANCE_DIAGNOSTICS_METHOD, {}),
      );
    },
    async rly0MaintenanceExportDiagnostics(): Promise<Rly0MaintenanceExportDiagnosticsResult> {
      return rly0MaintenanceExportDiagnosticsResultSchema.parse(
        await manager.sendRequest(RLY0_MAINTENANCE_EXPORT_DIAGNOSTICS_METHOD, {}),
      );
    },
    async rly0MaintenanceCacheInfo(): Promise<Rly0MaintenanceCacheInfoResult> {
      return rly0MaintenanceCacheInfoResultSchema.parse(
        await manager.sendRequest(RLY0_MAINTENANCE_CACHE_INFO_METHOD, {}),
      );
    },
    async rly0MaintenanceClearCache(): Promise<Rly0MaintenanceClearCacheResult> {
      return rly0MaintenanceClearCacheResultSchema.parse(
        await manager.sendRequest(RLY0_MAINTENANCE_CLEAR_CACHE_METHOD, {}),
      );
    },
    async rly0MaintenanceForceQuitCodex(): Promise<Rly0MaintenanceProcessActionResult> {
      return rly0MaintenanceProcessActionResultSchema.parse(
        await manager.sendRequest(RLY0_MAINTENANCE_FORCE_QUIT_CODEX_METHOD, {}),
      );
    },
    async rly0MaintenanceBackupStatus(): Promise<Rly0MaintenanceBackupStatusResult> {
      return rly0MaintenanceBackupStatusResultSchema.parse(
        await manager.sendRequest(RLY0_MAINTENANCE_BACKUP_STATUS_METHOD, {}),
      );
    },
    async rly0MaintenanceRestoreBackup(): Promise<Rly0MaintenanceRestoreBackupResult> {
      return rly0MaintenanceRestoreBackupResultSchema.parse(
        await manager.sendRequest(RLY0_MAINTENANCE_RESTORE_BACKUP_METHOD, {}),
      );
    },
    async rly0MaintenanceRestartCodex(): Promise<Rly0MaintenanceProcessActionResult> {
      return rly0MaintenanceProcessActionResultSchema.parse(
        await manager.sendRequest(RLY0_MAINTENANCE_RESTART_CODEX_METHOD, {}),
      );
    },
    async rly0AppearanceAutostartStatus(): Promise<Rly0AppearanceAutostartResult> {
      return rly0AppearanceAutostartResultSchema.parse(
        await manager.sendRequest(RLY0_APPEARANCE_AUTOSTART_GET_METHOD, {}),
      );
    },
    async rly0AppearanceAutostartSet(
      input: Rly0AppearanceAutostartSetParams,
    ): Promise<Rly0AppearanceAutostartResult> {
      return rly0AppearanceAutostartResultSchema.parse(
        await manager.sendRequest(
          RLY0_APPEARANCE_AUTOSTART_SET_METHOD,
          rly0AppearanceAutostartSetParamsSchema.parse(input),
        ),
      );
    },
    async rly0AccountUsage(input: Rly0AccountsUsageParams): Promise<Rly0AccountsUsageResult> {
      return rly0AccountsUsageResultSchema.parse(
        await manager.sendRequest(
          RLY0_ACCOUNTS_USAGE_METHOD,
          rly0AccountsUsageParamsSchema.parse(input),
        ),
      );
    },
    async rly0AccountUsageAll(): Promise<Rly0AccountsUsageAllResult> {
      return rly0AccountsUsageAllResultSchema.parse(
        await manager.sendRequest(RLY0_ACCOUNTS_USAGE_ALL_METHOD, {}),
      );
    },
    async rly0ProxySettingsGet(): Promise<Rly0ProxySettingsGetResult> {
      return rly0ProxySettingsGetResultSchema.parse(
        await manager.sendRequest(RLY0_PROXY_SETTINGS_GET_METHOD, {}),
      );
    },
    async rly0ProxySettingsSet(
      input: Rly0ProxySettingsSetParams,
    ): Promise<Rly0ProxySettingsSetResult> {
      return rly0ProxySettingsSetResultSchema.parse(
        await manager.sendRequest(
          RLY0_PROXY_SETTINGS_SET_METHOD,
          rly0ProxySettingsSetParamsSchema.parse(input),
        ),
      );
    },
    async listRly0Relays(): Promise<Rly0RelayListResult> {
      return rly0RelayListResultSchema.parse(await manager.sendRequest(RLY0_RELAY_LIST_METHOD, {}));
    },
    async addRly0Relay(input: Rly0RelayAddParams): Promise<Rly0RelayAddResult> {
      return rly0RelayAddResultSchema.parse(
        await manager.sendRequest(RLY0_RELAY_ADD_METHOD, rly0RelayAddParamsSchema.parse(input)),
      );
    },
    async updateRly0Relay(input: Rly0RelayUpdateParams): Promise<Rly0RelayMutationResult> {
      return rly0RelayMutationResultSchema.parse(
        await manager.sendRequest(
          RLY0_RELAY_UPDATE_METHOD,
          rly0RelayUpdateParamsSchema.parse(input),
        ),
      );
    },
    async removeRly0Relay(input: Rly0RelayRemoveParams): Promise<Rly0RelayRemoveResult> {
      return rly0RelayRemoveResultSchema.parse(
        await manager.sendRequest(
          RLY0_RELAY_REMOVE_METHOD,
          rly0RelayRemoveParamsSchema.parse(input),
        ),
      );
    },
    async setRly0RelayEnabled(input: Rly0RelaySetEnabledParams): Promise<Rly0RelayMutationResult> {
      return rly0RelayMutationResultSchema.parse(
        await manager.sendRequest(
          RLY0_RELAY_SET_ENABLED_METHOD,
          rly0RelaySetEnabledParamsSchema.parse(input),
        ),
      );
    },
    async testRly0Relay(input: Rly0RelayTestParams): Promise<Rly0RelayTestResult> {
      return rly0RelayTestResultSchema.parse(
        await manager.sendRequest(RLY0_RELAY_TEST_METHOD, rly0RelayTestParamsSchema.parse(input)),
      );
    },
    async rly0ProxyStart(input: Rly0ProxyStartParams = {}): Promise<Rly0ProxyStatusResult> {
      return rly0ProxyStatusResultSchema.parse(
        await manager.sendRequest(RLY0_PROXY_START_METHOD, rly0ProxyStartParamsSchema.parse(input)),
      );
    },
    async rly0ProxyStop(): Promise<Rly0ProxyStopResult> {
      return rly0ProxyStopResultSchema.parse(await manager.sendRequest(RLY0_PROXY_STOP_METHOD, {}));
    },
    async rly0ProxyStatus(): Promise<Rly0ProxyStatusResult> {
      return rly0ProxyStatusResultSchema.parse(
        await manager.sendRequest(RLY0_PROXY_STATUS_METHOD, {}),
      );
    },
    async rly0RelayModelCatalogStatus(
      input: Rly0RelayModelCatalogStatusParams = {},
    ): Promise<Rly0RelayModelCatalogStatusResult> {
      return rly0RelayModelCatalogStatusResultSchema.parse(
        await manager.sendRequest(
          RLY0_RELAY_MODEL_CATALOG_STATUS_METHOD,
          rly0RelayModelCatalogStatusParamsSchema.parse(input),
        ),
      );
    },
    async rly0RelayCodexConfigStatus(): Promise<Rly0RelayCodexConfigStatusResult> {
      return rly0RelayCodexConfigStatusResultSchema.parse(
        await manager.sendRequest(RLY0_RELAY_CODEX_CONFIG_STATUS_METHOD, {}),
      );
    },
    async rly0RelayCodexConfigApply(
      input: Rly0RelayCodexConfigApplyParams,
    ): Promise<Rly0RelayCodexConfigMutationResult> {
      return rly0RelayCodexConfigMutationResultSchema.parse(
        await manager.sendRequest(
          RLY0_RELAY_CODEX_CONFIG_APPLY_METHOD,
          rly0RelayCodexConfigApplyParamsSchema.parse(input),
        ),
      );
    },
    async rly0RelayCodexConfigRestore(): Promise<Rly0RelayCodexConfigMutationResult> {
      return rly0RelayCodexConfigMutationResultSchema.parse(
        await manager.sendRequest(RLY0_RELAY_CODEX_CONFIG_RESTORE_METHOD, {}),
      );
    },
  });
}
