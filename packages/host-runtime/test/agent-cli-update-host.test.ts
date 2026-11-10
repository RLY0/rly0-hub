import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_CLI_BUSY_METHOD } from "@codexhost/shared-contracts";
import {
  acquireAgentCliFence,
  agentCliUpdateFence,
  assertAgentCliAvailable,
} from "../src/rly0-agents/cli-update-admission.js";
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
      const release = await acquireAgentCliFence(env, "pi");
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
      Array.from({ length: 6 }, () => acquireAgentCliFence(env, "pi", () => true)),
    );
    expect(claims.filter(Boolean).length).toBeLessThanOrEqual(1);
    await Promise.all(claims.map((release) => release?.()));
    const release = await acquireAgentCliFence(env, "pi");
    expect(release).not.toBeNull();
    expect(() => assertAgentCliAvailable(env, "pi")).toThrow("AGENT_CLI_UPDATE_BUSY");
    expect(() => assertAgentCliAvailable(env, "claude-code")).not.toThrow();
    await required(release)();
    expect(() => assertAgentCliAvailable(env, "pi")).not.toThrow();
  });
  it("reclaims only dead unique owners and keeps malformed or live owners fenced", async () => {
    const env = await isolated();
    const directory = agentCliUpdateFence(env, "pi");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "dead.json"), JSON.stringify({ pid: 42 }));
    const release = await acquireAgentCliFence(env, "pi", () => false);
    expect(release).not.toBeNull();
    await required(release)();
    await writeFile(path.join(directory, "unknown.json"), "synthetic malformed");
    expect(await acquireAgentCliFence(env, "pi", () => false)).toBeNull();
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
