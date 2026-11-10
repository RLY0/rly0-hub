import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCliUpdateStatusSchema } from "@codexhost/shared-contracts";
import {
  AgentCliUpdates,
  AGENT_CLI_CHECK_INTERVAL_MS,
} from "../src/rly0-hub-service/agent-cli-updates.js";
import type {
  AgentCliUpdateDriver,
  AgentCliPlan,
  AgentCliInstallation,
} from "../src/rly0-hub-service/agent-cli-update-driver.js";
import { assertAgentCliAvailable } from "../src/rly0-agents/cli-update-admission.js";

const roots: string[] = [];
const managers: AgentCliUpdates[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-agent-cli-"));
  roots.push(root);
  const env = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CODEXHOST_DATA_DIR: root,
    RLY0_MEMORY_DIR: path.join(root, "memory"),
    RLY0_SKIP_LEGACY_IMPORT: "1",
  };
  const plan: AgentCliPlan = {
    kind: "npm",
    executable: path.join(root, "bin", "pi"),
    npm: path.join(root, "bin", "npm"),
    prefix: root,
    packageName: "@earendil-works/pi-coding-agent",
  };
  let current = "1.0.0";
  let latest = "1.1.0";
  const driver = {
    inspect: vi.fn<AgentCliUpdateDriver["inspect"]>(
      async (): Promise<AgentCliInstallation | null> => ({
        currentVersion: current,
        latestVersion: latest,
        plan,
        canUpdate: true,
        reason: null,
      }),
    ),
    version: vi.fn(async () => current),
    install: vi.fn(async (_plan: AgentCliPlan, version: string) => {
      current = version;
    }),
    busy: vi.fn<AgentCliUpdateDriver["busy"]>(async () => false),
    ready: vi.fn<AgentCliUpdateDriver["ready"]>(async () => true),
  } satisfies AgentCliUpdateDriver;
  const manager = new AgentCliUpdates({ environment: env, driver, now: () => 123456 });
  managers.push(manager);
  return {
    root,
    env,
    plan,
    driver,
    manager,
    setCurrent: (v: string) => {
      current = v;
    },
    setLatest: (v: string) => {
      latest = v;
    },
    entry: async () => {
      const entry = (await manager.status()).agents.find((entry) => entry.agent === "pi");
      if (!entry) throw new Error("Missing synthetic pi");
      return entry;
    },
  };
}
describe("synthetic isolated CLI updates", () => {
  it("defaults on and preserves the original prefix through update, readback and ready inspection", async () => {
    const f = await fixture();
    expect(agentCliUpdateStatusSchema.parse(await f.manager.status()).enabled).toBe(true);
    f.driver.install.mockImplementation(async (plan, version) => {
      expect(plan.prefix).toBe(f.root);
      expect(() => assertAgentCliAvailable(f.env, "pi")).toThrow("AGENT_CLI_UPDATE_BUSY");
      f.setCurrent(version);
    });
    await f.manager.check("pi");
    expect(await f.entry()).toMatchObject({
      currentVersion: "1.1.0",
      latestVersion: "1.1.0",
      result: "updated",
      phase: "idle",
      lastUpdatedAt: 123456,
      badVersions: [],
    });
    expect(f.driver.ready).toHaveBeenCalledWith("pi");
    expect(() => assertAgentCliAvailable(f.env, "pi")).not.toThrow();
  });
  it("rolls back a non-ready update, persists the bad version, and never installs it again", async () => {
    const f = await fixture();
    f.driver.ready.mockResolvedValueOnce(false).mockResolvedValue(true);
    await f.manager.check("pi");
    expect(f.driver.install.mock.calls.map((call) => call[1])).toEqual(["1.1.0", "1.0.0"]);
    expect(await f.entry()).toMatchObject({
      currentVersion: "1.0.0",
      result: "rolled-back",
      causeCode: "CONNECTION_NOT_READY",
      badVersions: ["1.1.0"],
      lastUpdatedAt: null,
    });
    const restarted = new AgentCliUpdates({ environment: f.env, driver: f.driver });
    managers.push(restarted);
    await restarted.check("pi");
    expect(f.driver.install).toHaveBeenCalledTimes(2);
    expect((await restarted.status()).agents.find((a) => a.agent === "pi")?.result).toBe(
      "skipped-bad-version",
    );
    f.setLatest("1.2.0");
    await f.manager.check("pi");
    expect(await f.entry()).toMatchObject({
      result: "updated",
      currentVersion: "1.2.0",
      badVersions: ["1.1.0"],
    });
  });
  it.each(["npm partial install", "COMMAND_PERMISSION_DENIED"])(
    "restores the original after %s",
    async (failure) => {
      const f = await fixture();
      f.driver.install.mockImplementationOnce(async () => {
        f.setCurrent("1.1.0");
        throw new Error(failure);
      });
      await f.manager.check("pi");
      expect(await f.entry()).toMatchObject({
        result: "rolled-back",
        currentVersion: "1.0.0",
        badVersions: ["1.1.0"],
        causeCode: failure === "COMMAND_PERMISSION_DENIED" ? "PERMISSION_DENIED" : "INSTALL_FAILED",
      });
    },
  );
  it("reports rollback failure and recovers the saved version before any newer update", async () => {
    const f = await fixture();
    f.driver.ready.mockResolvedValueOnce(false);
    f.driver.install
      .mockImplementationOnce(async () => f.setCurrent("1.1.0"))
      .mockRejectedValueOnce(new Error("synthetic disk error"));
    await f.manager.check("pi");
    expect(await f.entry()).toMatchObject({
      result: "failed",
      errorCode: "ROLLBACK_FAILED",
      badVersions: ["1.1.0"],
    });
    const disk = JSON.parse(await readFile(path.join(f.root, "agent-cli-updates.json"), "utf8"));
    expect(disk.pending.pi.previous).toBe("1.0.0");
    f.driver.ready.mockResolvedValue(true);
    f.setLatest("1.2.0");
    const restarted = new AgentCliUpdates({ environment: f.env, driver: f.driver });
    managers.push(restarted);
    await restarted.setEnabled(false);
    await restarted.check("pi");
    expect(f.driver.install.mock.calls.map((call) => call[1])).toEqual(["1.1.0", "1.0.0", "1.0.0"]);
    expect((await restarted.status()).agents.find((a) => a.agent === "pi")).toMatchObject({
      result: "rolled-back",
      causeCode: "INTERRUPTED",
    });
    expect(f.driver.inspect).toHaveBeenCalledTimes(1);
  });
  it("defers a busy agent and updates after it becomes idle", async () => {
    const f = await fixture();
    f.driver.busy.mockResolvedValueOnce(true);
    await f.manager.check("pi");
    expect(await f.entry()).toMatchObject({ result: "skipped-busy", errorCode: "BUSY" });
    expect(f.driver.install).not.toHaveBeenCalled();
    await f.manager.check("pi");
    expect(await f.entry()).toMatchObject({ result: "updated" });
  });
  it("never installs without a trustworthy Host busy result", async () => {
    const f = await fixture();
    f.driver.busy.mockRejectedValue(new Error("HOST_UNAVAILABLE"));
    await f.manager.check("pi");
    expect(await f.entry()).toMatchObject({ result: "failed", errorCode: "HOST_UNAVAILABLE" });
    expect(f.driver.install).not.toHaveBeenCalled();
  });
  it("restores the old version when verification throws or reads back a different version", async () => {
    const f = await fixture();
    f.driver.install.mockImplementationOnce(async () => f.setCurrent("1.0.9"));
    await f.manager.check("pi");
    expect(await f.entry()).toMatchObject({
      result: "rolled-back",
      causeCode: "VERSION_MISMATCH",
      currentVersion: "1.0.0",
    });
  });
  it("does not overwrite an installation changed between discovery and admission", async () => {
    const f = await fixture();
    f.driver.version.mockResolvedValueOnce("1.0.9");
    await f.manager.check("pi");
    expect(await f.entry()).toMatchObject({ errorCode: "VERSION_MISMATCH" });
    expect(f.driver.install).not.toHaveBeenCalled();
  });
  it("persists off, never inspects or runs commands while disabled, and can re-enable", async () => {
    const f = await fixture();
    await f.manager.setEnabled(false);
    const restarted = new AgentCliUpdates({ environment: f.env, driver: f.driver });
    managers.push(restarted);
    await restarted.check("pi");
    expect(f.driver.inspect).not.toHaveBeenCalled();
    expect((await restarted.status()).enabled).toBe(false);
    await restarted.setEnabled(true);
    await restarted.check("pi");
    expect(f.driver.install).toHaveBeenCalledTimes(1);
  });
  it("honours disabling while the busy check is in flight", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<boolean>();
    f.driver.busy.mockReturnValueOnce(gate.promise);
    const checking = f.manager.check("pi");
    await vi.waitFor(() => expect(f.driver.busy).toHaveBeenCalled());
    await f.manager.setEnabled(false);
    gate.resolve(false);
    await checking;
    expect(f.driver.install).not.toHaveBeenCalled();
  });
  it("coalesces concurrent checks and waits through rollback on stop", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<undefined>();
    f.driver.install.mockImplementationOnce(async () => {
      await gate.promise;
      f.setCurrent("1.1.0");
    });
    const first = f.manager.check("pi");
    await vi.waitFor(() => expect(f.driver.install).toHaveBeenCalled());
    const second = f.manager.check("pi");
    const stopping = f.manager.stop();
    expect((await f.manager.status()).checking).toBe(true);
    f.driver.ready.mockResolvedValueOnce(false).mockResolvedValue(true);
    gate.resolve(undefined);
    await Promise.all([first, second, stopping]);
    expect(f.driver.install).toHaveBeenCalledTimes(2);
  });
  it("returns from the manual trigger before an update completes", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<boolean>();
    f.driver.busy.mockReturnValueOnce(gate.promise);
    expect((await f.manager.requestCheck("pi")).checking).toBe(true);
    gate.resolve(false);
    await f.manager.check("pi");
  });
  it("checks at startup and daily, retrying busy work with the cached latest version", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let now = 0;
    const manager = new AgentCliUpdates({ environment: f.env, driver: f.driver, now: () => now });
    managers.push(manager);
    f.driver.inspect.mockImplementation(async (agent) =>
      agent === "pi"
        ? {
            currentVersion: "1.0.0",
            latestVersion: "1.1.0",
            plan: f.plan,
            canUpdate: true,
            reason: null,
          }
        : null,
    );
    f.driver.busy.mockResolvedValue(true);
    await manager.start();
    await manager.check();
    expect(f.driver.inspect.mock.calls.some((call) => call[0] === "pi")).toBe(true);
    f.driver.inspect.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    await manager.check("pi", true);
    expect(f.driver.inspect).toHaveBeenCalledWith("pi", "1.1.0");
    f.driver.inspect.mockClear();
    now = AGENT_CLI_CHECK_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(60_000);
    await manager.check();
    expect(f.driver.inspect).toHaveBeenCalledWith("pi", undefined);
  });
  it("fails closed on corrupt state instead of silently re-enabling", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "agent-cli-updates.json"), "corrupt synthetic");
    await expect(f.manager.check("pi")).rejects.toThrow("STATE_INVALID");
    expect(f.driver.inspect).not.toHaveBeenCalled();
  });
  it("does not install if the write-ahead transaction cannot be persisted", async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, `agent-cli-updates.json.${process.pid}.tmp`));
    await expect(f.manager.check("pi")).rejects.toThrow("STATE_WRITE_FAILED");
    expect(f.driver.install).not.toHaveBeenCalled();
    expect(() => assertAgentCliAvailable(f.env, "pi")).not.toThrow();
  });
  it("still restores the old version if saving the blacklist temporarily fails", async () => {
    const f = await fixture();
    const blocked = path.join(f.root, `agent-cli-updates.json.${process.pid}.tmp`);
    f.driver.ready.mockImplementationOnce(async () => {
      await mkdir(blocked);
      return false;
    });
    f.driver.install.mockImplementation(async (_plan, version) => {
      void _plan;
      f.setCurrent(version);
      if (version === "1.0.0") await rm(blocked, { recursive: true });
    });
    await f.manager.check("pi");
    expect(await f.entry()).toMatchObject({
      result: "rolled-back",
      errorCode: "STATE_WRITE_FAILED",
      currentVersion: "1.0.0",
      badVersions: ["1.1.0"],
    });
    expect(
      JSON.parse(await readFile(path.join(f.root, "agent-cli-updates.json"), "utf8")).pending,
    ).toEqual({});
  });
  it("never downgrades just because the registry latest tag is older", async () => {
    const f = await fixture();
    f.setCurrent("2.0.0");
    await f.manager.check("pi");
    expect(await f.entry()).toMatchObject({ result: "up-to-date" });
    expect(f.driver.install).not.toHaveBeenCalled();
  });
});
