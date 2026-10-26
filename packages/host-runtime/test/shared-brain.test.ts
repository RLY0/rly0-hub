import { mkdir, mkdtemp, readFile, rm, writeFile, lstat, rename, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { runDelegationCli } from "../src/delegation-cli.js";

import { syncNativeResources } from "../src/rly0-bridge/native-resources.js";
import { createBridgeRoutes } from "../src/rly0-hub-service/bridge-routes.js";
import { delegationMemory } from "../src/rly0-memory/delegation.js";
import { openRly0MemoryStore } from "../src/rly0-memory/launch.js";
import { callMemoryTool, handleMemoryRpc } from "../src/rly0-memory/mcp-server.js";
import { PREFERENCE_LIMITS, standingPreferences } from "../src/rly0-memory/preferences.js";
import { sharedMemoryPart } from "../src/shared-memory-resources.js";
import {
  setSharedResourceSettings,
  sharedResourcesProvider,
} from "../src/shared-harness-resources.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub50-synthetic-"));
  roots.push(root);
  const env = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, ".codex"),
    CODEXHOST_DATA_DIR: path.join(root, "hub"),
    RLY0_MEMORY_DIR: path.join(root, "memory"),
  };
  const a = path.join(root, "a"),
    b = path.join(root, "b");
  await Promise.all(
    [env.CODEX_HOME, path.join(a, ".git"), path.join(b, ".git")].map((p) =>
      mkdir(p, { recursive: true }),
    ),
  );
  const store = openRly0MemoryStore(env);
  return { root, env, a, b, store };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HUB-50 standing preferences", () => {
  it("injects original global/current project preferences for native MCP and digest agents, excluding other projects", async () => {
    const { env, a, b, store } = await fixture();
    for (const [text, scope, cwd] of [
      ["一律说中文\n保留两行原文", "global", a],
      ["项目 A 使用 vitest", "project", a],
      ["B 的私人偏好", "project", b],
    ] as const)
      await store.remember({ text, scope, cwd, tags: ["preference"], agent: "hub" }, true);
    for (let i = 0; i < 25; i++)
      await store.remember(
        { text: `unrelated-${i}`, scope: "project", cwd: a, agent: "test" },
        true,
      );
    for (const native of [true, false]) {
      const part = await sharedMemoryPart({
        environment: env,
        project: a,
        request: { harnessId: native ? "claude-code" : "other", memoryMcp: native },
        entryUrl: pathToFileURL(path.join(a, "host-runtime.mjs")).href,
        forMcp: native,
        forContext: true,
      });
      expect(part.context?.content).toContain("一律说中文\n保留两行原文");
      expect(part.context?.content).toContain("项目 A 使用 vitest");
      expect(part.context?.content).not.toContain("B 的私人偏好");
    }
    const initialized = await handleMemoryRpc(
      { store, cwd: a, agent: "claude-code" },
      { id: 1, method: "initialize", params: {} },
    );
    expect(JSON.stringify(initialized)).toContain("一律说中文");
    expect(JSON.stringify(initialized)).not.toContain("B 的私人偏好");
  });

  it("limits whole originals, reports omissions and never promotes ordinary records", async () => {
    const { store, a } = await fixture();
    for (let i = 0; i < 25; i++)
      await store.remember(
        {
          text: `偏好${i}\n${"字".repeat(2500)}`,
          scope: "global",
          agent: "test",
          tags: ["preference"],
        },
        true,
      );
    await store.remember({ text: "unmarked instruction", scope: "global", agent: "test" }, true);
    const prefs = await standingPreferences(store, a);
    expect(prefs.content.length).toBeLessThan(PREFERENCE_LIMITS.chars + 500);
    expect(prefs.records.length).toBeLessThanOrEqual(PREFERENCE_LIMITS.records);
    expect(prefs.omitted).toBeGreaterThan(0);
    expect(prefs.content).not.toContain("unmarked instruction");
    for (const entry of prefs.records) expect(prefs.content).toContain(entry.text);
  });

  it("pin/unpin preserves identity, other tags and provenance across store reopen", async () => {
    const { env, store, a } = await fixture();
    const r = await store.remember(
      {
        text: "请说中文",
        scope: "global",
        tags: ["language"],
        agent: "claude-code",
        thread: "task-123456",
      },
      true,
    );
    const bridge = createBridgeRoutes({
      environment: env,
      installRoot: a,
      openFolder: () => undefined,
      memoryLaunch: null,
    });
    const pinned = await bridge.routes["memory.pin"]({ id: r.id, pinned: true });
    expect(pinned).toMatchObject({
      record: {
        id: r.id,
        agent: "claude-code",
        thread: "task-123456",
        pinned: true,
        tags: ["language", "preference"],
      },
    });
    expect(await readFile(path.join(env.CODEX_HOME, "AGENTS.md"), "utf8")).toContain("请说中文");
    await bridge.routes["memory.pin"]({ id: r.id, pinned: false });
    expect((await openRly0MemoryStore(env).get(r.id))?.tags).toEqual(["language"]);
    await expect(lstat(path.join(env.CODEX_HOME, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await bridge.routes["memory.pin"]({ id: "unknown", pinned: true })).toMatchObject({
      record: null,
    });
    await expect(bridge.routes["memory.pin"]({ id: r.id, pinned: "yes" })).rejects.toThrow(
      "INVALID_PARAMS",
    );
  });
});

describe("HUB-50 native resources", () => {
  it("respects override file, preserves user instructions exactly, never puts project text in global instructions, and reclaims its block", async () => {
    const { env, a, store } = await fixture();
    const file = path.join(env.CODEX_HOME, "AGENTS.override.md"),
      original = "# 用户规则\r\n原样保留";
    await writeFile(file, original);
    await store.remember(
      { text: "全局中文", scope: "global", agent: "hub", tags: ["preference"] },
      true,
    );
    await store.remember(
      {
        text: "项目私人规则",
        scope: "project",
        cwd: a,
        agent: "hub",
        tags: ["preference"],
      },
      true,
    );
    await syncNativeResources(env, { memory: true, skills: false });
    const first = await readFile(file, "utf8");
    expect(first.startsWith(original)).toBe(true);
    expect(first).toContain("全局中文");
    expect(first).not.toContain("项目私人规则");
    expect((await syncNativeResources(env, { memory: true, skills: false })).instructions).toEqual(
      [],
    );
    await syncNativeResources(env, { memory: false, skills: false });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("leaves malformed markers untouched and reports a durable pin separately from native synchronization failure", async () => {
    const { env, store } = await fixture();
    await store.remember(
      { text: "中文", scope: "global", agent: "test", tags: ["preference"] },
      true,
    );
    const file = path.join(env.CODEX_HOME, "AGENTS.md");
    await writeFile(file, "mine\n<!-- BEGIN RLY0 MANAGED STANDING PREFERENCES -->");
    await expect(syncNativeResources(env, { memory: true, skills: false })).rejects.toThrow(
      "GLOBAL_CONFIG_MARKER_BROKEN",
    );
    expect(await readFile(file, "utf8")).toBe(
      "mine\n<!-- BEGIN RLY0 MANAGED STANDING PREFERENCES -->",
    );
    const bridge = createBridgeRoutes({
      environment: env,
      installRoot: env.HOME,
      memoryLaunch: null,
      openFolder: () => undefined,
    });
    const saved = await bridge.routes["memory.add"]({
      text: "durable despite native error",
      scope: "global",
      tags: ["preference"],
    });
    expect(saved).toMatchObject({
      text: "durable despite native error",
      native: { error: "GLOBAL_CONFIG_MARKER_BROKEN" },
    });
    expect(await bridge.routes["bridge.status"]({})).toMatchObject({
      nativeError: "GLOBAL_CONFIG_MARKER_BROKEN",
    });
  });

  it("syncs complete skill trees, skips user collisions, observes source changes and removes only unchanged managed trees", async () => {
    const { env, root } = await fixture();
    const source = path.join(env.CODEX_HOME, "skills", "demo");
    await mkdir(path.join(source, "references"), { recursive: true });
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: demo\ndescription: synthetic\n---\nHello",
    );
    await writeFile(path.join(source, "references", "guide.md"), "v1");
    const userSkill = path.join(root, ".claude", "skills", "demo");
    await mkdir(userSkill, { recursive: true });
    await writeFile(path.join(userSkill, "SKILL.md"), "user-owned");
    const first = await syncNativeResources(env, { memory: false, skills: true });
    expect(first.skipped).toEqual([userSkill]);
    const link = path.join(root, ".agents", "skills", "demo");
    expect((await lstat(link)).isDirectory()).toBe(true);
    await writeFile(path.join(source, "references", "guide.md"), "v2");
    await syncNativeResources(env, { memory: false, skills: true });
    expect(await readFile(path.join(link, "references", "guide.md"), "utf8")).toBe("v2");
    await syncNativeResources(env, { memory: false, skills: false });
    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(userSkill, "SKILL.md"), "utf8")).toBe("user-owned");
    expect(await readFile(path.join(source, "SKILL.md"), "utf8")).toContain("Hello");
  });

  it("retains a user-edited native skill on cleanup and update", async () => {
    const { env, root } = await fixture();
    const source = path.join(env.CODEX_HOME, "skills", "demo");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "synthetic");
    await syncNativeResources(env, { memory: false, skills: true });
    const link = path.join(root, ".agents", "skills", "demo");
    await writeFile(path.join(link, "SKILL.md"), "user replacement");
    await syncNativeResources(env, { memory: false, skills: true });
    await syncNativeResources(env, { memory: false, skills: false });
    expect(await readFile(path.join(link, "SKILL.md"), "utf8")).toBe("user replacement");
  });

  it("never removes the source when a user repoints the native skills parent directory to it", async () => {
    const { env, root } = await fixture();
    const source = path.join(env.CODEX_HOME, "skills"),
      skill = path.join(source, "demo");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "source must survive");
    await syncNativeResources(env, { memory: false, skills: true });
    const destination = path.join(root, ".agents", "skills");
    await rename(destination, path.join(root, ".agents", "skills-user-backup"));
    await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
    const result = await syncNativeResources(env, { memory: false, skills: false });
    expect(result.skipped).toContain(path.join(destination, "demo"));
    expect(await readFile(path.join(skill, "SKILL.md"), "utf8")).toBe("source must survive");
  });

  it("skips the Codex memory MCP copy even when the memory switch is off", async () => {
    const { env, a } = await fixture();
    await writeFile(
      path.join(env.CODEX_HOME, "config.toml"),
      '[mcp_servers.rly0_memory]\ncommand="node"\n[mcp_servers.mine]\ncommand="mine"\n',
    );
    await setSharedResourceSettings(env, { memory: false });
    const shared = await sharedResourcesProvider(env)(a, {
      harnessId: "claude-code",
      mcp: true,
      memoryMcp: true,
    });
    expect(Object.keys(shared.mcpServers)).toEqual(["codex_mine"]);
  });

  it("restores managed resources while preserving user skills, global prose and memory records", async () => {
    const { env, root, a, store } = await fixture();
    const file = path.join(env.CODEX_HOME, "AGENTS.md");
    await writeFile(file, "user instructions");
    await store.remember(
      {
        text: "中文回复",
        scope: "global",
        tags: ["preference"],
        agent: "test",
      },
      true,
    );
    const source = path.join(env.CODEX_HOME, "skills", "managed");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "synthetic skill");
    const user = path.join(root, ".agents", "skills", "user-owned");
    await mkdir(user, { recursive: true });
    await writeFile(path.join(user, "SKILL.md"), "user skill");
    const bridge = createBridgeRoutes({
      environment: env,
      installRoot: a,
      memoryLaunch: { command: "synthetic-node", args: ["synthetic-memory"], env: {} },
      openFolder: () => undefined,
    });
    await bridge.start();
    expect(await readFile(file, "utf8")).toContain("中文回复");
    expect(
      await readFile(path.join(root, ".claude", "skills", "managed", "SKILL.md"), "utf8"),
    ).toBe("synthetic skill");
    await setSharedResourceSettings(env, { memory: false, skills: false, mcp: false });
    await bridge.restorePure();
    expect(await readFile(file, "utf8")).toBe("user instructions");
    expect(await readFile(path.join(user, "SKILL.md"), "utf8")).toBe("user skill");
    await expect(lstat(path.join(root, ".claude", "skills", "managed"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(env.CODEX_HOME, "config.toml"), "utf8")).not.toContain(
      "mcp_servers.rly0_memory",
    );
    const saved = await callMemoryTool(
      { store, environment: env, cwd: a, agent: "old-running-mcp" },
      "remember",
      { text: "new pref after switch off", tags: ["preference"], scope: "global" },
    );
    expect(saved.isError).toBe(true);
    expect(await readFile(file, "utf8")).toBe("user instructions");
    expect(await store.all()).toHaveLength(1);
  });
});

describe("HUB-50 delegation memory", () => {
  it("serves the CLI through authenticated loopback routes and rejects invalid scopes and unauthenticated writes", async () => {
    const { env, a, store } = await fixture();
    await store.remember(
      { text: "中文回复", scope: "global", tags: ["preference"], agent: "hub" },
      true,
    );
    const token = "synthetic-memory-transport";
    const server = await startDelegationControlServer({
      token,
      environment: env,
      api: {
        listHarnesses: vi.fn(),
        inspect: vi.fn(),
        start: vi.fn().mockResolvedValue({
          threadId: "child-12345678",
          harnessId: "codex",
          status: "running",
          cwd: a,
        }),
        send: vi.fn(),
        cancel: vi.fn(),
        read: vi.fn().mockResolvedValue({
          threadId: "child-12345678",
          harnessId: "codex",
          status: "completed",
          result: { text: "【可复用结论】synthetic verified fact【可复用结论结束】" },
        }),
        wait: vi.fn(),
        list: vi.fn(),
      },
    });
    const environment = {
      ...env,
      CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
      CODEXHOST_RUNTIME_TOKEN: token,
    };
    try {
      const started = await fetch(`${server.endpoint}/v1/delegate/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ harnessId: "codex", task: "synthetic", cwd: a, memory: true }),
      });
      const { memoryToken } = (await started.json()) as { memoryToken: string };
      expect(memoryToken).toMatch(/^[a-f0-9]{64}$/u);
      const output = new PassThrough();
      let text = "";
      output.on("data", (chunk) => {
        text += String(chunk);
      });
      expect(
        await runDelegationCli({
          arguments: [
            "delegate",
            "context",
            "--cwd",
            a,
            "--memory-token",
            memoryToken,
            "--format",
            "compact",
          ],
          environment,
          output,
        }),
      ).toBe(0);
      expect(JSON.parse(text)).toMatchObject({
        enabled: true,
        preferences: expect.stringContaining("中文回复"),
      });
      const unauthorized = await fetch(`${server.endpoint}/v1/delegate/remember`, {
        method: "POST",
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);
      const invalid = await fetch(`${server.endpoint}/v1/delegate/context`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ cwd: "relative/path" }),
      });
      expect(invalid.status).toBe(400);
      const saved = new PassThrough();
      let savedText = "";
      saved.on("data", (chunk) => {
        savedText += String(chunk);
      });
      expect(
        await runDelegationCli({
          arguments: ["delegate", "remember", "--cwd", a, "--memory-token", memoryToken],
          environment,
          output: saved,
        }),
      ).toBe(0);
      expect(JSON.parse(savedText)).toMatchObject({ saved: expect.any(String) });
    } finally {
      await server.close();
    }
  });
  it("scopes the context and deduplicates a completed task's conclusions with attribution", async () => {
    const { env, a, b, store } = await fixture();
    await store.remember(
      { text: "中文回复", scope: "global", tags: ["preference"], agent: "hub" },
      true,
    );
    await store.remember(
      {
        text: "HUB50 project fact",
        scope: "project",
        cwd: a,
        agent: "claude-code",
      },
      true,
    );
    await store.remember(
      {
        text: "HUB50 other project private",
        scope: "project",
        cwd: b,
        agent: "claude-code",
      },
      true,
    );
    const context = JSON.stringify(
      await delegationMemory(
        env,
        "context",
        { cwd: a, query: "HUB50" },
        { cwd: a, agent: "codex", thread: "child-12345678" },
      ),
    );
    expect(context).toContain("中文回复");
    expect(context).toContain("project fact");
    expect(context).not.toContain("other project private");
    const body = {
      cwd: a,
      text: "verified synthetic result api_key=sk-abcdefghijklmnopqrstuv",
    };
    const binding = { cwd: a, agent: "codex", thread: "child-12345678" };
    await Promise.all([
      delegationMemory(env, "remember", body, binding),
      delegationMemory(env, "remember", body, binding),
    ]);
    const saved = (await store.all()).filter((r) => r.source === "delegation");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      agent: "codex",
      thread: "child-12345678",
      scope: "project",
      tags: ["conclusion"],
    });
    expect(saved[0]?.text).not.toContain("sk-abcdefghijklmnopqrstuv");
    await setSharedResourceSettings(env, { memory: false });
    expect(await delegationMemory(env, "context", { cwd: a }, binding)).toEqual({ enabled: false });
    expect(
      await delegationMemory(env, "remember", { ...body, text: "must not save" }, binding),
    ).toEqual({
      enabled: false,
    });
  });
});
