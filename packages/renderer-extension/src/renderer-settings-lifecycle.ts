import { consumePendingNewChat, openNewChatWith } from "./settings/rly0-quick-start.js";
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
  installRendererSettingsRailTrigger,
  type RendererSettingsRailTriggerControl,
} from "./settings/trigger.js";

const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const UPDATE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;
export const RLY0_WELCOME_STORAGE_KEY = "rly0-hub:welcome-shown";

export interface RendererHubClient {
  rly0HubStatus?(): Promise<{ available: boolean }>;
  rly0OpenHub?(): Promise<{ available: boolean; ok: boolean }>;
}

export const CODEX_ONLY_SETTINGS_PAGES = [
  "connections",
  "accounts",
  "session-import",
  "appearance",
] as const;

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
  const toolRoots = new WeakSet<HTMLElement>();

  const openHub = async (): Promise<void> => {
    const client = options.getHubClient?.();
    if (!client?.rly0OpenHub) throw new Error("HUB_UNAVAILABLE");
    const result = await client.rly0OpenHub();
    if (!result.ok) throw new Error("HUB_OPEN_FAILED");
  };

  const bindCodexTools = (): void => {
    const root = trigger?.root;
    if (!root || !hubAvailable || toolRoots.has(root)) return;
    toolRoots.add(root);
    root
      .querySelector("button")
      ?.setAttribute(
        "aria-description",
        locale === "zh-CN"
          ? "右键打开 Codex 内工具：连接、账号登录、会话导入、界面偏好"
          : "Right-click for Codex tools: connections, sign-in, session import and preferences",
      );
    root.addEventListener(
      "contextmenu",
      (event) => {
        event.preventDefault();
        shell?.openSettings(
          root.querySelector<HTMLButtonElement>("button") ?? undefined,
          "connections",
        );
      },
      { signal: lifecycleController.signal },
    );
  };

  const mount = (): {
    shell: RendererSettingsShell | null;
    trigger: RendererSettingsRailTriggerControl;
  } => {
    const messages = rendererSettingsMessages(locale);
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
      options.getMcpClient ?? (() => null),
      options.getSkillsClient ?? (() => null),
      options.getDashboardClient ?? (() => null),
      options.getThreadsClient ?? (() => null),
      options.getMaintenanceClient ?? (() => null),
      options.getAppearanceClient ?? (() => null),
      options.getRelayClient ?? (() => null),
      hubAvailable === true,
    );
    const selectedPages = hubAvailable
      ? definitions.filter((page) =>
          (CODEX_ONLY_SETTINGS_PAGES as readonly string[]).includes(page.id),
        )
      : definitions;
    const nextShell =
      hubAvailable === null
        ? null
        : installRendererSettingsShell(selectedPages, messages, ownerWindow.document);
    if (nextShell && hubAvailable) {
      const openTools = nextShell.openSettings.bind(nextShell);
      nextShell.openSettings = (opener, pageId) => {
        if (pageId && (CODEX_ONLY_SETTINGS_PAGES as readonly string[]).includes(pageId))
          return openTools(opener, pageId);
        void openHub().catch(() => undefined);
        return true;
      };
    }
    const nextTrigger = installRendererSettingsRailTrigger({
      available: nextShell?.supported ?? true,
      messages,
      ownerDocument: ownerWindow.document,
      onOpen(opener, pageId) {
        const generation = ++openGeneration;
        void refreshLocale().then(async () => {
          if (disposed || generation !== openGeneration) return;
          const currentOpener = opener.isConnected
            ? opener
            : (trigger?.root?.querySelector<HTMLButtonElement>("button") ?? undefined);
          await refreshHubAvailability();
          if (disposed || generation !== openGeneration) return;
          if (hubAvailable) {
            try {
              await openHub();
            } catch {
              ownerWindow.alert(
                locale === "zh-CN"
                  ? "没能打开 RLY/0 Hub，请从托盘或开始菜单打开。"
                  : "Could not open RLY/0 Hub. Open it from the tray or Start menu.",
              );
            }
          } else if (hubAvailable === false) shell?.openSettings(currentOpener, pageId);
          else
            ownerWindow.alert(
              locale === "zh-CN"
                ? "无法连接 RLY/0 服务，请稍后重试。"
                : "RLY/0 service is unavailable. Try again later.",
            );
        });
      },
    });
    nextTrigger.setUpdateAvailable(updateAvailable);
    shell = nextShell;
    trigger = nextTrigger;
    bindCodexTools();
    return { shell: nextShell, trigger: nextTrigger };
  };

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
        updateAvailable = result.updateAvailable;
        trigger?.setUpdateAvailable(updateAvailable);
        if (result.error === null) {
          updateRetryAttempt = 0;
          clearUpdateRetry();
          return;
        }
        checkedUpdateClient = null;
        scheduleUpdateRetry(client);
      })
      .catch(() => {
        if (disposed || generation !== updateCheckGeneration || checkedUpdateClient !== client) {
          return;
        }
        checkedUpdateClient = null;
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
    if (hubAvailable) void openHub().catch(() => undefined);
  };
  void refreshHubAvailability().then(maybeShowWelcome);
  maybeShowWelcome();

  return {
    get locale() {
      return locale;
    },
    refresh() {
      const refreshed = trigger?.refresh() ?? false;
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
      clearUpdateRetry();
      trigger?.dispose();
      shell?.dispose();
      trigger = null;
      shell = null;
    },
  };
}
