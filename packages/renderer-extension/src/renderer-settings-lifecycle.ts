import { consumePendingNewChat, openNewChatWith } from "./settings/rly0-quick-start.js";
import type { RendererUsageStatisticsRequest } from "./console/pages/usage-statistics.js";
import type { RemoteConnectionsControl } from "./remote-connections-control.js";
import type { LoadedSessionsClient } from "./settings/loaded-sessions-table.js";
import { RLY0_WELCOME_DISMISSED_STORAGE_KEY } from "./settings/rly0-welcome.js";
import { readCodexLocaleSettings, type CodexLocaleSettings } from "./codex-locale-adapter.js";
import {
  applyRendererAccentColor,
  readRendererAccentColor,
} from "./renderer-appearance-preferences.js";
import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
  type RendererSettingsLocale,
} from "./settings/localization.js";
import {
  createDefaultRendererSettingsPages,
  type RendererConnectionDiagnostics,
  type RendererCodexAccountClient,
  type RendererMcpClient,
  type RendererSkillsClient,
  type RendererDashboardClient,
  type RendererThreadsClient,
  type RendererMaintenanceClient,
  type RendererAppearanceClient,
  type RendererRelayClient,
  type RendererUpdateClient,
} from "./settings/pages.js";
import type {
  RendererSessionImportClient,
  RendererImportedThreadOpener,
} from "./settings/session-import-page.js";
import { installRendererSettingsShell, type RendererSettingsShell } from "./settings/shell.js";
import {
  hubPageForSettingsPage,
  showHubUnavailableNotice,
  type HubUnavailableNotice,
} from "./settings/hub-routing.js";
import type { Rly0CodexPreferences, Rly0HubPage } from "@codexhost/shared-contracts";
import { applyCodexPreferences } from "./renderer-codex-preferences.js";
import {
  installRendererSettingsRailTrigger,
  type RendererSettingsRailTriggerControl,
} from "./settings/trigger.js";

const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const UPDATE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;
export const RLY0_WELCOME_STORAGE_KEY = "rly0-hub:welcome-shown";

export interface RendererHubClient {
  rly0HubStatus?(): Promise<{ available: boolean }>;
  rly0CodexPreferences?(): Promise<{ preferences: Rly0CodexPreferences | null }>;
  rly0OpenHub?(params?: { page?: Rly0HubPage }): Promise<{ available: boolean; ok: boolean }>;
}

/**
 * What the agent picker and other in-Codex entries call (`window.__codexhostSettingsShellV1`)
 * while the Hub is installed: there is no settings surface in Codex then, so every page ID opens
 * the matching Hub page (settings/hub-routing.ts).
 */
interface HubRouteHandle {
  readonly supported: true;
  readonly open: false;
  readonly activePageId: string;
  readonly registry: {
    readonly pages: readonly never[];
    readonly defaultPageId: string;
    getPage(pageId: string): { readonly id: string; readonly label: string } | undefined;
  };
  openSettings(opener?: HTMLElement, pageId?: string): boolean;
  close(): void;
  dispose(): void;
}

export interface RendererSettingsLifecycleOptions {
  getHubClient?(): RendererHubClient | null;
  getUpdateClient?(): RendererUpdateClient | null;
  getConnectionDiagnostics?(): RendererConnectionDiagnostics | null;
  getAccountClient?(): RendererCodexAccountClient | null;
  getSessionImportClient?(): RendererSessionImportClient | null;
  getLoadedSessionsClient?(): LoadedSessionsClient | null;
  getMcpClient?(): RendererMcpClient | null;
  getSkillsClient?(): RendererSkillsClient | null;
  getDashboardClient?(): RendererDashboardClient | null;
  getThreadsClient?(): RendererThreadsClient | null;
  getMaintenanceClient?(): RendererMaintenanceClient | null;
  getAppearanceClient?(): RendererAppearanceClient | null;
  getRelayClient?(): RendererRelayClient | null;
  getRemoteConnections?(): RemoteConnectionsControl | null;
  requestUsageStatistics?: RendererUsageStatisticsRequest;
  openImportedThread?: RendererImportedThreadOpener;
  onLocaleChange?(locale: RendererSettingsLocale): void;
}

export interface RendererSettingsLifecycleControl {
  readonly locale: RendererSettingsLocale;
  refresh(): boolean;
  dispose(): void;
}

export function installRendererSettingsLifecycle(
  ownerWindow: Window = window,
  options: RendererSettingsLifecycleOptions = {},
): RendererSettingsLifecycleControl {
  const lifecycleController = new AbortController();
  let locale = resolveRendererSettingsLocale(ownerWindow.navigator.languages);
  let shell: RendererSettingsShell | null = null;
  let trigger: RendererSettingsRailTriggerControl | null = null;
  let localeRequest: Promise<void> | null = null;
  let checkedUpdateClient: RendererUpdateClient | null = null;
  let retryUpdateClient: RendererUpdateClient | null = null;
  let updateRetryTimer: number | null = null;
  let updateRetryAttempt = 0;
  let updateCheckGeneration = 0;
  let updateAvailable = false;
  let openGeneration = 0;
  let disposed = false;
  let hubAvailable: boolean | null = options.getHubClient ? null : false;
  let checkedHubClient: RendererHubClient | null = null;
  let hubRequest: Promise<void> | null = null;

  let hubHandle: HubRouteHandle | null = null;
  let notice: HubUnavailableNotice | null = null;

  const openHub = async (page: Rly0HubPage = "home"): Promise<void> => {
    const client = options.getHubClient?.();
    if (!client?.rly0OpenHub) throw new Error("HUB_UNAVAILABLE");
    const result = await client.rly0OpenHub({ page });
    if (!result.ok) throw new Error("HUB_OPEN_FAILED");
  };

  /**
   * Opens the Hub on the page matching `pageId`. When it cannot be reached, Codex shows one short
   * notice with a retry, never the former settings surface; the next attempt checks again.
   */
  const routeToHub = (opener: HTMLElement | undefined, pageId: string | undefined): void => {
    const page = hubPageForSettingsPage(pageId);
    notice?.dispose();
    notice = null;
    void openHub(page).catch(() => {
      if (disposed) return;
      checkedHubClient = null;
      notice = showHubUnavailableNotice(ownerWindow.document, locale, opener, () =>
        openHub(page).then(
          () => true,
          () => false,
        ),
      );
    });
  };

  const installHubHandle = (messages: ReturnType<typeof rendererSettingsMessages>): void => {
    const labels = messages.pageLabels as Readonly<Record<string, string>>;
    const handle: HubRouteHandle = {
      supported: true,
      open: false,
      activePageId: "dashboard",
      registry: {
        pages: [],
        defaultPageId: "dashboard",
        getPage: (pageId) => (labels[pageId] ? { id: pageId, label: labels[pageId] } : undefined),
      },
      openSettings(opener, pageId) {
        if (disposed || hubHandle !== handle) return false;
        routeToHub(opener, pageId);
        return true;
      },
      close: () => undefined,
      dispose() {
        if (hubHandle === handle) hubHandle = null;
        const owner = ownerWindow as unknown as { __codexhostSettingsShellV1?: unknown };
        if (owner.__codexhostSettingsShellV1 === handle) delete owner.__codexhostSettingsShellV1;
      },
    };
    hubHandle?.dispose();
    hubHandle = handle;
    (
      ownerWindow as unknown as { __codexhostSettingsShellV1?: unknown }
    ).__codexhostSettingsShellV1 = handle;
  };

  /** The in-Codex settings, for builds without the Hub window only. */
  const mountCodexSettings = (
    messages: ReturnType<typeof rendererSettingsMessages>,
  ): RendererSettingsShell | null => {
    const definitions = createDefaultRendererSettingsPages(
      messages,
      options.getUpdateClient ?? (() => null),
      options.getConnectionDiagnostics ?? (() => null),
      options.getAccountClient ?? (() => null),
      options.getSessionImportClient ?? (() => null),
      async (threadId, signal) => {
        if (!options.openImportedThread) {
          throw new Error("Imported Thread navigation is unavailable");
        }
        await options.openImportedThread(threadId, signal);
        if (!disposed && !signal.aborted) shell?.close();
      },
      options.getLoadedSessionsClient ?? (() => null),
      options.getRemoteConnections ?? (() => null),
      options.requestUsageStatistics,
      options.getMcpClient ?? (() => null),
      options.getSkillsClient ?? (() => null),
      options.getDashboardClient ?? (() => null),
      options.getThreadsClient ?? (() => null),
      options.getMaintenanceClient ?? (() => null),
      options.getAppearanceClient ?? (() => null),
      options.getRelayClient ?? (() => null),
      false,
    );
    return installRendererSettingsShell(definitions, messages, ownerWindow.document, {
      onOpenChange(open) {
        trigger?.setSelected(open);
      },
    });
  };

  // Everything that used to open inside Codex (connections, sign-in, session import,
  // preferences) now lives in the standalone RLY/0 Hub, so there is no right-click menu here.
  const bindCodexTools = (): void => undefined;

  const mount = (): {
    shell: RendererSettingsShell | null;
    trigger: RendererSettingsRailTriggerControl;
  } => {
    const messages = rendererSettingsMessages(locale);
    hubHandle?.dispose();
    // The Hub window holds every page that used to open here. Only a build without the Hub
    // (a source checkout, other platforms), as the Host confirms, keeps the in-Codex settings.
    const nextShell = hubAvailable === false ? mountCodexSettings(messages) : null;
    if (!nextShell) installHubHandle(messages);
    const nextTrigger = installRendererSettingsRailTrigger({
      available: true,
      messages,
      ownerDocument: ownerWindow.document,
      onOpen(opener, pageId) {
        // Like a native destination, the current page ignores repeat activation.
        if (shell?.open) return;
        const generation = ++openGeneration;
        void refreshLocale().then(async () => {
          if (disposed || generation !== openGeneration) return;
          const currentOpener = opener.isConnected
            ? opener
            : (trigger?.root?.querySelector<HTMLButtonElement>("button") ?? undefined);
          await refreshHubAvailability();
          if (disposed || generation !== openGeneration) return;
          if (hubAvailable === false && shell) {
            shell.openSettings(currentOpener, pageId);
            return;
          }
          routeToHub(currentOpener, pageId);
        });
      },
    });
    nextTrigger.setUpdateAvailable(updateAvailable);
    shell = nextShell;
    trigger = nextTrigger;
    bindCodexTools();
    return { shell: nextShell, trigger: nextTrigger };
  };

  // Codex-side preferences now set in the Hub (设置 → 通用 → Codex 里): applied on start, on
  // reconnection and whenever Codex gets focus back (the person may just have changed them).
  let preferencesRequest: Promise<void> | null = null;
  const syncCodexPreferences = (): void => {
    const client = options.getHubClient?.();
    if (disposed || preferencesRequest || !client?.rly0CodexPreferences) return;
    const request = client
      .rly0CodexPreferences()
      .then((result) => {
        if (!disposed) applyCodexPreferences(ownerWindow, result.preferences);
      })
      .catch(() => undefined)
      .finally(() => {
        if (preferencesRequest === request) preferencesRequest = null;
      });
    preferencesRequest = request;
  };
  const onFocus = (): void => syncCodexPreferences();
  ownerWindow.addEventListener?.("focus", onFocus);

  const refreshHubAvailability = (): Promise<void> => {
    const client = options.getHubClient?.();
    if (!client?.rly0HubStatus || checkedHubClient === client)
      return hubRequest ?? Promise.resolve();
    if (hubRequest) return hubRequest;
    checkedHubClient = client;
    const request = client
      .rly0HubStatus()
      .then((result) => {
        if (disposed || options.getHubClient?.() !== client) return;
        if (hubAvailable !== result.available) {
          hubAvailable = result.available;
          trigger?.dispose();
          shell?.dispose();
          trigger = null;
          shell = null;
          mount();
        }
      })
      .catch(() => {
        checkedHubClient = null;
      })
      .finally(() => {
        if (hubRequest === request) hubRequest = null;
      });
    hubRequest = request;
    return request;
  };

  const applyLanguageState = (nextLocale: RendererSettingsLocale, preserveOpen: boolean): void => {
    if (disposed) return;
    if (locale === nextLocale) return;

    const reopen = preserveOpen && shell?.open === true;
    const activePageId = shell?.activePageId;
    locale = nextLocale;
    trigger?.dispose();
    shell?.dispose();
    trigger = null;
    shell = null;
    const mounted = mount();
    options.onLocaleChange?.(locale);

    if (reopen) {
      const opener = mounted.trigger.root?.querySelector<HTMLButtonElement>("button") ?? undefined;
      mounted.shell?.openSettings(opener, activePageId);
    }
  };

  const applyLocaleSettings = (settings: CodexLocaleSettings, preserveOpen: boolean): void => {
    applyLanguageState(resolveRendererSettingsLocale([settings.preferredLocale]), preserveOpen);
  };

  const refreshLocale = (): Promise<void> => {
    if (localeRequest) return localeRequest;
    const request = readCodexLocaleSettings({
      ownerWindow,
      signal: lifecycleController.signal,
    })
      .then((settings) => {
        applyLocaleSettings(settings, false);
      })
      .catch(() => {
        // The synchronously selected browser locale remains the safe fallback.
      })
      .finally(() => {
        if (localeRequest === request) localeRequest = null;
      });
    localeRequest = request;
    return request;
  };

  const clearUpdateRetry = (): void => {
    if (updateRetryTimer === null) return;
    ownerWindow.clearTimeout(updateRetryTimer);
    updateRetryTimer = null;
  };

  const scheduleUpdateRetry = (client: RendererUpdateClient): void => {
    if (disposed || updateRetryTimer !== null) return;
    const delay = UPDATE_RETRY_DELAYS_MS[updateRetryAttempt];
    if (delay === undefined) return;
    checkedUpdateClient = null;
    updateRetryAttempt += 1;
    updateRetryTimer = ownerWindow.setTimeout(() => {
      updateRetryTimer = null;
      if (disposed || options.getUpdateClient?.() !== client) return;
      refreshUpdateIndicator();
    }, delay);
  };

  const checkUpdateWithTimeout = (client: RendererUpdateClient) =>
    new Promise<Awaited<ReturnType<RendererUpdateClient["checkUpdate"]>>>((resolve, reject) => {
      const timeout = ownerWindow.setTimeout(
        () => reject(new Error("Update indicator check timed out")),
        UPDATE_CHECK_TIMEOUT_MS,
      );
      void client.checkUpdate().then(
        (result) => {
          ownerWindow.clearTimeout(timeout);
          resolve(result);
        },
        (error: unknown) => {
          ownerWindow.clearTimeout(timeout);
          reject(error);
        },
      );
    });

  const refreshUpdateIndicator = (): void => {
    const client = options.getUpdateClient?.() ?? null;
    if (!client || checkedUpdateClient === client) return;
    if (retryUpdateClient !== client) {
      clearUpdateRetry();
      retryUpdateClient = client;
      updateRetryAttempt = 0;
    } else if (updateRetryTimer !== null) {
      return;
    }
    checkedUpdateClient = client;
    const generation = ++updateCheckGeneration;
    void checkUpdateWithTimeout(client)
      .then((result) => {
        if (disposed || generation !== updateCheckGeneration) return;
        updateAvailable = result?.updateAvailable ?? false;
        trigger?.setUpdateAvailable(updateAvailable);
        if (result === null || result.error === null) {
          updateRetryAttempt = 0;
          clearUpdateRetry();
          return;
        }
        scheduleUpdateRetry(client);
      })
      .catch(() => {
        if (disposed || generation !== updateCheckGeneration || checkedUpdateClient !== client) {
          return;
        }
        scheduleUpdateRetry(client);
      });
  };

  try {
    applyRendererAccentColor(ownerWindow.document, readRendererAccentColor(ownerWindow));
  } catch {
    // Storage can be unavailable; the stylesheet falls back to RLY/0 signal orange.
  }
  mount();
  void refreshLocale();
  refreshUpdateIndicator();
  void refreshHubAvailability();
  syncCodexPreferences();

  // Welcome opens only the standalone Hub. A late rail or Host connection is retried on refresh.
  let welcomeChecked = false;
  const maybeShowWelcome = (): void => {
    if (welcomeChecked || disposed || hubAvailable === null || !trigger?.root?.isConnected) return;
    welcomeChecked = true;
    // A setup step restarted Codex to finish (e.g. Claude Code through a relay): open the chat it
    // was heading for instead of the dashboard.
    const pendingAgent = consumePendingNewChat(ownerWindow.document);
    if (pendingAgent) {
      openNewChatWith(ownerWindow.document, pendingAgent);
      return;
    }
    try {
      if (ownerWindow.localStorage.getItem(RLY0_WELCOME_DISMISSED_STORAGE_KEY) === "1") return;
      ownerWindow.localStorage.setItem(RLY0_WELCOME_STORAGE_KEY, new Date().toISOString());
    } catch {
      return;
    }
    // The welcome experience belongs to the independent Hub. Source builds only open settings on demand.
    if (hubAvailable) void openHub("home").catch(() => undefined);
  };
  void refreshHubAvailability().then(maybeShowWelcome);
  maybeShowWelcome();

  return {
    get locale() {
      return locale;
    },
    refresh() {
      const refreshed = trigger?.refresh() ?? false;
      syncCodexPreferences();
      refreshUpdateIndicator();
      void refreshHubAvailability().then(maybeShowWelcome);
      bindCodexTools();
      maybeShowWelcome();
      if (refreshed) maybeShowWelcome();
      return refreshed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      openGeneration += 1;
      updateCheckGeneration += 1;
      lifecycleController.abort();
      ownerWindow.removeEventListener?.("focus", onFocus);
      clearUpdateRetry();
      trigger?.dispose();
      shell?.dispose();
      hubHandle?.dispose();
      notice?.dispose();
      trigger = null;
      shell = null;
      notice = null;
    },
  };
}
