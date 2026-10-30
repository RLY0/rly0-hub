import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { desktopCompatibilitySchema } from "@codexhost/shared-contracts";
import { Rly0DesktopCompatibility } from "../../src/rly0-maintenance/desktop-compatibility.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rly0-compat-synthetic-"));
  directories.push(directory);
  const diagnostics = path.join(directory, "diagnostics");
  await mkdir(diagnostics);
  const environment = { CODEXHOST_DATA_DIR: directory };
  const native = {
    schemaVersion: 1,
    desktop: { version: "26.1021.3705.0", processIds: [101] },
    runtime: { running: true, launcherPid: 102 },
  };
  const controller = {
    schemaVersion: 1,
    pid: 103,
    startedAt: 101000,
    renderer: { state: "installed", error: null as string | null, updatedAt: 102000 },
  };
  const startupRecord = {
    pid: 102,
    startedAtMs: 100000,
    desktop: { version: native.desktop.version },
  };
  const startup = {
    schemaVersion: 1,
    records: [startupRecord],
  };
  const inspect = vi.fn(async () => native);
  const isAlive = vi.fn(() => true);
  let now = 200000;
  const options = { environment, inspect, isAlive, now: () => now, cacheMs: 0 };
  async function save() {
    await writeFile(path.join(diagnostics, "launcher-startup-v1.json"), JSON.stringify(startup));
    await writeFile(
      path.join(diagnostics, "desktop-controller-v1.json"),
      JSON.stringify(controller),
    );
  }
  await save();
  return {
    directory,
    diagnostics,
    native,
    controller,
    startup,
    startupRecord,
    inspect,
    isAlive,
    options,
    save,
    monitor: new Rly0DesktopCompatibility(options),
    setNow(value: number) {
      now = value;
    },
  };
}

it("records a baseline only when the current managed session has connected its interface", async () => {
  const f = await fixture();
  const result = await f.monitor.check();
  expect(desktopCompatibilitySchema.parse(result).state).toBe("ready");
  expect(result.checks).toEqual({
    managedRuntime: true,
    controllerAlive: true,
    interfaceConnected: true,
  });
  const saved = JSON.parse(
    await readFile(path.join(f.diagnostics, "desktop-compatibility-state-v1.json"), "utf8"),
  );
  expect(saved.lastCompatibleVersion).toBe(f.native.desktop.version);
  // An unchanged healthy status can be old; it is published on transitions, not as a heartbeat.
  f.setNow(99_000_000);
  expect((await f.monitor.check()).state).toBe("ready");
});

it("classifies the observed new-version manager failure and exports no raw error or secrets", async () => {
  const f = await fixture();
  await f.monitor.check();
  f.native.desktop.version = "26.1022.1";
  f.startupRecord.desktop.version = f.native.desktop.version;
  f.controller.renderer.state = "unavailable";
  f.controller.renderer.error =
    "Renderer Host request manager is unavailable: token=synthetic-secret person@example.test";
  await f.save();
  const result = await f.monitor.check();
  expect(result).toMatchObject({
    state: "incompatible",
    issue: "REQUEST_MANAGER_UNAVAILABLE",
    previousCompatibleVersion: "26.1021.3705.0",
    versionChanged: true,
  });
  const notice = await f.monitor.takeNotice();
  expect(notice?.body).toContain("反馈问题");
  expect(await f.monitor.takeNotice()).toBeNull();
  expect(await new Rly0DesktopCompatibility(f.options).takeNotice()).toBeNull();
  const saved = await readFile(
    path.join(f.diagnostics, "desktop-compatibility-state-v1.json"),
    "utf8",
  );
  expect(JSON.stringify({ result, notice, saved })).not.toMatch(/synthetic-secret|person@example/);
  // The reason itself is kept, redacted, so a saved diagnostics file explains the failure.
  expect(result.rendererError).toBe(
    "Renderer Host request manager is unavailable: token=<redacted> <email>",
  );
  // Recovery clears the notice and establishes the actual new baseline.
  f.controller.renderer.state = "installed";
  f.controller.renderer.error = null;
  await f.save();
  expect((await f.monitor.check()).state).toBe("ready");
  expect((await f.monitor.check()).previousCompatibleVersion).toBe("26.1022.1");
  expect((await f.monitor.check()).rendererError).toBeUndefined();
});

it("keeps a CDP failure's reason, home folder removed, falling back to the last error", async () => {
  const f = await fixture();
  f.controller.renderer.state = "unavailable";
  f.controller.renderer.error = `connect ECONNREFUSED 127.0.0.1:9229
  at ${os.homedir()}/app.js`;
  await f.save();
  const result = await f.monitor.check();
  expect(result.issue).toBe("CDP_UNAVAILABLE");
  expect(result.rendererError).toBe("connect ECONNREFUSED 127.0.0.1:9229 at <home>/app.js");
  expect(desktopCompatibilitySchema.parse(result).rendererError).toBe(result.rendererError);
  // The Controller clears `error` between attempts; the last one still explains it.
  f.controller.renderer.error = "";
  Object.assign(f.controller.renderer, { lastError: "CDP target closed" });
  await f.save();
  expect((await f.monitor.check()).rendererError).toBe("CDP target closed");
});

it("does not reject a version change when the actual interface is connected", async () => {
  const f = await fixture();
  await f.monitor.check();
  f.native.desktop.version = "26.9000.1";
  f.startupRecord.desktop.version = f.native.desktop.version;
  await f.save();
  expect(await f.monitor.check()).toMatchObject({ state: "ready", versionChanged: true });
  expect(await f.monitor.takeNotice()).toBeNull();
});

it.each(["dead", "previous-session", "different-version", "future-status"])(
  "does not accept a %s controller as proof",
  async (kind) => {
    const f = await fixture();
    if (kind === "dead") f.isAlive.mockReturnValue(false);
    if (kind === "previous-session") f.controller.startedAt = 90000;
    if (kind === "different-version") f.startupRecord.desktop.version = "26.1";
    if (kind === "future-status") f.controller.startedAt = 300000;
    await f.save();
    const result = await f.monitor.check();
    expect(result.state).not.toBe("ready");
    expect(result.checks.interfaceConnected).toBeNull();
  },
);

it("allows initialization time and reports persistent installation delays without claiming incompatibility", async () => {
  const f = await fixture();
  f.controller.renderer.state = "installing";
  await f.save();
  f.setNow(110000);
  expect((await f.monitor.check()).state).toBe("checking");
  expect(await f.monitor.takeNotice()).toBeNull();
  f.setNow(200000);
  expect(await f.monitor.check()).toMatchObject({
    state: "unavailable",
    issue: "INTEGRATION_PENDING",
  });
  expect(await f.monitor.takeNotice()).not.toBeNull();
});

it("does not certify native-only or stopped Desktop and does not emit warnings for either", async () => {
  const f = await fixture();
  f.native.runtime.running = false;
  expect((await f.monitor.check()).state).toBe("unverified");
  expect(await f.monitor.takeNotice()).toBeNull();
  f.native.desktop.processIds = [];
  expect((await f.monitor.check()).state).toBe("not-running");
});

it("bounds diagnostic reads and handles corrupt metadata or inspect failures", async () => {
  const f = await fixture();
  await writeFile(path.join(f.diagnostics, "desktop-controller-v1.json"), "x".repeat(100000));
  expect((await f.monitor.check()).issue).toBe("CONTROLLER_STATUS_MISSING");
  f.inspect.mockRejectedValueOnce(new Error("synthetic private detail"));
  expect(await f.monitor.check()).toMatchObject({
    state: "unavailable",
    issue: "STATUS_UNAVAILABLE",
  });
});

it("coalesces simultaneous checks and caches briefly rather than repeatedly invoking inspect", async () => {
  const f = await fixture();
  const monitor = new Rly0DesktopCompatibility({ ...f.options, cacheMs: 5000 });
  await Promise.all([monitor.check(), monitor.check(), monitor.check()]);
  await monitor.check();
  expect(f.inspect).toHaveBeenCalledTimes(1);
  f.setNow(206000);
  await monitor.check();
  expect(f.inspect).toHaveBeenCalledTimes(2);
});
