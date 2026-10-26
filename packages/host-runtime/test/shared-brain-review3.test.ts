import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import type { DelegationControlApi } from "../src/delegation-types.js";
import { syncNativePreferences } from "../src/rly0-bridge/native-resources.js";
import { openRly0MemoryStore, rly0MemoryServerLaunch } from "../src/rly0-memory/launch.js";
import { standingPreferences } from "../src/rly0-memory/preferences.js";
import { sharedResourcesProvider } from "../src/shared-harness-resources.js";
import * as memoryResources from "../src/shared-memory-resources.js";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub50-review3-synthetic-"));
  roots.push(root);
  const env = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
    CODEXHOST_DATA_DIR: path.join(root, "hub"),
    RLY0_MEMORY_DIR: path.join(root, "memory"),
    TMP: path.join(root, "tmp"),
  };
  await Promise.all(
    [env.CODEX_HOME, env.RLY0_MEMORY_DIR, env.TMP].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
  return { root, env, store: openRly0MemoryStore(env) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("HUB-50 review2 local trust and lock recovery", () => {
  it("documents the same-user file trust boundary and retains actual Agent attribution", async () => {
    const { env, store } = await fixture();
    const entry = await store.remember({
      text: "synthetic file writer",
      scope: "global",
      agent: "synthetic-agent",
    });
    await fs.writeFile(
      path.join(env.RLY0_MEMORY_DIR, "records.jsonl"),
      JSON.stringify({ ...entry, tags: ["preference"], preferenceApproved: true }) + "\n",
    );
    expect((await standingPreferences(store)).content).toContain("agent=synthetic-agent");
    const doc = await fs.readFile(
      new URL("../../../docs/product/shared-codex-resources.md", import.meta.url),
      "utf8",
    );
    expect(doc).toContain("同一 Windows 用户");
    expect(doc).toContain("records.jsonl");
    expect(doc).toContain("没有密码学签名");
  });

  it.each(["reused-pid", "EPERM"])(
    "recovers metadata after taking the SQLite gate: %s",
    async (scenario) => {
      const { env } = await fixture();
      const lock = path.join(env.CODEXHOST_DATA_DIR, "bridge", ".native-resources.lock");
      await fs.mkdir(path.dirname(lock), { recursive: true });
      await fs.writeFile(
        lock,
        JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "synthetic-old-owner" }),
      );
      const kill = vi.spyOn(process, "kill");
      if (scenario === "EPERM")
        kill.mockImplementation(() => {
          throw Object.assign(new Error("synthetic denied"), { code: "EPERM" });
        });
      await expect(syncNativePreferences(env, false)).resolves.toEqual([]);
      expect(kill).not.toHaveBeenCalled();
      await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("HUB-50 review2 system context", () => {
  it.each(["pi", "opencode"])(
    "excludes delegated conclusions from %s system digest but retains recall",
    async (harnessId) => {
      const { root, env, store } = await fixture();
      await store.remember({
        text: "synthetic conclusion must not be system instructions",
        scope: "project",
        cwd: root,
        agent: "synthetic-child",
        tags: ["conclusion"],
        source: "delegation",
      });
      await store.remember({
        text: "synthetic ordinary fact",
        scope: "project",
        cwd: root,
        agent: "test",
      });
      await store.remember(
        {
          text: "synthetic approved preference",
          scope: "global",
          agent: "hub",
          tags: ["preference"],
        },
        true,
      );
      const part = await memoryResources.sharedMemoryPart({
        environment: env,
        project: root,
        request: { harnessId },
        entryUrl: undefined,
        forMcp: false,
        forContext: true,
      });
      expect(part.context?.content).not.toContain("synthetic conclusion");
      expect(part.context?.content).toContain("synthetic ordinary fact");
      expect(part.context?.content).toContain("synthetic approved preference");
      expect(await store.query({ cwd: root, tag: "conclusion" })).toHaveLength(1);
    },
  );

  it("drops a whole oversized preference block with an omission notice, preserving complete fitting blocks", async () => {
    const { root, env } = await fixture();
    const content =
      "[RLY/0 常驻偏好]\n" + "synthetic preference ".repeat(1800) + "\n[常驻偏好结束]";
    const spy = vi
      .spyOn(memoryResources, "sharedMemoryPart")
      .mockResolvedValue({ records: 1, context: { source: "synthetic", content } });
    const provider = sharedResourcesProvider(env);
    const large = await provider(root, { harnessId: "pi", memory: true });
    expect(large.context).not.toContain("synthetic preference");
    expect(large.context).toContain("Memory omitted");
    expect(large.context).toContain('"memory":[]');
    expect(large.context).toContain('"truncated":true');
    spy.mockResolvedValue({
      records: 1,
      context: { source: "synthetic", content: "[常驻偏好]synthetic small[常驻偏好结束]" },
    });
    expect((await provider(root, { harnessId: "pi", memory: true })).context).toContain(
      "[常驻偏好]synthetic small[常驻偏好结束]",
    );
  });
});

describe("HUB-50 review2 environment-only capability and MCP launch", () => {
  it("rejects the prior runtime's capability after a real isolated control server restart", async () => {
    const { root, env, store } = await fixture();
    const api = {
      start: vi.fn().mockResolvedValue({
        threadId: "synthetic-child",
        harnessId: "codex",
        cwd: root,
        status: "running",
      }),
      read: vi.fn().mockResolvedValue({
        threadId: "synthetic-child",
        harnessId: "codex",
        status: "completed",
        result: { text: "【可复用结论】synthetic【可复用结论结束】" },
      }),
    } as unknown as DelegationControlApi;
    const first = await startDelegationControlServer({
      token: "synthetic-runtime",
      api,
      environment: env,
    });
    let memoryToken: string;
    try {
      const response = await fetch(`${first.endpoint}/v1/delegate/start`, {
        method: "POST",
        headers: { authorization: "Bearer synthetic-runtime" },
        body: JSON.stringify({ harnessId: "codex", task: "synthetic", cwd: root, memory: true }),
      });
      expect(response.status).toBe(200);
      memoryToken = ((await response.json()) as { memoryToken: string }).memoryToken;
      expect(memoryToken).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await first.close();
    }
    const second = await startDelegationControlServer({
      token: "synthetic-runtime",
      api,
      environment: env,
    });
    try {
      const errorOutput = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: ["delegate", "remember"],
          environment: {
            ...env,
            CODEXHOST_RUNTIME_ENDPOINT: second.endpoint,
            CODEXHOST_RUNTIME_TOKEN: "synthetic-runtime",
            CODEXHOST_DELEGATION_MEMORY_TOKEN: memoryToken,
          },
          output: new PassThrough(),
          diagnosticOutput: errorOutput,
        }),
      ).toBe(1);
      const error = JSON.parse(String(errorOutput.read()));
      expect(error.error.code).toBe("INVALID_ARGUMENT");
      expect(JSON.stringify(error)).not.toContain(memoryToken);
      expect(await store.all()).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it.each(["context", "remember"])(
    "accepts %s token via environment, explicit legacy option still wins",
    async (command) => {
      const { env } = await fixture();
      const bodies: unknown[] = [];
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      }) as unknown as typeof fetch;
      const environment = {
        ...env,
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:12345",
        CODEXHOST_RUNTIME_TOKEN: "synthetic-runtime",
        CODEXHOST_DELEGATION_MEMORY_TOKEN: "synthetic-capability",
      };
      for (const args of [[], ["--memory-token", "synthetic-explicit"]]) {
        const output = new PassThrough();
        expect(
          await runDelegationCli({
            arguments: ["delegate", command, ...args],
            environment,
            fetchImpl,
            output,
          }),
        ).toBe(0);
        expect(String(output.read())).not.toContain("synthetic-capability");
      }
      expect(bodies).toEqual([
        { memoryToken: "synthetic-capability" },
        { memoryToken: "synthetic-explicit" },
      ]);
    },
  );

  it("does not persist CODEX_HOME in the MCP launch environment", async () => {
    const { root, env } = await fixture();
    const launch = rly0MemoryServerLaunch({
      environment: env,
      agent: "codex",
      entryUrl: pathToFileURL(path.join(root, "host-runtime.mjs")).href,
      cwd: root,
    });
    expect(launch.env).not.toHaveProperty("CODEX_HOME");
    expect(launch.env).toEqual({
      RLY0_MEMORY_DIR: env.RLY0_MEMORY_DIR,
      CODEXHOST_DATA_DIR: env.CODEXHOST_DATA_DIR,
      RLY0_MEMORY_AGENT: "codex",
      RLY0_MEMORY_CWD: root,
    });
  });
});
