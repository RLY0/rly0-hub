import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  AGENT_CLI_BUSY_METHOD,
  AGENT_CLI_RELEASE_METHOD,
  AGENT_CLI_INSPECT_METHOD,
} from "@codexhost/shared-contracts";
import {
  AgentCliUpdateAdmission,
  acquireAgentCliFence,
  cleanAgentCliFences,
  agentCliUpdateFence,
  assertAgentCliAvailable,
} from "../src/rly0-agents/cli-update-admission.js";
import { AgentCliUpdates } from "../src/rly0-hub-service/agent-cli-updates.js";
import { AgentInstaller } from "../src/rly0-agents/agent-installer.js";
import { GrokAddLogin } from "../src/rly0-hub-service/grok-add-login.js";
import { createHubHostRequests } from "../src/rly0-hub-service/host-console-routes.js";
import { consoleHostDescriptorDirectory } from "../src/console-control-server.js";
import {
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
  writeRequest,
  requestId,
} from "./app-server-host-fixture.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing synthetic fixture");
  return value;
}
const syntheticOwner = { start: () => "synthetic-start", signal: () => undefined };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function isolated() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-cli-host-"));
  roots.push(root);
  return {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CODEXHOST_DATA_DIR: root,
    RLY0_MEMORY_DIR: path.join(root, "memory"),
    RLY0_SKIP_LEGACY_IMPORT: "1",
  };
}
describe("Host CLI update admission", () => {
  it("requires the update fence, releases idle sessions with default idle release disabled, and fences public inspection", async () => {
    const env = await isolated();
    const f = createFixture({ environment: env });
    let release: (() => Promise<void>) | null = null;
    try {
      await startPiThread(f);
      const close = vi.spyOn(required(f.adapter.sessions[0]), "close");
      expect(
        await f.host.handleConsoleRequest(AGENT_CLI_RELEASE_METHOD, { agent: "pi" }),
      ).toMatchObject({ error: { code: -32072 } });
      expect(
        await f.host.handleConsoleRequest(AGENT_CLI_INSPECT_METHOD, { agent: "pi" }),
      ).toMatchObject({ error: { code: -32072 } });
      expect(close).not.toHaveBeenCalled();
      release = await acquireAgentCliFence(env, "pi", syntheticOwner);
      expect(await f.host.handleConsoleRequest(AGENT_CLI_RELEASE_METHOD, { agent: "pi" })).toEqual({
        result: { guarded: true, busy: false },
      });
      expect(close).toHaveBeenCalledTimes(1);
      const before = f.adapter.inspectionCalls;
      expect(
        await f.host.handleConsoleRequest("codexhost/harness/inspect", {
          harnessId: "pi",
          refresh: true,
        }),
      ).toMatchObject({
        error: { code: -32072, message: expect.stringContaining("AGENT_CLI_UPDATE_BUSY") },
      });
      expect(f.adapter.inspectionCalls).toBe(before);
      expect(
        await f.host.handleConsoleRequest(AGENT_CLI_INSPECT_METHOD, { agent: "pi" }),
      ).toMatchObject({ result: { status: "ready" } });
      expect(f.adapter.inspectionCalls).toBe(before + 1);
    } finally {
      await release?.();
      await stopFixture(f);
    }
  });
  it("never closes a running turn or a session doing native background work, and ignores other assistants", async () => {
    const env = await isolated();
    const f = createFixture({ environment: env });
    let release: (() => Promise<void>) | null = null;
    try {
      const thread = await startPiThread(f);
      const session = required(f.adapter.sessions[0]);
      const close = vi.spyOn(session, "close");
      await startPiTurn(f, thread);
      release = await acquireAgentCliFence(env, "pi", syntheticOwner);
      expect(
        await f.host.handleConsoleRequest(AGENT_CLI_RELEASE_METHOD, { agent: "pi" }),
      ).toMatchObject({ result: { busy: true } });
      expect(close).not.toHaveBeenCalled();
      session.succeedTurn();
      await vi.waitFor(async () =>
        expect(
          await f.host.handleConsoleRequest(AGENT_CLI_BUSY_METHOD, { agent: "pi" }),
        ).toMatchObject({ result: { busy: false } }),
      );
      Object.assign(session, { hasBackgroundWork: () => true });
      expect(
        await f.host.handleConsoleRequest(AGENT_CLI_RELEASE_METHOD, { agent: "pi" }),
      ).toMatchObject({ result: { busy: true } });
      expect(close).not.toHaveBeenCalled();
      const other = await acquireAgentCliFence(env, "opencode", syntheticOwner);
      try {
        expect(
          await f.host.handleConsoleRequest(AGENT_CLI_RELEASE_METHOD, { agent: "opencode" }),
        ).toMatchObject({ result: { busy: false } });
        expect(close).not.toHaveBeenCalled();
      } finally {
        await other?.();
      }
    } finally {
      await release?.();
      await stopFixture(f);
    }
  });
  it("reports running turns per harness, blocks a new turn under its fence, then admits it after release", async () => {
    const env = await isolated();
    const f = createFixture({ environment: env });
    try {
      const thread = await startPiThread(f);
      expect(await f.host.handleConsoleRequest(AGENT_CLI_BUSY_METHOD, { agent: "pi" })).toEqual({
        result: { guarded: true, busy: false },
      });
      await startPiTurn(f, thread);
      expect(await f.host.handleConsoleRequest(AGENT_CLI_BUSY_METHOD, { agent: "pi" })).toEqual({
        result: { guarded: true, busy: true },
      });
      expect(
        await f.host.handleConsoleRequest(AGENT_CLI_BUSY_METHOD, { agent: "opencode" }),
      ).toEqual({ result: { guarded: true, busy: false } });
      required(f.adapter.sessions[0]).succeedTurn();
      await vi.waitFor(async () =>
        expect(
          await f.host.handleConsoleRequest(AGENT_CLI_BUSY_METHOD, { agent: "pi" }),
        ).toMatchObject({ result: { busy: false } }),
      );
      const release = await acquireAgentCliFence(env, "pi", syntheticOwner);
      expect(release).not.toBeNull();
      writeRequest(f.desktopInput, {
        id: 10,
        method: "turn/start",
        params: { threadId: thread, input: [{ type: "text", text: "synthetic blocked" }] },
      });
      expect(await f.collector.waitFor((m) => requestId(m, 10))).toMatchObject({
        error: { message: expect.stringContaining("AGENT_CLI_UPDATE_BUSY") },
      });
      writeRequest(f.desktopInput, {
        id: 11,
        method: "thread/start",
        params: { model: "codexhost/pi-native", cwd: "/synthetic" },
      });
      expect(await f.collector.waitFor((m) => requestId(m, 11))).toHaveProperty("error");
      await required(release)();
      await startPiTurn(f, thread, 12);
      required(f.adapter.sessions[0]).succeedTurn();
      expect(
        await f.host.handleConsoleRequest(AGENT_CLI_BUSY_METHOD, { agent: "claude-code" }),
      ).toMatchObject({ error: { code: -32602 } });
    } finally {
      await stopFixture(f);
    }
  });
  it("only one of simultaneous updater owners may hold an agent fence", async () => {
    const env = await isolated();
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => acquireAgentCliFence(env, "pi", syntheticOwner)),
    );
    expect(claims.filter(Boolean).length).toBeLessThanOrEqual(1);
    await Promise.all(claims.map((release) => release?.()));
    const release = await acquireAgentCliFence(env, "pi", syntheticOwner);
    expect(release).not.toBeNull();
    expect(() => assertAgentCliAvailable(env, "pi")).toThrow("AGENT_CLI_UPDATE_BUSY");
    expect(() => assertAgentCliAvailable(env, "claude-code")).not.toThrow();
    await required(release)();
    expect(() => assertAgentCliAvailable(env, "pi")).not.toThrow();
  });
  it("reclaims dead and malformed abandoned owners instead of permanently fencing the agent", async () => {
    const env = await isolated();
    const directory = agentCliUpdateFence(env, "pi");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "dead.json"), JSON.stringify({ pid: 42 }));
    const release = await acquireAgentCliFence(env, "pi", syntheticOwner);
    expect(release).not.toBeNull();
    await required(release)();
    await writeFile(path.join(directory, "unknown.json"), "synthetic malformed");
    const repaired = await acquireAgentCliFence(env, "pi", syntheticOwner);
    expect(repaired).not.toBeNull();
    await required(repaired)();
  });
  it("enumerates all live local Hosts instead of discarding older windows", async () => {
    const env = await isolated();
    const directory = consoleHostDescriptorDirectory(env);
    await mkdir(directory, { recursive: true });
    for (let i = 1; i <= 3; i++)
      await writeFile(
        path.join(directory, `host-${i}.json`),
        JSON.stringify({
          schemaVersion: 1,
          pid: i,
          port: 3000 + i,
          token: "a".repeat(64),
          startedAt: i,
        }),
      );
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ result: { guarded: true, busy: false } }), { status: 200 }),
    );
    const hosts = await createHubHostRequests({
      environment: env,
      isAlive: (pid) => pid !== 2,
      fetchImpl,
    });
    expect(hosts).toHaveLength(2);
    await Promise.all(hosts.map((host) => host(AGENT_CLI_BUSY_METHOD, { agent: "pi" })));
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:3003/rpc",
      "http://127.0.0.1:3001/rpc",
    ]);
  });
});

describe("review 1 stale locks and entrypoints (synthetic)", () => {
  it.each(["", "{broken", "null", "{}", '{"pid":42}', '{"pid":0,"startedAt":"x","id":"x"}'])(
    "cleans an abandoned malformed/legacy lock: %s",
    async (text) => {
      const env = await isolated();
      const directory = agentCliUpdateFence(env, "pi");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "abandoned.json"), text);
      expect(() => assertAgentCliAvailable(env, "pi", syntheticOwner)).not.toThrow();
      const release = await acquireAgentCliFence(env, "pi", syntheticOwner);
      expect(release).not.toBeNull();
      await required(release)();
    },
  );
  it.each(["dead", "eperm", "reused", "same-pid-orphan"])(
    "reclaims %s owner identity",
    async (kind) => {
      const env = await isolated();
      const directory = agentCliUpdateFence(env, "pi");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "old.json"),
        JSON.stringify({
          pid: kind === "same-pid-orphan" ? process.pid : 424242,
          id: "synthetic-old-owner",
          startedAt: "old-start",
        }),
      );
      const probe = {
        start: () => "new-start",
        signal: () => {
          if (kind === "dead" || kind === "eperm")
            throw Object.assign(new Error("synthetic"), {
              code: kind === "dead" ? "ESRCH" : "EPERM",
            });
        },
      };
      expect(() => assertAgentCliAvailable(env, "pi", probe)).not.toThrow();
    },
  );
  it("keeps a matching live owner fenced without evicting it", async () => {
    const env = await isolated();
    const directory = agentCliUpdateFence(env, "pi");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "live.json"),
      JSON.stringify({ pid: 424242, id: "synthetic-live-owner", startedAt: "same-start" }),
    );
    const probe = { start: () => "same-start", signal: () => undefined };
    cleanAgentCliFences(env, probe);
    expect(() => assertAgentCliAvailable(env, "pi", probe)).toThrow("正在更新");
    expect(await acquireAgentCliFence(env, "pi", probe)).toBeNull();
  });
  it("cleans stale locks at startup even when disabled with no transaction journal", async () => {
    const env = await isolated();
    const directory = agentCliUpdateFence(env, "pi");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "dead.json"), "");
    await writeFile(
      path.join(env.CODEXHOST_DATA_DIR, "agent-cli-updates.json"),
      JSON.stringify({ schemaVersion: 1, enabled: false, agents: [], pending: {} }),
    );
    const driver = {
      inspect: vi.fn(),
      version: vi.fn(),
      install: vi.fn(),
      ready: vi.fn(),
      busy: vi.fn(),
    };
    const manager = new AgentCliUpdates({ environment: env, driver, ownerProbe: syntheticOwner });
    await manager.status();
    expect(() => assertAgentCliAvailable(env, "pi", syntheticOwner)).not.toThrow();
    await manager.stop();
    expect(driver.install).not.toHaveBeenCalled();
  });
  it("fences webUi.open, account and credits inspections, returning readable retryable state", async () => {
    const env = await isolated();
    const webOpen = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const inspectAccount = vi.fn(async () => null);
    const inspectAccounts = vi.fn(async () => []);
    const refreshCredits = vi.fn(async () => null);
    const adapter = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("pi")), {
      webUi: { open: webOpen },
      inspectAccount,
      inspectAccounts,
      refreshCredits,
    });
    const admission = new AgentCliUpdateAdmission(env);
    const guarded = admission.wrap(adapter);
    const release = await acquireAgentCliFence(env, "pi", syntheticOwner);
    try {
      expect(await guarded.webUi?.open()).toMatchObject({
        ok: false,
        error: { retryable: true, message: expect.stringContaining("正在更新") },
      });
      await expect(guarded.inspectAccount?.()).rejects.toMatchObject({ code: -32072 });
      await expect(guarded.inspectAccounts?.()).rejects.toMatchObject({ code: -32072 });
      await expect(guarded.refreshCredits?.()).rejects.toMatchObject({ code: -32072 });
      expect(webOpen).not.toHaveBeenCalled();
      expect(inspectAccount).not.toHaveBeenCalled();
    } finally {
      await required(release)();
    }
    expect(await guarded.webUi?.open()).toMatchObject({ ok: true });
    expect(await guarded.inspectAccount?.()).toBeNull();
    expect(admission.busy("pi")).toBe(false);
  });
  it("fences Hub terminal login and Grok add-login before any native command", async () => {
    const env = await isolated();
    const openTerminal = vi.fn(async () => true);
    const installer = new AgentInstaller({
      environment: env,
      runner: { run: vi.fn(), openTerminal },
    });
    const release = await acquireAgentCliFence(env, "grok", syntheticOwner);
    const spawnProcess = vi.fn();
    const grok = new GrokAddLogin({
      environment: async () => env,
      openUrl: vi.fn(),
      spawnProcess,
      core: { grokAccounts: vi.fn(), getProxySettings: () => ({ mode: "direct" }) },
    });
    try {
      await expect(installer.openLogin("grok")).rejects.toThrow("正在更新");
      await expect(grok.start()).rejects.toMatchObject({ code: -32072 });
      expect(openTerminal).not.toHaveBeenCalled();
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(grok.active).toBe(false);
    } finally {
      grok.close();
      await required(release)();
    }
    expect(await installer.openLogin("grok")).toBe(true);
  });
});
