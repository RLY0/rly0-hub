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
