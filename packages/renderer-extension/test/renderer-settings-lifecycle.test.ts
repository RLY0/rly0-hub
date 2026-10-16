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

  it("opens the dashboard on launch until the welcome card is dismissed, waiting for the rail button", async () => {
    const store = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    const button = { tagName: "BUTTON" };
    const root = { isConnected: false, querySelector: () => button };
    const openSettings = vi.fn();
    const shellMock = {
      supported: true,
      open: false,
      activePageId: undefined,
      openSettings,
      close: shellClose,
      dispose: vi.fn(),
    };
    const triggerMock = {
      root,
      refresh: triggerRefresh,
      setUpdateAvailable: triggerSetUpdateAvailable,
      dispose: vi.fn(),
    };
    vi.mocked(installRendererSettingsShell).mockReturnValue(shellMock as never);
    vi.mocked(installRendererSettingsRailTrigger).mockReturnValue(triggerMock as never);
    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: {},
      localStorage,
      setTimeout,
      clearTimeout,
    } as unknown as Window;
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    };

    // The rail button is not on the page yet: nothing opens, and a later refresh retries.
    const first = installRendererSettingsLifecycle(ownerWindow);
    await settle();
    expect(openSettings).not.toHaveBeenCalled();
    root.isConnected = true;
    first.refresh();
    await vi.waitFor(() => expect(openSettings).toHaveBeenCalledWith(button, "dashboard"));
    // Only once per launch.
    openSettings.mockClear();
    first.refresh();
    await settle();
    expect(openSettings).not.toHaveBeenCalled();
    first.dispose();

    // Next launch, still not dismissed: it opens again.
    const second = installRendererSettingsLifecycle(ownerWindow);
    await vi.waitFor(() => expect(openSettings).toHaveBeenCalledWith(button, "dashboard"));
    second.dispose();

    // Once the welcome card was dismissed, it never opens by itself again.
    store.set(RLY0_WELCOME_DISMISSED_STORAGE_KEY, "1");
    openSettings.mockClear();
    const third = installRendererSettingsLifecycle(ownerWindow);
    third.refresh();
    await settle();
    expect(openSettings).not.toHaveBeenCalled();
    third.dispose();
  });
});
