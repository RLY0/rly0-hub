// Windows Microsoft Store hold. Synthetic Store driver only: never the real Store or PowerShell.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexStoreHold,
  codexStoreControlAllowed,
  createWindowsStoreUpdateDriver,
  parseStoreSetting,
  storeSettingScript,
  STORE_CANARY_FILE,
  type StoreUpdateDriver,
  type StoreUpdateSetting,
} from "../src/rly0-hub-service/codex-store-hold.js";
import { CodexCompatibilityCatalog } from "../src/rly0-hub-service/codex-compat.js";
import { CodexUpdateManager } from "../src/rly0-hub-service/codex-update-manager.js";
import { Rly0HubStateStore } from "../src/rly0-hub-service/hub-state.js";
import type { UpdateHttpGet } from "../src/rly0-hub-service/hub-update-net.js";

const roots: string[] = [];
const managers: CodexUpdateManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const json =
  (value: unknown): UpdateHttpGet =>
  async () => ({
    status: 200,
    headers: {},
    body: (async function* () {
      yield Buffer.from(JSON.stringify(value));
    })(),
    cancel() {},
  });

async function fixture(options: { setting?: StoreUpdateSetting; offered?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-codex-store-hold-"));
  roots.push(root);
  const environment = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CODEXHOST_DATA_DIR: path.join(root, "hub"),
    RLY0_MEMORY_DIR: path.join(root, "memory"),
    RLY0_SKIP_LEGACY_IMPORT: "1",
    RLY0_CODEX_UPDATE_CONTROL: "0",
  };
  let setting: StoreUpdateSetting = options.setting ?? "Enabled";
  let offered: string | Error = options.offered ?? "26.1117.5012.0";
  let failWrite = false;
  const driver: StoreUpdateDriver = {
    readSetting: vi.fn(async () => setting),
    writeSetting: vi.fn(async (value) => {
      if (failWrite) throw new Error("synthetic write failure");
      setting = value;
    }),
    offeredVersion: vi.fn(async () => {
      if (offered instanceof Error) throw offered;
      return offered;
    }),
  };
  const hold = new CodexStoreHold({ environment, driver, now: () => 1_800_000_000_000 });
  const catalog = new CodexCompatibilityCatalog({
    environment,
    installRoot: root,
    hubVersion: "0.11.50",
    platform: "win32",
  });
  const state = new Rly0HubStateStore(environment);
  const make = () => {
    const manager = new CodexUpdateManager({
      environment,
      state,
      catalog,
      driver: null,
      unsupportedReason: "platform",
      storeHold: hold,
      currentVersion: async () => "26.1117.3838.0",
      busy: async () => false,
    });
    managers.push(manager);
    return manager;
  };
  return {
    root,
    environment,
    driver,
    hold,
    catalog,
    make,
    manager: make(),
    setting: () => setting,
    setSetting: (value: StoreUpdateSetting) => {
      setting = value;
    },
    offer: (value: string | Error) => {
      offered = value;
    },
    failWrites: (value: boolean) => {
      failWrite = value;
    },
    canary: () =>
      fs.writeFile(path.join(environment.CODEXHOST_DATA_DIR, STORE_CANARY_FILE), "{}\n"),
  };
}

describe("Windows Store hold (synthetic Store)", () => {
  it("turns Store updates off for an unverified build of a verified family, journal first", async () => {
    const f = await fixture();
    const status = await f.manager.check();
    expect(status).toMatchObject({
      supported: true,
      phase: "waiting-compatibility",
      latestVersion: "26.1117.5012.0",
      currentVersion: "26.1117.3838.0",
      store: { mode: "holding", setting: "Disabled" },
      error: null,
      renderer: { mode: "full" },
    });
    expect(status.unsupportedReason).toBeUndefined();
    expect(f.setting()).toBe("Disabled");
    expect(JSON.parse(await fs.readFile(f.hold.journalFile, "utf8"))).toMatchObject({
      originalValue: "Enabled",
      offeredAtApply: "26.1117.5012.0",
      applied: true,
    });
    // Repeated checks keep one journal and do not rewrite an already-off switch.
    await f.manager.check();
    expect(f.driver.writeSetting).toHaveBeenCalledTimes(1);
  });

  it("puts the switch back once the offered build is verified exactly", async () => {
    const f = await fixture();
    await f.manager.check();
    f.offer("26.1117.3838.0");
    const status = await f.manager.check();
    expect(status).toMatchObject({ phase: "up-to-date", store: { mode: "following" } });
    expect(f.setting()).toBe("Enabled");
    await expect(fs.access(f.hold.journalFile)).rejects.toThrow();
  });

  it("does not hold when the Store already offers only a verified build", async () => {
    const f = await fixture({ offered: "26.1117.3838.0" });
    expect(await f.manager.check()).toMatchObject({
      phase: "up-to-date",
      store: { mode: "following" },
    });
    expect(f.driver.writeSetting).not.toHaveBeenCalled();
    expect(f.setting()).toBe("Enabled");
  });

  it("recovers after a crash: a journal left behind is undone by the next Hub", async () => {
    const f = await fixture();
    await f.manager.check();
    await f.manager.stop();
    // A new Hub process (fresh manager, same data directory) after the build was verified.
    f.offer("26.1117.3838");
    expect(await f.make().check()).toMatchObject({ store: { mode: "following" } });
    expect(f.setting()).toBe("Enabled");
    // A crash between journal and switch (switch never turned off) also ends with no journal.
    await fs.writeFile(f.hold.journalFile, JSON.stringify({ originalValue: "Enabled" }));
    expect((await f.hold.release()).setting).toBe("Enabled");
    await expect(fs.access(f.hold.journalFile)).rejects.toThrow();
    // A damaged journal still proves the Hub turned updates off.
    f.setSetting("Disabled");
    await fs.writeFile(f.hold.journalFile, "{broken");
    expect((await f.hold.release()).setting).toBe("Enabled");
  });

  it("keeps a held switch while the Store feed is unreachable", async () => {
    const f = await fixture();
    await f.manager.check();
    f.offer(new Error("offline"));
    expect(await f.manager.check()).toMatchObject({
      phase: "failed",
      error: "CODEX_APPCAST_FAILED",
      store: { mode: "holding" },
    });
    expect(f.setting()).toBe("Disabled");
  });

  it("keeps the person's own value: off before the Hub, or turned back on during a hold", async () => {
    const off = await fixture({ setting: "Disabled" });
    expect(await off.manager.check()).toMatchObject({
      store: { mode: "user-off", setting: "Disabled" },
    });
    expect(off.driver.writeSetting).not.toHaveBeenCalled();
    await expect(fs.access(off.hold.journalFile)).rejects.toThrow();
    off.offer("26.1117.3838.0");
    await off.manager.check();
    expect(off.setting()).toBe("Disabled"); // Never turned on: it was not the Hub's change.

    const f = await fixture();
    await f.manager.check();
    expect(f.setting()).toBe("Disabled");
    f.setSetting("Enabled"); // The person turned Store updates back on by hand.
    // Later checks for the same offered build respect it: no write, reported as theirs.
    expect(await f.manager.check()).toMatchObject({
      phase: "waiting-compatibility",
      store: { mode: "user-on", setting: "Enabled" },
    });
    expect(await f.manager.check()).toMatchObject({ store: { mode: "user-on" } });
    expect(f.setting()).toBe("Enabled");
    expect(f.driver.writeSetting).toHaveBeenCalledTimes(1);
    expect(await f.hold.holding()).toBe(false);
    // The same build reported with the Windows ".0" suffix is the same choice.
    f.offer("26.1117.5012");
    expect(await f.manager.check()).toMatchObject({ store: { mode: "user-on" } });
    expect(f.driver.writeSetting).toHaveBeenCalledTimes(1);
    // Feed offline keeps reporting the person's choice, not a hold.
    f.offer(new Error("offline"));
    expect(await f.manager.check()).toMatchObject({ store: { mode: "user-on" } });
    // A different unverified build is a new hold.
    f.offer("26.1117.6000.0");
    expect(await f.manager.check()).toMatchObject({ store: { mode: "holding" } });
    expect(f.setting()).toBe("Disabled");
    expect(f.driver.writeSetting).toHaveBeenCalledTimes(2);
    // Verified: the Hub's own hold is undone as usual.
    f.offer("26.1117.3838.0");
    await f.manager.check();
    expect(f.setting()).toBe("Enabled");
    await expect(fs.access(f.hold.journalFile)).rejects.toThrow();
  });

  it("never mistakes a hold that did not take effect for the person turning updates on", async () => {
    // The switch write fails: the journal stays unapplied, and the next check still holds.
    const failed = await fixture();
    failed.failWrites(true);
    expect(await failed.manager.check()).toMatchObject({
      phase: "failed",
      error: "CODEX_STORE_FAILED",
    });
    expect(JSON.parse(await fs.readFile(failed.hold.journalFile, "utf8"))).toMatchObject({
      applied: false,
    });
    expect(failed.setting()).toBe("Enabled");
    failed.failWrites(false);
    expect(await failed.manager.check()).toMatchObject({
      store: { mode: "holding", setting: "Disabled" },
    });
    expect(failed.setting()).toBe("Disabled");
    expect(await failed.manager.check()).toMatchObject({ store: { mode: "holding" } });

    // A crash between journal and switch (journal written, switch still on): held on restart.
    const crash = await fixture();
    await fs.mkdir(crash.environment.CODEXHOST_DATA_DIR, { recursive: true });
    await fs.writeFile(
      crash.hold.journalFile,
      JSON.stringify({
        originalValue: "Enabled",
        offeredAtApply: "26.1117.5012.0",
        applied: false,
      }),
    );
    expect(await crash.manager.check()).toMatchObject({ store: { mode: "holding" } });
    expect(crash.setting()).toBe("Disabled");
    expect(JSON.parse(await fs.readFile(crash.hold.journalFile, "utf8"))).toMatchObject({
      originalValue: "Enabled",
      applied: true,
    });

    // A damaged journal with the switch on is not the person's choice either.
    const damaged = await fixture();
    await fs.mkdir(damaged.environment.CODEXHOST_DATA_DIR, { recursive: true });
    await fs.writeFile(damaged.hold.journalFile, "{broken");
    expect(await damaged.manager.check()).toMatchObject({ store: { mode: "holding" } });
    expect(damaged.setting()).toBe("Disabled");
    // ...and its hold is undone as the Hub's own once the build is verified.
    damaged.offer("26.1117.3838.0");
    await damaged.manager.check();
    expect(damaged.setting()).toBe("Enabled");
  });

  it("reports the person's recorded choice after a Hub restart with the Store feed offline", async () => {
    const f = await fixture();
    await f.manager.check();
    f.setSetting("Enabled");
    expect(await f.manager.check()).toMatchObject({ store: { mode: "user-on" } });
    await f.manager.stop();
    f.offer(new Error("offline"));
    expect(await f.make().check()).toMatchObject({ store: { mode: "user-on" } });
    expect(f.driver.writeSetting).toHaveBeenCalledTimes(1);
  });

  it("lets the person opt out even when the Store switch cannot be restored yet", async () => {
    const f = await fixture();
    await f.manager.check();
    await f.manager.stop();
    f.failWrites(true);
    const fresh = f.make(); // not initialized yet: the opt-out fast path
    expect(await fresh.setEnabled(false)).toMatchObject({
      enabled: false,
      phase: "failed",
      error: "CODEX_STORE_FAILED",
    });
    expect(f.setting()).toBe("Disabled");
    // Management stays off and the next check retries the restore.
    f.failWrites(false);
    expect(await fresh.check()).toMatchObject({ enabled: false, phase: "disabled" });
    expect(f.setting()).toBe("Enabled");
    await expect(fs.access(f.hold.journalFile)).rejects.toThrow();
  });

  it("drops the person's recorded choice on release without touching the switch", async () => {
    const f = await fixture();
    await f.manager.check();
    f.setSetting("Enabled");
    await f.manager.check();
    f.setSetting("Disabled"); // Whatever the switch is now, it is theirs.
    expect(await f.manager.setEnabled(false)).toMatchObject({ phase: "disabled" });
    expect(f.setting()).toBe("Disabled");
    expect(f.driver.writeSetting).toHaveBeenCalledTimes(1);
    await expect(fs.access(f.hold.journalFile)).rejects.toThrow();
  });

  it("reports a policy-enforced or failing switch instead of pretending to hold", async () => {
    const policy = await fixture({ setting: "EnabledByPolicy" });
    expect(await policy.manager.check()).toMatchObject({
      phase: "failed",
      error: "CODEX_STORE_FAILED",
    });
    const f = await fixture();
    f.failWrites(true);
    expect(await f.manager.check()).toMatchObject({ phase: "failed", error: "CODEX_STORE_FAILED" });
  });

  it("restores the switch when management is turned off, and never holds while off", async () => {
    const f = await fixture();
    await f.manager.check();
    expect(f.setting()).toBe("Disabled");
    expect(await f.manager.setEnabled(false)).toMatchObject({ enabled: false, phase: "disabled" });
    expect(f.setting()).toBe("Enabled");
    await expect(fs.access(f.hold.journalFile)).rejects.toThrow();
    await f.manager.check();
    expect(f.setting()).toBe("Enabled");
    // Switched back on: holds again.
    expect(await f.manager.setEnabled(true)).toMatchObject({ store: { mode: "holding" } });
    expect(f.setting()).toBe("Disabled");
  });

  it("canary PC always follows the Store and undoes an earlier hold", async () => {
    const f = await fixture();
    await f.manager.check();
    expect(f.setting()).toBe("Disabled");
    await f.canary();
    const status = await f.manager.check();
    expect(status).toMatchObject({
      phase: "waiting-compatibility",
      store: { mode: "canary" },
      error: null,
    });
    expect(f.setting()).toBe("Enabled");
    await f.manager.check();
    expect(f.setting()).toBe("Enabled");
    expect(f.driver.writeSetting).toHaveBeenCalledTimes(2); // off once, back on once
  });

  it("an unverified installed build degrades the interface (core) on Windows", async () => {
    const f = await fixture();
    expect(f.catalog.policy("26.1117.5012.0").mode).toBe("core");
    expect(f.catalog.policy("26.1117.3838.0").mode).toBe("full");
  });

  it("without a Store hold Windows still reports unsupported", async () => {
    const f = await fixture();
    const manager = new CodexUpdateManager({
      environment: f.environment,
      state: new Rly0HubStateStore(f.environment),
      catalog: f.catalog,
      driver: null,
      unsupportedReason: "platform",
      busy: async () => false,
    });
    managers.push(manager);
    expect(await manager.check()).toMatchObject({
      supported: false,
      unsupportedReason: "platform",
      phase: "unsupported",
    });
    expect((await manager.check()).store).toBeUndefined();
  });
});

describe("Windows Store driver pieces (no PowerShell is run)", () => {
  it("parses only known settings and builds a fixed script", () => {
    expect(parseStoreSetting("noise\r\nSETTING=Enabled\r\n")).toBe("Enabled");
    expect(() => parseStoreSetting("SETTING=Whatever")).toThrow();
    expect(() => parseStoreSetting("")).toThrow();
    expect(storeSettingScript()).not.toContain("AutoUpdateSetting =");
    expect(storeSettingScript("Disabled")).toContain("AutoUpdateSetting]::Disabled");
  });
  it("reads the offered build and verifies each write by reading back", async () => {
    const run = vi.fn(async (script: string) =>
      script.includes("]::Disabled") ? "SETTING=Enabled" : "SETTING=Enabled",
    );
    const driver = createWindowsStoreUpdateDriver({
      get: async () => json({ schemaVersion: 1, buildVersion: "26.1117.5012.0" }),
      run,
    });
    expect(await driver.offeredVersion()).toBe("26.1117.5012.0");
    expect(await driver.readSetting()).toBe("Enabled");
    await expect(driver.writeSetting("Disabled")).rejects.toThrow("CODEX_STORE_WRITE_FAILED");
    const bad = createWindowsStoreUpdateDriver({
      get: async () => json({ buildVersion: "latest" }),
      run,
    });
    await expect(bad.offeredVersion()).rejects.toThrow("CODEX_STORE_FEED_INVALID");
  });
  it("only a production Windows Hub in the default data directory may touch the Store", () => {
    const home = path.join(os.tmpdir(), "synthetic-home");
    expect(codexStoreControlAllowed({}, "darwin", home)).toBe(false);
    expect(codexStoreControlAllowed({ VITEST: "1" }, "win32", home)).toBe(false);
    expect(codexStoreControlAllowed({ RLY0_CODEX_UPDATE_CONTROL: "0" }, "win32", home)).toBe(false);
    expect(
      codexStoreControlAllowed({ CODEXHOST_DATA_DIR: path.join(home, "elsewhere") }, "win32", home),
    ).toBe(false);
    expect(
      codexStoreControlAllowed({ CODEXHOST_DATA_DIR: path.join(home, ".rly0-hub") }, "win32", home),
    ).toBe(true);
  });
});
