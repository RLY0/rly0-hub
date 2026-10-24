import { harnessIdSchema } from "@codexhost/shared-contracts";
import { RLY0_WELCOME_DISMISSED_STORAGE_KEY } from "../src/settings/rly0-welcome.js";
import { hostThreadIdSchema, type UpdateCheckResult } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const triggerRefresh = vi.fn(() => true);
const triggerSetUpdateAvailable = vi.fn();
const shellClose = vi.fn();

vi.mock("../src/codex-locale-adapter.js", () => ({
  readCodexLocaleSettings: vi.fn(async () => ({ preferredLocale: "en" })),
}));

vi.mock("../src/settings/localization.js", () => ({
  rendererSettingsMessages: vi.fn(() => ({})),
  resolveRendererSettingsLocale: vi.fn((languageTags: readonly string[]) =>
    languageTags[0]?.toLowerCase().startsWith("zh") ? "zh-CN" : "en",
  ),
}));

vi.mock("../src/settings/pages.js", () => ({
  createDefaultRendererSettingsPages: vi.fn(() => []),
}));

vi.mock("../src/settings/shell.js", () => ({
  installRendererSettingsShell: vi.fn(() => ({
    supported: true,
    open: false,
    activePageId: undefined,
    openSettings: vi.fn(),
    close: shellClose,
    dispose: vi.fn(),
  })),
}));

vi.mock("../src/settings/trigger.js", () => ({
  installRendererSettingsRailTrigger: vi.fn(() => ({
    root: null,
    refresh: triggerRefresh,
    setUpdateAvailable: triggerSetUpdateAvailable,
    dispose: vi.fn(),
  })),
}));

import { installRendererSettingsLifecycle } from "../src/renderer-settings-lifecycle.js";
import { createDefaultRendererSettingsPages } from "../src/settings/pages.js";
import { installRendererSettingsShell } from "../src/settings/shell.js";
import { installRendererSettingsRailTrigger } from "../src/settings/trigger.js";

function failedUpdateCheck(): UpdateCheckResult {
  return {
    currentVersion: "0.3.2",
    installation: "npm",
    latestVersion: null,
    updateAvailable: false,
    installationAvailable: false,
    releaseNotes: null,
    releaseNotesUrl: null,
    status: null,
    error: "Update metadata is temporarily unavailable",
  };
}

type UpdateClientStub = ReturnType<typeof updateClient>;

function updateClient(check: () => Promise<UpdateCheckResult | null>) {
  return { checkUpdate: vi.fn(check), startUpdate: vi.fn(), readUpdateStatus: vi.fn() };
}

describe("Renderer Settings lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("notifies consumers when the resolved Codex locale changes", async () => {
    const onLocaleChange = vi.fn();
    const ownerWindow = {
      navigator: { languages: ["zh-CN"] },
      document: {},
      setTimeout,
      clearTimeout,
    } as unknown as Window;

    const lifecycle = installRendererSettingsLifecycle(ownerWindow, { onLocaleChange });
    await Promise.resolve();
    await Promise.resolve();

    expect(onLocaleChange).toHaveBeenCalledWith("en");
    lifecycle.dispose();
  });

  it("does not bypass update backoff when DOM reconciliation refreshes repeatedly", async () => {
    vi.useFakeTimers();
    const checkUpdate = vi.fn(async () => failedUpdateCheck());
    const client = {
      checkUpdate,
      startUpdate: vi.fn(),
      readUpdateStatus: vi.fn(),
    };
    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: {},
      setTimeout,
      clearTimeout,
    } as unknown as Window;

    const lifecycle = installRendererSettingsLifecycle(ownerWindow, {
      getUpdateClient: () => client,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 50; index += 1) lifecycle.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(checkUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkUpdate).toHaveBeenCalledTimes(2);

    lifecycle.dispose();
  });

  function installWithClients(clients: { current: UpdateClientStub }) {
    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: {},
      setTimeout,
      clearTimeout,
    } as unknown as Window;
    return installRendererSettingsLifecycle(ownerWindow, {
      getUpdateClient: () => clients.current,
    });
  }

  it("treats a null update check as final and clears the indicator", async () => {
    vi.useFakeTimers();
    const client = updateClient(async () => null);
    const lifecycle = installWithClients({ current: client });
    await vi.advanceTimersByTimeAsync(0);
    expect(triggerSetUpdateAvailable).toHaveBeenLastCalledWith(false);

    for (let index = 0; index < 20; index += 1) lifecycle.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    lifecycle.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it.each([
    ["a structured error", async () => failedUpdateCheck()],
    ["a rejected request", async () => Promise.reject(new Error("unavailable"))],
  ])("stops refresh-driven checks after retries are exhausted by %s", async (_, check) => {
    vi.useFakeTimers();
    const clients = { current: updateClient(check) };
    const failing = clients.current;
    const lifecycle = installWithClients(clients);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing.checkUpdate).toHaveBeenCalledTimes(5);

    for (let index = 0; index < 20; index += 1) lifecycle.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing.checkUpdate).toHaveBeenCalledTimes(5);

    clients.current = updateClient(async () => ({
      ...failedUpdateCheck(),
      latestVersion: "0.3.3",
      updateAvailable: true,
      error: null,
    }));
    lifecycle.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients.current.checkUpdate).toHaveBeenCalledTimes(1);
    expect(triggerSetUpdateAvailable).toHaveBeenLastCalledWith(true);

    for (let index = 0; index < 20; index += 1) lifecycle.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients.current.checkUpdate).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it("passes the local statistics transport to settings pages", () => {
    const requestUsageStatistics = vi.fn(async () => ({}));
    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: {},
      setTimeout,
      clearTimeout,
    } as unknown as Window;
    const lifecycle = installRendererSettingsLifecycle(ownerWindow, { requestUsageStatistics });
    expect(vi.mocked(createDefaultRendererSettingsPages).mock.calls.at(-1)?.[8]).toBe(
      requestUsageStatistics,
    );
    lifecycle.dispose();
  });

  it("binds Session import to its narrow client and closes only after navigation", async () => {
    const events: string[] = [];
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi.fn(),
      importHarnessSession: vi.fn(),
    };
    const openImportedThread = vi.fn(async () => {
      events.push("opened");
    });
    shellClose.mockImplementation(() => events.push("closed"));
    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: {},
      setTimeout,
      clearTimeout,
    } as unknown as Window;
    const lifecycle = installRendererSettingsLifecycle(ownerWindow, {
      getSessionImportClient: () => client,
      openImportedThread,
    });
    const call = vi.mocked(createDefaultRendererSettingsPages).mock.calls.at(-1);
    const getClient = call?.[4];
    const open = call?.[5];
    if (!getClient || !open) throw new Error("Session Import settings seams were not installed");

    expect(getClient()).toBe(client);
    await open(hostThreadIdSchema.parse("imported-thread"), new AbortController().signal);

    expect(openImportedThread).toHaveBeenCalledWith("imported-thread", expect.any(AbortSignal));
    expect(events).toEqual(["opened", "closed"]);
    lifecycle.dispose();
  });

  function hubFixture(available: boolean) {
    const openSettings = vi.fn(() => true);
    const button = { isConnected: true, setAttribute: vi.fn() };
    const listeners = new Map<string, (e: { preventDefault(): void }) => void>();
    const root = {
      isConnected: true,
      querySelector: () => button,
      addEventListener: (name: string, callback: (e: { preventDefault(): void }) => void) =>
        listeners.set(name, callback),
    };
    const shell = {
      supported: true,
      open: false,
      openSettings,
      close: shellClose,
      dispose: vi.fn(),
    };
    // Like the real shell, every install returns a fresh object.
    vi.mocked(installRendererSettingsShell).mockImplementation(
      () =>
        ({
          ...shell,
          openSettings: (...args: unknown[]) => openSettings(...(args as [])),
        }) as never,
    );
    vi.mocked(installRendererSettingsRailTrigger).mockReturnValue({
      root,
      refresh: triggerRefresh,
      setUpdateAvailable: triggerSetUpdateAvailable,
      dispose: vi.fn(),
    } as never);
    vi.mocked(createDefaultRendererSettingsPages).mockReturnValue(
      [
        "dashboard",
        "connections",
        "accounts",
        "session-import",
        "appearance",
        "mcp",
        "skills",
        "threads",
        "maintenance",
        "updates",
      ].map((id) => ({ id })) as never,
    );
    const store = new Map([[RLY0_WELCOME_DISMISSED_STORAGE_KEY, "1"]]);
    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: {},
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
      setTimeout,
      clearTimeout,
      alert: vi.fn(),
    } as unknown as Window;
    const client = {
      rly0HubStatus: vi.fn(async () => ({ available })),
      rly0OpenHub: vi.fn(async () => ({ available, ok: available })),
    };
    return { ownerWindow, client, openSettings, shell, button, listeners, store };
  }

  it("opens the Hub on rail activation and has no Codex-side menu", async () => {
    const f = hubFixture(true);
    const lifecycle = installRendererSettingsLifecycle(f.ownerWindow, {
      getHubClient: () => f.client,
    });
    await vi.waitFor(() => expect(installRendererSettingsShell).toHaveBeenCalled());
    const definitions = vi.mocked(installRendererSettingsShell).mock.calls.at(-1)?.[0];
    expect(definitions?.map((p) => p.id)).toEqual([
      "connections",
      "accounts",
      "session-import",
      "appearance",
    ]);
    const onOpen = vi.mocked(installRendererSettingsRailTrigger).mock.calls.at(-1)?.[0].onOpen;
    onOpen?.(f.button as unknown as HTMLButtonElement);
    await vi.waitFor(() => expect(f.client.rly0OpenHub).toHaveBeenCalledTimes(1));
    expect(f.openSettings).not.toHaveBeenCalled();
    // No Codex-side menu any more: right-click does nothing, everything lives in the Hub.
    expect(f.listeners.get("contextmenu")).toBeUndefined();
    lifecycle.dispose();
  });

  it("keeps Codex-only upstream pages in Codex while the Hub is present", async () => {
    const f = hubFixture(true);
    const lifecycle = installRendererSettingsLifecycle(f.ownerWindow, {
      getHubClient: () => f.client,
    });
    await vi.waitFor(() => expect(f.client.rly0HubStatus).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(installRendererSettingsShell)
          .mock.calls.at(-1)?.[0]
          ?.some((p) => p.id === "mcp"),
      ).toBe(false),
    );
    const shell = vi.mocked(installRendererSettingsShell).mock.results.at(-1)?.value as {
      openSettings(opener?: HTMLElement, pageId?: string): boolean;
    };
    shell.openSettings(undefined, "remote-connections");
    shell.openSettings(undefined, "usage-statistics");
    expect(f.openSettings).toHaveBeenCalledTimes(2);
    expect(f.client.rly0OpenHub).not.toHaveBeenCalled();
    shell.openSettings(undefined, "accounts");
    await vi.waitFor(() => expect(f.client.rly0OpenHub).toHaveBeenCalledTimes(1));
    expect(f.openSettings).toHaveBeenCalledTimes(2);
    lifecycle.dispose();
  });

  it("uses embedded settings only when the Host confirms the Hub is absent", async () => {
    const f = hubFixture(false);
    const lifecycle = installRendererSettingsLifecycle(f.ownerWindow, {
      getHubClient: () => f.client,
    });
    await vi.waitFor(() => expect(installRendererSettingsShell).toHaveBeenCalled());
    vi.mocked(installRendererSettingsRailTrigger)
      .mock.calls.at(-1)?.[0]
      .onOpen(f.button as unknown as HTMLButtonElement);
    await vi.waitFor(() => expect(f.openSettings).toHaveBeenCalled());
    expect(f.client.rly0OpenHub).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(installRendererSettingsShell)
        .mock.calls.at(-1)?.[0]
        ?.some((p) => p.id === "mcp"),
    ).toBe(true);
    lifecycle.dispose();
  });

  it("falls back to the full settings when the Hub cannot be opened, never to a dead end", async () => {
    const f = hubFixture(true);
    f.client.rly0OpenHub.mockRejectedValue(new Error("unavailable"));
    const lifecycle = installRendererSettingsLifecycle(f.ownerWindow, {
      getHubClient: () => f.client,
    });
    await vi.waitFor(() => expect(installRendererSettingsShell).toHaveBeenCalled());
    vi.mocked(installRendererSettingsRailTrigger)
      .mock.calls.at(-1)?.[0]
      .onOpen(f.button as unknown as HTMLButtonElement);
    await vi.waitFor(() => expect(f.openSettings).toHaveBeenCalled());
    expect(f.ownerWindow.alert).not.toHaveBeenCalled();
    lifecycle.dispose();

    // The availability check itself fails: settings stay mounted and the Hub is still tried.
    vi.mocked(installRendererSettingsShell).mockClear();
    f.openSettings.mockClear();
    f.client.rly0OpenHub.mockReset();
    f.client.rly0OpenHub.mockResolvedValue({ available: true, ok: true });
    f.client.rly0HubStatus.mockRejectedValue(new Error("offline"));
    const second = installRendererSettingsLifecycle(f.ownerWindow, {
      getHubClient: () => f.client,
    });
    await vi.waitFor(() => expect(installRendererSettingsShell).toHaveBeenCalled());
    vi.mocked(installRendererSettingsRailTrigger)
      .mock.calls.at(-1)?.[0]
      .onOpen(f.button as unknown as HTMLButtonElement);
    await vi.waitFor(() => expect(f.client.rly0OpenHub).toHaveBeenCalled());
    expect(f.openSettings).not.toHaveBeenCalled();
    expect(f.ownerWindow.alert).not.toHaveBeenCalled();
    second.dispose();
  });

  it("welcome opens only the independent Hub once per launch", async () => {
    const f = hubFixture(true);
    f.store.clear();
    const lifecycle = installRendererSettingsLifecycle(f.ownerWindow, {
      getHubClient: () => f.client,
    });
    await vi.waitFor(() => expect(f.client.rly0OpenHub).toHaveBeenCalledTimes(1));
    lifecycle.refresh();
    lifecycle.refresh();
    await Promise.resolve();
    expect(f.client.rly0OpenHub).toHaveBeenCalledTimes(1);
    expect(f.openSettings).not.toHaveBeenCalled();
    lifecycle.dispose();
    const source = hubFixture(false);
    source.store.clear();
    const fallback = installRendererSettingsLifecycle(source.ownerWindow, {
      getHubClient: () => source.client,
    });
    await vi.waitFor(() => expect(source.client.rly0HubStatus).toHaveBeenCalled());
    fallback.refresh();
    await Promise.resolve();
    expect(source.openSettings).not.toHaveBeenCalled();
    fallback.dispose();
  });
});
