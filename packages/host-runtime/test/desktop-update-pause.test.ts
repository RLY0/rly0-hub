import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  watchDesktopUpdatePause,
  waitForDesktopUpdatePause,
} from "../src/codex-runtime/desktop-update-pause.js";
import { createMacCodexUpdateDriver } from "../src/rly0-hub-service/codex-sparkle.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "synthetic-native-update-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("CODEXHOST_DATA_DIR", undefined);
  const data = path.join(home, ".rly0-hub");
  await mkdir(path.join(data, "client-hosts"), { recursive: true });
  await writeFile(
    path.join(data, "client-hosts", `host-${process.pid}.json`),
    JSON.stringify({
      version: 1,
      owner: "service",
      pid: process.pid,
      port: 1,
      token: "a".repeat(64),
      epoch: randomUUID(),
      startedAt: Date.now(),
    }),
    { mode: 0o600 },
  );
  const environment = { HOME: home, USERPROFILE: home };
  const scope = {
    pauseForDesktopUpdate: vi.fn(async () => true),
    resumeAfterDesktopUpdate: vi.fn(),
  };
  let now = Date.now();
  const watcher = watchDesktopUpdatePause(scope, environment, () => now);
  cleanup.push(() => watcher.close());
  const leaseId = randomUUID();
  const ack = path.join(data, "codex-update-native-paused.json");
  async function arm(sessionLeaseId = leaseId) {
    await writeFile(
      path.join(data, "codex-update-armed.json"),
      JSON.stringify({ id: leaseId, at: now, pid: process.pid }),
    );
    await writeFile(
      path.join(data, "codex-update-session.json"),
      JSON.stringify({ closedByHub: true, leaseId: sessionLeaseId }),
    );
  }
  return {
    environment,
    scope,
    watcher,
    arm,
    ack,
    leaseId,
    data,
    expire: () => {
      now += 10_001;
    },
  };
}

it("requires the current quit session, acknowledges native exit, and releases after lease expiry", async () => {
  const f = await fixture();
  await f.arm(randomUUID());
  await f.watcher.check();
  expect(f.scope.pauseForDesktopUpdate).not.toHaveBeenCalled();
  await f.arm();
  await f.watcher.check();
  expect(JSON.parse(await readFile(f.ack, "utf8"))).toEqual({
    leaseId: f.leaseId,
    pid: process.pid,
  });
  await waitForDesktopUpdatePause(f.environment, 1);
  f.expire();
  await f.watcher.check();
  expect(f.scope.resumeAfterDesktopUpdate).toHaveBeenCalled();
  await expect(readFile(f.ack)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not quit Desktop or stop busy Web/native work when shared Host cannot pause", async () => {
  const f = await fixture();
  f.scope.pauseForDesktopUpdate.mockResolvedValue(false);
  await f.arm();
  await f.watcher.check();
  await expect(waitForDesktopUpdatePause(f.environment, 1)).rejects.toThrow(
    "CODEX_INSTALLATION_UNAVAILABLE",
  );
  const exec = vi.fn(async (file: string) =>
    file === "/usr/bin/lsappinfo" ? 'bundle path="/synthetic/Codex.app"' : "",
  );
  // Invalidate the quit lease so the real driver refuses immediately, without native commands.
  await rm(path.join(f.data, "codex-update-armed.json"));
  const driver = createMacCodexUpdateDriver({
    environment: f.environment,
    exec,
    currentVersion: async () => "26.1106.1",
    get: async () => {
      throw new Error("No network in this synthetic test");
    },
    reopen: async () => true,
    healthy: async () => true,
  });
  await expect(driver.quit()).rejects.toThrow("CODEX_INSTALLATION_UNAVAILABLE");
  expect(exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
});

it("keeps native admission paused on a damaged lease, and resumes when management is disarmed", async () => {
  const f = await fixture();
  await f.arm();
  await f.watcher.check();
  await writeFile(path.join(f.data, "codex-update-armed.json"), "damaged synthetic lease");
  await f.watcher.check();
  expect(f.scope.resumeAfterDesktopUpdate).not.toHaveBeenCalled();
  await rm(path.join(f.data, "codex-update-armed.json"));
  await f.watcher.check();
  expect(f.scope.resumeAfterDesktopUpdate).toHaveBeenCalledOnce();
});

it("quits only after pause acknowledgement and waits for native CLI exit before accepting installation", async () => {
  const f = await fixture();
  await f.arm();
  await f.watcher.check();
  let nativeRunning = true;
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/lsappinfo") return 'bundle path="/synthetic/Codex.app"';
    if (file === "/usr/bin/osascript") return args[1]?.includes(" to quit") ? "" : "false";
    if (file === "/bin/ps")
      return nativeRunning ? "/synthetic/Codex.app/Contents/Resources/codex app-server" : "";
    throw new Error("Unexpected synthetic native command");
  });
  const driver = createMacCodexUpdateDriver({
    environment: f.environment,
    exec,
    currentVersion: async () => "26.1106.1",
    get: async () => {
      throw new Error("No network in this synthetic test");
    },
    reopen: async () => true,
    healthy: async () => true,
  });
  await driver.quit();
  expect(exec.mock.calls.some(([, args]) => args[1]?.includes(" to quit"))).toBe(true);
  expect(await driver.installationStopped()).toBe(false);
  nativeRunning = false;
  expect(await driver.installationStopped()).toBe(true);
});

it("does not acknowledge a quit cancelled while the native backend is stopping", async () => {
  const f = await fixture();
  await f.arm();
  f.scope.pauseForDesktopUpdate.mockImplementationOnce(async () => {
    await rm(path.join(f.data, "codex-update-session.json"));
    return true;
  });
  await f.watcher.check();
  expect(f.scope.resumeAfterDesktopUpdate).toHaveBeenCalledOnce();
  await expect(readFile(f.ack)).rejects.toMatchObject({ code: "ENOENT" });
});
