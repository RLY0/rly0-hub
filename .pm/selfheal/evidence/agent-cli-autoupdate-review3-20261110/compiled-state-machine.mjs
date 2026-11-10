// Synthetic state-machine probes against compiled dist, following review #3's loop/scen/idle.
// No real CLI/npm/system command or Hub service is started.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-review3-compiled-"));
const fromDist = (file) => import(pathToFileURL(path.resolve("packages", file)).href);
const { AgentCliUpdates, AGENT_CLI_CHECK_INTERVAL_MS } = await fromDist(
  "host-runtime/dist/rly0-hub-service/agent-cli-updates.js",
);
const { createAgentCliUpdateDriver } = await fromDist(
  "host-runtime/dist/rly0-hub-service/agent-cli-update-driver.js",
);
const { ExternalThreadRuntime } = await fromDist("host-runtime/dist/external-thread-runtime.js");
const { FakeHarnessAdapter, FakeHarnessSession } = await fromDist(
  "harness-adapter/dist/testing.js",
);
const { agentCliUpdateIdSchema, AGENT_CLI_BUSY_METHOD, AGENT_CLI_RELEASE_METHOD } = await fromDist(
  "shared-contracts/dist/index.js",
);
const ownerProbe = { start: () => "synthetic-start", signal: () => undefined };
const env = (name) => {
  const home = path.join(root, name);
  return {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, "codex"),
    CODEXHOST_DATA_DIR: home,
    RLY0_MEMORY_DIR: path.join(home, "memory"),
    RLY0_SKIP_LEGACY_IMPORT: "1",
  };
};
const plan = (name) => ({
  kind: "npm",
  executable: path.join(root, "bin", name),
  npm: path.join(root, "bin/npm"),
  prefix: root,
  packageName: `synthetic-${name}`,
});
const callbacks = [];
const originalInterval = globalThis.setInterval;
globalThis.setInterval = (callback) => {
  callbacks.push(callback);
  return originalInterval(() => {}, 1e9);
};
async function settled(manager) {
  await new Promise((resolve) => setImmediate(resolve));
  const deadline = Date.now() + 10000;
  while ((await manager.status()).checking) {
    if (Date.now() > deadline) throw new Error("Synthetic check did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const results = [];
async function scenario(name, run) {
  try {
    results.push({ name, pass: true, ...(await run()) });
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
  }
}
try {
  for (const restoredFailure of ["COMMAND_TIMEOUT", "HOST_UNAVAILABLE"]) {
    await scenario(`N1-${restoredFailure}`, async () => {
      let now = 0;
      let current = "1.0.0";
      let fresh = false;
      const installs = [];
      const driver = {
        inspect: async (agent) =>
          agent === "pi"
            ? {
                currentVersion: current,
                latestVersion: "1.1.0",
                plan: plan(agent),
                canUpdate: true,
                reason: null,
              }
            : null,
        version: async () => current,
        install: async (_plan, v) => {
          installs.push(v);
          current = v;
          fresh = true;
        },
        busy: async () => false,
        ready: async () => {
          if (!fresh) return true;
          fresh = false;
          throw new Error(current === "1.1.0" ? "COMMAND_TIMEOUT" : restoredFailure);
        },
      };
      const manager = new AgentCliUpdates({
        environment: env(restoredFailure),
        driver,
        ownerProbe,
        now: () => now,
      });
      const index = callbacks.length;
      try {
        await manager.start();
        await settled(manager);
        const counts = [installs.length];
        for (let tick = 0; tick < 4; tick++) {
          now += 60000;
          callbacks[index]();
          await settled(manager);
          counts.push(installs.length);
        }
        const entry = (await manager.status()).agents.find((e) => e.agent === "pi");
        console.log(
          JSON.stringify({ name: `N1-${restoredFailure}`, minuteInstallCounts: counts, entry }),
        );
        assert.deepEqual(counts, [2, 2, 2, 2, 2]);
        assert.equal(entry.recoveryPending, false);
        assert.deepEqual(entry.badVersions, []);
        now = AGENT_CLI_CHECK_INTERVAL_MS;
        callbacks[index]();
        await settled(manager);
        assert.equal(installs.length, 4);
        await manager.check("pi");
        assert.equal(installs.length, 6);
        return { minuteInstallCounts: counts, afterDaily: 4, afterManual: installs.length };
      } finally {
        await manager.stop();
      }
    });
  }
  await scenario("N2-external-occupancy-16-agents-6-rounds", async () => {
    let releases = 0;
    let installs = 0;
    let scans = 0;
    const driven = createAgentCliUpdateDriver({
      environment: async () => env("external"),
      platform: "darwin",
      get: async () => {
        throw new Error("Unexpected synthetic HTTP call");
      },
      run: async () => {
        throw new Error("Unexpected synthetic system/npm command");
      },
      hosts: async () => [
        async (method) => {
          if (method === AGENT_CLI_RELEASE_METHOD) releases++;
          else assert.equal(method, AGENT_CLI_BUSY_METHOD);
          return { guarded: true, busy: false };
        },
      ],
      installing: () => false,
      occupied: async () => {
        scans++;
        return true;
      },
    });
    const driver = {
      ...driven,
      inspect: async (agent) => ({
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        plan: plan(agent),
        canUpdate: true,
        reason: null,
      }),
      install: async () => {
        installs++;
      },
      version: async () => "1.0.0",
      ready: async () => true,
    };
    const manager = new AgentCliUpdates({ environment: env("external"), driver, ownerProbe });
    const index = callbacks.length;
    try {
      await manager.start();
      await settled(manager);
      for (let tick = 0; tick < 5; tick++) {
        callbacks[index]();
        await settled(manager);
      }
      const metrics = {
        agents: agentCliUpdateIdSchema.options.length,
        rounds: 6,
        releases,
        scans,
        installs,
      };
      console.log(JSON.stringify({ name: "N2", ...metrics }));
      assert.equal(releases, 0);
      assert.equal(installs, 0);
      assert.equal(scans, 96);
      assert.ok((await manager.status()).agents.every((e) => e.result === "skipped-busy"));
      return metrics;
    } finally {
      await manager.stop();
    }
  });
  await scenario("N3-real-readonly-snapshot-and-prewarm", async () => {
    const adapter = Object.assign(new FakeHarnessAdapter("pi"), {
      subagents: { readSnapshot: async () => ({ ok: true, value: { turns: [] } }) },
    });
    const opened = await adapter.open({ kind: "create", cwd: root });
    assert.ok(opened.ok);
    const record = {
      formatVersion: 1,
      revision: 1,
      hostThreadId: "parent",
      createRequestId: "parent",
      harnessId: "pi",
      state: "ready",
      nativeSessionRef: opened.value.initialState.nativeRef,
      cwd: root,
      title: "synthetic",
      archived: false,
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
      turnMappings: [],
      createdAt: "2026-11-10T00:00:00.000Z",
      updatedAt: "2026-11-10T00:00:00.000Z",
    };
    const child = {
      ...record,
      hostThreadId: "child",
      subagent: { parentHostThreadId: "parent", nativeSubagentId: "child" },
    };
    const records = new Map([
      ["parent", record],
      ["child", child],
    ]);
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", adapter]]),
      environment: env("snapshots"),
      repository: {
        find: async (id) => records.get(id),
        alignSnapshot: async (r) => ({ record: r, turns: [] }),
        sessionTreeId: async (r) => r.hostThreadId,
      },
      consumeOutputs: async (thread) => {
        for await (const output of thread.session.outputs) void output;
      },
      diagnose: () => undefined,
      idleRelease: {
        queue: new (
          await fromDist("host-runtime/dist/desktop-request-queue.js")
        ).DesktopRequestQueue(),
        canRelease: () => true,
      },
    });
    runtime.register({
      record,
      session: opened.value,
      sessionId: "parent",
      thread: { id: "parent" },
      turns: [],
    });
    try {
      assert.equal((await runtime.resolve("child")).kind, "external");
      assert.equal(adapter.sessions.length, 1); // Child used ReadonlySnapshotSession, no CLI open.
      const released = await runtime.idleRelease.releaseForUpdate("pi");
      const metrics = {
        released,
        remaining: runtime.values().map((t) => t.id),
        nativeOpens: adapter.sessions.length,
      };
      console.log(JSON.stringify({ name: "N3-child", ...metrics }));
      assert.equal(released, true);
      assert.deepEqual(metrics.remaining, ["child"]);
      const draft = new FakeHarnessSession("pi");
      runtime.register({
        record: { ...record, hostThreadId: "draft", state: "creating", nativeSessionRef: null },
        session: draft,
        sessionId: "draft",
        thread: { id: "draft" },
        turns: [],
      });
      assert.equal(await runtime.idleRelease.releaseForUpdate("pi"), false);
      return { ...metrics, realPrewarmBlocks: true };
    } finally {
      runtime.idleRelease.stop();
      for (const thread of runtime.values()) await thread.session.close();
    }
  });
} finally {
  globalThis.setInterval = originalInterval;
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ synthetic: true, results }, null, 2));
process.exitCode = results.every((result) => result.pass) ? 0 : 1;
