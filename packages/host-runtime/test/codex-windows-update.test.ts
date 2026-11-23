// Windows: the Hub brings Codex to the verified build the Store offers. Synthetic Store, winget and
// Codex only: never the real Store, winget, PowerShell or a running Codex.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexStoreHold,
  STORE_CANARY_FILE,
  type StoreUpdateDriver,
  type StoreUpdateSetting,
} from "../src/rly0-hub-service/codex-store-hold.js";
import {
  CODEX_STORE_PAGE_URL,
  WINGET_UPGRADE_ARGS,
  createWindowsCodexUpdateDriver,
  parseStoreUpdate,
  storeUpdateScript,
  windowsInputIdleMs,
  wingetResult,
  type WindowsCodexUpdateDriver,
} from "../src/rly0-hub-service/codex-windows-update.js";
import { CodexCompatibilityCatalog } from "../src/rly0-hub-service/codex-compat.js";
import {
  CodexUpdateManager,
  type CodexUpdateDriver,
} from "../src/rly0-hub-service/codex-update-manager.js";
import { Rly0HubStateStore } from "../src/rly0-hub-service/hub-state.js";
import type { UpdateHttpGet } from "../src/rly0-hub-service/hub-update-net.js";

const roots: string[] = [];
const managers: CodexUpdateManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function isolatedEnvironment(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return {
    root,
    environment: {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, "codex"),
      CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      CODEXHOST_DATA_DIR: path.join(root, "hub"),
      RLY0_MEMORY_DIR: path.join(root, "memory"),
      RLY0_SKIP_LEGACY_IMPORT: "1",
      RLY0_CODEX_UPDATE_CONTROL: "0",
    },
  };
}

/** 26.1117.4957 is a built-in verified Windows build; 26.1111.9664 (the real case) is not. */
const OLD = "26.1111.9664.0";
const VERIFIED = "26.1117.4957.0";
const UNVERIFIED_NEW = "26.1120.1.0";

async function windowsFixture(
  options: {
    current?: string;
    offered?: string;
    setting?: StoreUpdateSetting;
    enabled?: boolean;
  } = {},
) {
  const { root, environment } = await isolatedEnvironment("synthetic-codex-windows-update-");
  let now = 1_800_000_000_000;
  let current = options.current ?? OLD;
  let offered = options.offered ?? VERIFIED;
  let setting: StoreUpdateSetting = options.setting ?? "Enabled";
  let running = true;
  const store: StoreUpdateDriver = {
    readSetting: vi.fn(async () => setting),
    writeSetting: vi.fn(async (value) => {
      setting = value;
    }),
    offeredVersion: vi.fn(async () => offered),
  };
  let wingetFinish: ((value: "installed" | "no-update") => void) | null = null;
  let wingetFail: ((error: Error) => void) | null = null;
  const windows: WindowsCodexUpdateDriver = {
    storeUpdate: vi.fn(async () => "started" as const),
    wingetUpgrade: vi.fn(
      () =>
        new Promise<"installed" | "no-update">((resolve, reject) => {
          wingetFinish = resolve;
          wingetFail = reject;
        }),
    ),
    isRunning: vi.fn(async () => running),
    installationStopped: vi.fn(async () => !running),
    quit: vi.fn(async () => {
      running = false;
    }),
    reopen: vi.fn(async () => {
      running = true;
      return true;
    }),
    healthy: vi.fn(async () => true),
  };
  const busy = vi.fn<() => Promise<boolean | null>>(async () => false);
  const idle = vi.fn<() => Promise<boolean>>(async () => true);
  const state = new Rly0HubStateStore(environment);
  if (options.enabled === false)
    await state.update({
      codexUpdates: { defaulted: true, enabled: false, noticeAcknowledged: true },
    });
  const hold = new CodexStoreHold({ environment, driver: store, now: () => now });
  const catalog = new CodexCompatibilityCatalog({
    environment,
    installRoot: root,
    hubVersion: "0.11.54",
    platform: "win32",
  });
  const manager = new CodexUpdateManager({
    environment,
    state,
    catalog,
    driver: null,
    storeHold: hold,
    windowsDriver: windows,
    currentVersion: async () => current,
    busy,
    idle,
    now: () => now,
    idleMs: 10,
    sleep: async (ms) => {
      now += ms;
    },
  });
  managers.push(manager);
  /** Ticks until the idle window passed and the manager acted. */
  const passIdle = async () => {
    await manager.tick();
    now += 20;
    return manager.tick();
  };
  return {
    root,
    environment,
    manager,
    store,
    windows,
    busy,
    idle,
    hold,
    passIdle,
    advance: (ms: number) => {
      now += ms;
    },
    install: (version = VERIFIED) => {
      current = version;
    },
    offer: (version: string) => {
      offered = version;
    },
    setting: () => setting,
    running: () => running,
    closeCodex: () => {
      running = false;
    },
    winget: {
      finish: (value: "installed" | "no-update") => wingetFinish?.(value),
      fail: () => wingetFail?.(new Error("synthetic winget failure")),
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("Windows: update Codex to the verified Store build", () => {
  it("unverified old build + verified offer: waits for idle, closes, updates, confirms, reopens", async () => {
    const f = await windowsFixture();
    f.idle.mockResolvedValue(false);
    const first = await f.manager.check();
    expect(first).toMatchObject({
      phase: "waiting-idle",
      currentVersion: OLD,
      latestVersion: VERIFIED,
      verifiedUpdate: VERIFIED,
      store: { mode: "following" },
      error: null,
      renderer: { mode: "core" },
    });
    expect(first.requested).toBeUndefined();
    // Busy: nothing is closed.
    await f.passIdle();
    expect(f.windows.quit).not.toHaveBeenCalled();
    f.idle.mockResolvedValue(true);
    const installing = await f.passIdle();
    expect(installing).toMatchObject({ phase: "installing", updateRoute: "store" });
    expect(f.windows.quit).toHaveBeenCalledTimes(1);
    expect(f.windows.storeUpdate).toHaveBeenCalledTimes(1);
    expect(f.windows.wingetUpgrade).not.toHaveBeenCalled();
    // The Store's word is not success: the installed version is.
    expect((await f.manager.tick()).phase).toBe("installing");
    expect(f.windows.reopen).not.toHaveBeenCalled();
    f.install();
    const checking = await f.manager.tick();
    expect(checking.phase).toBe("health-check");
    expect(checking.currentVersion).toBe(VERIFIED);
    expect(f.windows.reopen).toHaveBeenCalledTimes(1);
    const done = await f.manager.tick();
    expect(done).toMatchObject({ phase: "up-to-date", error: null, renderer: { mode: "full" } });
    expect(done.verifiedUpdate).toBeUndefined();
    // The global Store switch was never touched for this.
    expect(f.store.writeSetting).not.toHaveBeenCalled();
  });

  it("updates Codex alone even when the person keeps Store auto-update off (user-off)", async () => {
    const f = await windowsFixture({ setting: "Disabled" });
    await f.manager.check();
    const installing = await f.passIdle();
    expect(installing).toMatchObject({ phase: "installing", store: { mode: "following" } });
    expect(f.setting()).toBe("Disabled");
    expect(f.store.writeSetting).not.toHaveBeenCalled();
  });

  it("falls back to winget when the Store queue fails, then succeeds", async () => {
    const f = await windowsFixture();
    vi.mocked(f.windows.storeUpdate).mockRejectedValue(new Error("CODEX_STORE_UPDATE_FAILED"));
    await f.manager.check();
    const installing = await f.passIdle();
    expect(installing).toMatchObject({ phase: "installing", updateRoute: "winget" });
    expect(f.windows.wingetUpgrade).toHaveBeenCalledTimes(1);
    f.winget.finish("installed");
    f.install();
    await flush();
    expect((await f.manager.tick()).phase).toBe("health-check");
    expect((await f.manager.tick()).phase).toBe("up-to-date");
  });

  it("a Store with no update for this PC also falls back to winget", async () => {
    const f = await windowsFixture();
    vi.mocked(f.windows.storeUpdate).mockResolvedValue("no-update");
    await f.manager.check();
    expect((await f.passIdle()).updateRoute).toBe("winget");
  });

  it("Store queue that never installs: winget after the Store timeout", async () => {
    const f = await windowsFixture();
    await f.manager.check();
    await f.passIdle();
    f.advance(15 * 60_000 + 1);
    const status = await f.manager.tick();
    expect(status).toMatchObject({ phase: "installing", updateRoute: "winget" });
  });

  it("both routes fail: manual-update with CODEX_STORE_UPDATE_FAILED, Codex reopened", async () => {
    const f = await windowsFixture();
    vi.mocked(f.windows.storeUpdate).mockRejectedValue(new Error("synthetic"));
    await f.manager.check();
    await f.passIdle();
    expect(f.running()).toBe(false);
    f.winget.fail();
    await flush();
    const status = await f.manager.tick();
    expect(status).toMatchObject({
      phase: "manual-update",
      error: "CODEX_STORE_UPDATE_FAILED",
      verifiedUpdate: VERIFIED,
    });
    expect(f.windows.reopen).toHaveBeenCalledTimes(1);
    expect(f.running()).toBe(true);
    // The next ordinary check keeps the manual state instead of closing Codex again.
    const again = await f.manager.check();
    expect(again).toMatchObject({ phase: "manual-update", error: "CODEX_STORE_UPDATE_FAILED" });
    expect(f.windows.quit).toHaveBeenCalledTimes(1);
  });

  it("winget never finishes: manual-update with CODEX_STORE_UPDATE_TIMEOUT", async () => {
    const f = await windowsFixture();
    vi.mocked(f.windows.storeUpdate).mockResolvedValue("no-update");
    await f.manager.check();
    await f.passIdle();
    f.advance(21 * 60_000 + 1);
    expect(await f.manager.tick()).toMatchObject({
      phase: "manual-update",
      error: "CODEX_STORE_UPDATE_TIMEOUT",
    });
    expect(f.running()).toBe(true);
  });

  it("winget says installed but the version never changes: manual, not success", async () => {
    const f = await windowsFixture();
    vi.mocked(f.windows.storeUpdate).mockResolvedValue("no-update");
    await f.manager.check();
    await f.passIdle();
    f.winget.finish("installed");
    await flush();
    expect((await f.manager.tick()).phase).toBe("installing");
    f.advance(60_001);
    expect((await f.manager.tick()).phase).toBe("manual-update");
  });

  it("management off: no automatic update, but the hint and 现在更新 still work", async () => {
    const f = await windowsFixture({ enabled: false });
    const status = await f.manager.check();
    expect(status).toMatchObject({ phase: "disabled", verifiedUpdate: VERIFIED });
    await f.manager.tick();
    expect(f.windows.quit).not.toHaveBeenCalled();
    expect(f.windows.storeUpdate).not.toHaveBeenCalled();
    // The person asks: waits only for no task running (not for five idle minutes).
    f.idle.mockResolvedValue(false);
    f.busy.mockResolvedValue(true);
    const requested = await f.manager.updateNow();
    expect(requested).toMatchObject({ phase: "waiting-idle", requested: true });
    expect(f.windows.quit).not.toHaveBeenCalled();
    f.busy.mockResolvedValue(false);
    const installing = await f.passIdle();
    expect(installing.phase).toBe("installing");
    expect(f.windows.quit).toHaveBeenCalledTimes(1);
    // An ordinary check while installing does not drop back to "disabled".
    expect((await f.manager.check()).phase).toBe("installing");
    f.install();
    expect((await f.manager.tick()).phase).toBe("health-check");
    expect((await f.manager.tick()).phase).toBe("up-to-date");
    expect((await f.manager.check()).phase).toBe("disabled");
  });

  it("switching management off cancels a pending automatic wait", async () => {
    const f = await windowsFixture();
    f.idle.mockResolvedValue(false);
    expect((await f.manager.check()).phase).toBe("waiting-idle");
    const off = await f.manager.setEnabled(false);
    expect(off.phase).toBe("disabled");
    f.idle.mockResolvedValue(true);
    await f.passIdle();
    expect(f.windows.quit).not.toHaveBeenCalled();
  });

  it("an unverified Store offer is not installed (the hold stays as before)", async () => {
    const f = await windowsFixture({ offered: UNVERIFIED_NEW });
    const status = await f.manager.check();
    expect(status).toMatchObject({
      phase: "waiting-compatibility",
      store: { mode: "holding", setting: "Disabled" },
    });
    expect(status.verifiedUpdate).toBeUndefined();
    await f.passIdle();
    expect(f.windows.quit).not.toHaveBeenCalled();
    expect(f.windows.storeUpdate).not.toHaveBeenCalled();
    // 现在更新 refuses an unverified offer as well.
    expect((await f.manager.updateNow()).phase).toBe("waiting-compatibility");
    expect(f.windows.storeUpdate).not.toHaveBeenCalled();
  });

  it("the offer turning unverified before the quit stops the update", async () => {
    const f = await windowsFixture();
    await f.manager.check();
    f.offer(UNVERIFIED_NEW);
    const status = await f.passIdle();
    expect(status.phase).toBe("waiting-compatibility");
    expect(f.windows.quit).not.toHaveBeenCalled();
  });

  it("canary PC keeps following the Store: no Hub update", async () => {
    const f = await windowsFixture();
    await fs.mkdir(f.environment.CODEXHOST_DATA_DIR, { recursive: true });
    await fs.writeFile(path.join(f.environment.CODEXHOST_DATA_DIR, STORE_CANARY_FILE), "{}\n");
    const status = await f.manager.check();
    expect(status).toMatchObject({ phase: "up-to-date", store: { mode: "canary" } });
    expect(status.verifiedUpdate).toBeUndefined();
    await f.passIdle();
    expect(f.windows.storeUpdate).not.toHaveBeenCalled();
  });

  it("a Codex that was not open is updated without being opened afterwards", async () => {
    const f = await windowsFixture();
    f.closeCodex();
    await f.manager.check();
    await f.passIdle();
    expect(f.windows.quit).not.toHaveBeenCalled();
    f.install();
    expect((await f.manager.tick()).phase).toBe("up-to-date");
    expect(f.windows.reopen).not.toHaveBeenCalled();
  });

  it("already on the verified build: nothing to do", async () => {
    const f = await windowsFixture({ current: VERIFIED });
    const status = await f.manager.check();
    expect(status.phase).toBe("up-to-date");
    expect(status.verifiedUpdate).toBeUndefined();
  });
});

describe("Windows update driver (injected PowerShell / winget)", () => {
  it("parses the Store script's answer and rejects anything else", () => {
    expect(parseStoreUpdate("STORE=started\r\n")).toBe("started");
    expect(parseStoreUpdate("STORE=no-update")).toBe("no-update");
    expect(parseStoreUpdate("STORE=completed")).toBe("completed");
    expect(() => parseStoreUpdate("STORE=error 0x80070005")).toThrow("CODEX_STORE_UPDATE_FAILED");
    expect(() => parseStoreUpdate("")).toThrow("CODEX_STORE_UPDATE_FAILED");
  });

  it("the Store script updates only Codex and never writes the global switch", () => {
    const script = storeUpdateScript();
    expect(script).toContain("SearchForUpdatesAsync('9PLM9XGG6VKS'");
    expect(script).toContain("AutomaticallyDownloadAndInstallUpdateIfFound = $true");
    expect(script).toContain("UpdateAppByPackageFamilyNameAsync");
    expect(script).toContain("Get-AppxPackage -Name 'OpenAI.Codex'");
    expect(script).toContain("IAsyncOperation`1");
    expect(script).not.toContain("AutoUpdateSetting");
  });

  it("winget exit codes: installed, nothing applicable, failure", () => {
    expect(wingetResult(0)).toBe("installed");
    expect(wingetResult(0x8a15002b)).toBe("no-update");
    expect(wingetResult(0x8a15002b | 0)).toBe("no-update");
    expect(() => wingetResult(1)).toThrow("CODEX_WINGET_FAILED");
    expect(() => wingetResult(null)).toThrow("CODEX_WINGET_FAILED");
  });

  it("driver: Store via the PowerShell runner, winget by full path, unknown process = running", async () => {
    const run = vi.fn(async () => "STORE=started");
    const runWinget = vi.fn(async () => 0);
    const driver = createWindowsCodexUpdateDriver({
      run,
      runWinget,
      findWinget: async () => ({
        file: "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
        environment: {},
      }),
      desktopRunning: async () => null,
      quit: async () => true,
      reopen: async () => true,
      healthy: async () => true,
    });
    expect(await driver.storeUpdate()).toBe("started");
    expect(run).toHaveBeenCalledWith(expect.stringContaining("9PLM9XGG6VKS"), 150_000);
    expect(await driver.wingetUpgrade()).toBe("installed");
    expect(runWinget).toHaveBeenCalledWith(
      "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
      WINGET_UPGRADE_ARGS,
      {},
    );
    expect(WINGET_UPGRADE_ARGS).toEqual(
      expect.arrayContaining(["--id", "9PLM9XGG6VKS", "--source", "msstore", "--silent"]),
    );
    expect(await driver.isRunning()).toBe(true);
    expect(await driver.installationStopped()).toBe(false);
  });

  it("driver: missing winget and a failed PowerShell are errors, not success", async () => {
    const driver = createWindowsCodexUpdateDriver({
      run: async () => {
        throw new Error("powershell failed");
      },
      findWinget: async () => null,
      desktopRunning: async () => false,
      quit: async () => false,
      reopen: async () => true,
      healthy: async () => true,
    });
    await expect(driver.storeUpdate()).rejects.toThrow("CODEX_STORE_UPDATE_FAILED");
    await expect(driver.wingetUpgrade()).rejects.toThrow("CODEX_WINGET_UNAVAILABLE");
    await expect(driver.quit()).rejects.toThrow("CODEX_QUIT_FAILED");
    expect(await driver.installationStopped()).toBe(true);
  });

  it("input idle reads GetLastInputInfo once per 10 seconds; unreadable is null", async () => {
    let now = 0;
    const run = vi.fn<(script: string) => Promise<string>>(async () => "IDLE=360000");
    const read = windowsInputIdleMs(run, () => now);
    expect(await read()).toBe(360_000);
    now = 5_000;
    expect(await read()).toBe(360_000);
    expect(run).toHaveBeenCalledTimes(1);
    now = 11_000;
    run.mockResolvedValueOnce("garbage");
    expect(await read()).toBeNull();
    expect(run.mock.calls[0]?.[0]).toContain("GetLastInputInfo");
  });

  it("Store page link is the Codex product page", () => {
    expect(CODEX_STORE_PAGE_URL).toBe("ms-windows-store://pdp/?productid=9PLM9XGG6VKS");
  });
});

describe("Mac: an installed unverified old build behind a verified appcast", () => {
  it("updates without waiting for another release, then leaves core mode", async () => {
    const { root, environment } = await isolatedEnvironment("synthetic-codex-mac-behind-");
    const response: UpdateHttpGet = async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            updatedAt: "2026-11-23T00:00:00Z",
            verified: [],
            verifiedVersions: [{ version: "26.1200.1", minHub: "0.11.40" }],
            disabled: [],
          }),
        );
      })(),
      cancel() {},
    });
    let now = 1000;
    let current = "26.1100.7.0"; // never verified
    let running = true;
    const driver: CodexUpdateDriver = {
      watchLease: vi.fn(async () => undefined),
      readAutoUpdate: vi.fn(async () => true),
      writeAutoUpdate: vi.fn(async () => undefined),
      currentVersion: vi.fn(async () => current),
      latestVersion: vi.fn(async () => "26.1200.1.0"),
      readCheckPreferences: vi.fn(async () => ({ automaticChecks: null, lastCheckTime: null })),
      restoreCheckPreferences: vi.fn(async () => undefined),
      requestCheck: vi.fn(async () => undefined),
      downloadReady: vi.fn(async () => true),
      quit: vi.fn(async () => {
        running = false;
      }),
      installationStopped: vi.fn(async () => true),
      isRunning: vi.fn(async () => running),
      reopen: vi.fn(async () => {
        running = true;
        return true;
      }),
      healthy: vi.fn(async () => true),
    };
    const manager = new CodexUpdateManager({
      environment,
      state: new Rly0HubStateStore(environment),
      catalog: new CodexCompatibilityCatalog({
        environment,
        installRoot: root,
        hubVersion: "0.11.54",
        platform: "darwin",
        get: async () => response,
      }),
      driver,
      busy: async () => false,
      now: () => now,
      idleMs: 10,
      sleep: async (ms) => {
        now += ms;
      },
    });
    managers.push(manager);
    const first = await manager.check();
    // The trigger is "latest verified and newer than installed", not "a new release appeared".
    expect(first.phase).toBe("waiting-idle");
    expect(first.renderer.mode).toBe("core");
    await manager.tick();
    now += 20;
    expect((await manager.tick()).phase).toBe("installing");
    current = "26.1200.1.0";
    expect((await manager.tick()).phase).toBe("health-check");
    const done = await manager.tick();
    expect(done).toMatchObject({ phase: "up-to-date", currentVersion: "26.1200.1.0" });
    expect(done.renderer.mode).toBe("full");
    // A later check with the same feed does not restart anything.
    expect((await manager.check()).phase).toBe("up-to-date");
    expect(driver.quit).toHaveBeenCalledTimes(1);
  });
});

describe("系统诊断 hint from codex.updates status", () => {
  it("Windows verified offer: auto while managed, manual otherwise; Mac only while updating", async () => {
    const { codexUpdateHint } = await import("../src/rly0-hub-service/service.js");
    const base = {
      enabled: true,
      phase: "waiting-idle",
      latestVersion: VERIFIED,
      store: { mode: "following", setting: "Enabled" },
    };
    const hint = (value: Record<string, unknown>) =>
      codexUpdateHint(value as unknown as Parameters<typeof codexUpdateHint>[0]);
    expect(hint({ ...base, verifiedUpdate: VERIFIED })).toEqual({ target: VERIFIED, mode: "auto" });
    expect(hint({ ...base, enabled: false, phase: "disabled", verifiedUpdate: VERIFIED })).toEqual({
      target: VERIFIED,
      mode: "manual",
    });
    expect(hint({ ...base, phase: "manual-update", verifiedUpdate: VERIFIED })?.mode).toBe(
      "manual",
    );
    expect(hint({ ...base, phase: "up-to-date" })).toBeNull();
    const mac = { enabled: true, latestVersion: "26.1200.1.0" };
    expect(hint({ ...mac, phase: "downloading" })).toEqual({ target: "26.1200.1.0", mode: "auto" });
    expect(hint({ ...mac, phase: "waiting-compatibility" })).toBeNull();
    expect(hint(undefined as unknown as Record<string, unknown>)).toBeNull();
  });
});

describe("Windows: Codex that will not close", () => {
  it("reports CODEX_INSTALL_TIMEOUT, does not update, and backs off instead of retrying every check", async () => {
    const f = await windowsFixture();
    vi.mocked(f.windows.quit).mockResolvedValue(undefined); // quit "issued" but Codex stays up
    await f.manager.check();
    const status = await f.passIdle();
    expect(status).toMatchObject({ phase: "failed", error: "CODEX_INSTALL_TIMEOUT" });
    expect(f.windows.storeUpdate).not.toHaveBeenCalled();
    const again = await f.manager.check();
    expect(again).toMatchObject({ phase: "failed", error: "CODEX_INSTALL_TIMEOUT" });
    expect(f.windows.quit).toHaveBeenCalledTimes(1);
    f.advance(6 * 60 * 60_000 + 1);
    expect((await f.manager.check()).phase).toBe("waiting-idle");
  });
});
