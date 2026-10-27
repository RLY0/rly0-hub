import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncNativeResources } from "../src/rly0-bridge/native-resources.js";
import { snapshot } from "../src/rly0-bridge/skill-tree.js";
import { Rly0SkillsManager } from "../src/rly0-skills/index.js";
import { readPausedSkills, writePausedSkills } from "../src/rly0-skills/discovery.js";
import { syncExternalMcp } from "../src/rly0-mcp/discovery.js";
import { readMcpOwnership } from "../src/rly0-mcp/ownership.js";
import { Rly0McpManager } from "../src/rly0-mcp/index.js";
import { createBridgeRoutes } from "../src/rly0-hub-service/bridge-routes.js";

describe("HUB-52 second independent review regressions (synthetic isolated home)", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let config: string;
  let manager: Rly0SkillsManager;
  const native = () => syncNativeResources(env, { skills: true, memory: false, mcp: false });
  const skill = (assistant: string, name = "foo") => path.join(root, assistant, "skills", name);
  const backup = (id: string) => path.join(root, "backups", id);
  async function writeSkill(dir: string, content: string) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), content);
  }
  async function json(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  }
  async function mcp(raw: Record<string, unknown>) {
    await json(path.join(root, ".claude.json"), { mcpServers: { docs: raw } });
  }
  async function codexMcp() {
    return parse(await fs.readFile(config, "utf8"));
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hub52-review2-synthetic-"));
    env = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
      CODEXHOST_DATA_DIR: path.join(root, "hub"),
      RLY0_MEMORY_DIR: path.join(root, "memory"),
    };
    config = path.join(root, ".codex", "config.toml");
    await fs.mkdir(path.dirname(config));
    await fs.writeFile(config, 'model="synthetic"\n');
    manager = new Rly0SkillsManager({ environment: env, backupRoot: path.join(root, "backups") });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([{ env: {} }, { headers: {} }, { env: {}, headers: {} }])(
    "A: empty transport maps survive repeated TOML round trips: %j",
    async (maps) => {
      await mcp({ command: "synthetic-v1", ...maps, args: ["--offline"] });
      await syncExternalMcp(env, true);
      const first = await fs.readFile(config, "utf8");
      await syncExternalMcp(env, true);
      await syncExternalMcp(env, true);
      expect(await fs.readFile(config, "utf8")).toBe(first);
      expect((await readMcpOwnership(env)).docs?.disposed).toBeUndefined();
      expect((await new Rly0McpManager({ environment: env }).list()).servers).toEqual([
        expect.objectContaining({ name: "docs", external: true, enabled: true, source: "claude" }),
      ]);
      await mcp({ args: ["--offline"], ...maps, command: "synthetic-v2" });
      await syncExternalMcp(env, true);
      await syncExternalMcp(env, true);
      expect(await codexMcp()).toMatchObject({
        mcp_servers: { docs: { command: "synthetic-v2", enabled: true } },
      });
      expect((await readMcpOwnership(env)).docs?.disposed).toBeUndefined();
    },
  );
  it("A: scalar key order is immaterial, while argv order is a user edit", async () => {
    await mcp({ command: "synthetic", args: ["one", "two"], env: {} });
    await syncExternalMcp(env, true);
    const reordered =
      '# keep this comment\n[mcp_servers.docs]\nenabled=true\nargs=["one","two"]\ncommand="synthetic"\n[mcp_servers.docs.env]\n';
    await fs.writeFile(config, reordered);
    await syncExternalMcp(env, true);
    expect(await fs.readFile(config, "utf8")).toBe(reordered);
    expect((await readMcpOwnership(env)).docs?.disposed).toBeUndefined();
    await fs.writeFile(config, reordered.replace('["one","two"]', '["two","one"]'));
    await syncExternalMcp(env, true);
    expect((await readMcpOwnership(env)).docs?.disposed).toBe(true);
    expect(await fs.readFile(config, "utf8")).toContain('["two","one"]');
  });
  it("A: unchanged legacy insertion-order hashes migrate without regaining ownership of edits", async () => {
    const legacy = {
      command: "synthetic",
      env: {},
      args: ["--offline"],
      headers: {},
      enabled: true,
    };
    await mcp(legacy);
    await fs.writeFile(config, stringify({ mcp_servers: { docs: legacy } }));
    const file = path.join(root, "hub", "bridge", "external-mcp.json");
    const entry = {
      digest: createHash("sha256").update(JSON.stringify(legacy)).digest("hex"),
      sourcePath: path.join(root, ".claude.json"),
    };
    await json(file, { docs: entry });
    await syncExternalMcp(env, true);
    expect((await readMcpOwnership(env)).docs).toEqual(
      expect.objectContaining({ digestVersion: 2 }),
    );
    expect((await readMcpOwnership(env)).docs?.disposed).toBeUndefined();
    await fs.writeFile(config, '[mcp_servers.docs]\ncommand="user edit"\n');
    await json(file, { docs: entry });
    await syncExternalMcp(env, true);
    expect((await readMcpOwnership(env)).docs?.disposed).toBe(true);
    expect(await codexMcp()).toEqual({ mcp_servers: { docs: { command: "user edit" } } });
  });

  async function legacyBackup() {
    await writeSkill(skill(".codex", "bar"), "old backed-up bar");
    const { backupId } = await manager.deactivate("bar");
    await writePausedSkills(env, []); // Synthetic legacy backup predating pause records.
    return backupId;
  }
  it("B: a failed legacy restore leaves a new user skill visible and distributed", async () => {
    const backupId = await legacyBackup();
    await writeSkill(skill(".codex", "bar"), "new user bar");
    await native();
    await expect(manager.restore(backupId)).rejects.toThrow("SKILL_ALREADY_EXISTS");
    expect(await readPausedSkills(env)).toEqual([]);
    expect((await manager.list()).installed).toEqual([expect.objectContaining({ name: "bar" })]);
    expect(await fs.readFile(path.join(skill(".codex", "bar"), "SKILL.md"), "utf8")).toBe(
      "new user bar",
    );
    expect(await fs.readFile(path.join(skill(".agents", "bar"), "SKILL.md"), "utf8")).toBe(
      "new user bar",
    );
    expect(await fs.readFile(path.join(backup(backupId), "SKILL.md"), "utf8")).toBe(
      "old backed-up bar",
    );
  });
  it("B: a move failure also rolls back only the temporary pause", async () => {
    const backupId = await legacyBackup();
    await writeSkill(skill(".claude", "bar"), "external replacement");
    await native();
    const other = {
      name: "other",
      backupId: "other-20260101T000000000Z",
      backedUpAt: "2026-01-01",
      sourcePath: skill(".claude", "other"),
    };
    await writePausedSkills(env, [other]);
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === backup(backupId))
        throw Object.assign(new Error("synthetic move denied"), { code: "EACCES" });
      return rename(from, to);
    });
    try {
      await expect(manager.restore(backupId)).rejects.toThrow("synthetic move denied");
    } finally {
      spy.mockRestore();
    }
    expect(await readPausedSkills(env)).toEqual([other]);
    expect((await manager.list()).installed).toEqual([expect.objectContaining({ name: "bar" })]);
    expect(await fs.readFile(path.join(skill(".codex", "bar"), "SKILL.md"), "utf8")).toBe(
      "external replacement",
    );
    expect(await fs.readFile(path.join(backup(backupId), "SKILL.md"), "utf8")).toBe(
      "old backed-up bar",
    );
  });
  it("C: a deleted backup stays visible as distributionOnly and restore explicitly unpauses its name", async () => {
    await writeSkill(skill(".codex"), "lost original");
    await writeSkill(skill(".claude"), "external foo");
    const { backupId } = await manager.deactivate("foo");
    await fs.rm(backup(backupId), { recursive: true });
    const paused = await readPausedSkills(env);
    const listed = await manager.list();
    expect(listed.installed).toEqual([]);
    expect(listed.backups).toEqual([
      expect.objectContaining({
        name: "foo",
        backupId,
        distributionOnly: true,
        sourcePath: skill(".codex"),
      }),
    ]);
    expect(await readPausedSkills(env)).toEqual(paused); // Listing does not silently resume sharing.
    expect(await manager.restore(backupId)).toEqual({ ok: true });
    expect(await readPausedSkills(env)).toEqual([]);
    expect((await manager.list()).backups).toEqual([]);
    expect(await fs.readFile(path.join(skill(".codex"), "SKILL.md"), "utf8")).toBe("external foo");
    await expect(fs.lstat(backup(backupId))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("C: an orphan with no remaining source can still be unpaused without inventing recovered content", async () => {
    await writeSkill(skill(".codex"), "lost original");
    const { backupId } = await manager.deactivate("foo");
    await fs.rm(backup(backupId), { recursive: true });
    expect((await manager.list()).backups[0]).toMatchObject({ backupId, distributionOnly: true });
    await manager.restore(backupId);
    expect(await readPausedSkills(env)).toEqual([]);
    expect((await manager.list()).backups).toEqual([]);
    expect((await manager.list()).installed).toEqual([]);
    await expect(fs.lstat(skill(".codex"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("C: permission failure is not misclassified as a missing backup", async () => {
    await writeSkill(skill(".codex"), "original");
    const { backupId } = await manager.deactivate("foo");
    const saved = await readPausedSkills(env);
    const lstat = fs.lstat.bind(fs);
    const spy = vi.spyOn(fs, "lstat").mockImplementation((...args) => {
      if (String(args[0]) === backup(backupId))
        return Promise.reject(
          Object.assign(new Error("synthetic inaccessible backup"), { code: "EACCES" }),
        );
      return lstat(...args);
    });
    try {
      await expect(manager.list()).rejects.toThrow("synthetic inaccessible backup");
      await expect(manager.restore(backupId)).rejects.toThrow("synthetic inaccessible backup");
    } finally {
      spy.mockRestore();
    }
    expect(await readPausedSkills(env)).toEqual(saved);
  });
  it("D: blocked recovery is reported through the existing bridge error and clears after evidence is repaired", async () => {
    await writeSkill(skill(".claude"), "new foo");
    await writeSkill(skill(".claude", "other"), "other continues");
    const name = skill(".codex"),
      parent = path.dirname(name);
    const stage = path.join(parent, ".rly0-sync-Ab1234"),
      old = `${stage}-old`;
    await writeSkill(old, "old foo");
    const oldDigest = (await snapshot(old)).digest;
    await writeSkill(name, "new foo");
    const newDigest = (await snapshot(name)).digest;
    await json(path.join(root, "hub", "bridge", "native-skills.json"), [
      {
        name,
        root: await fs.realpath(parent),
        source: skill(".claude"),
        digest: newDigest,
        recovery: {
          old,
          stage,
          digest: oldDigest,
          nextDigest: newDigest,
          nextSource: skill(".claude"),
        },
      },
    ]);
    await fs.writeFile(path.join(old, "SKILL.md"), "user-modified old foo");
    const bridge = createBridgeRoutes({
      environment: env,
      installRoot: root,
      memoryLaunch: null,
      openFolder: () => undefined,
    });
    await expect(bridge.routes["bridge.syncNative"]({})).rejects.toThrow(
      "GLOBAL_CONFIG_SKILL_RECOVERY_BLOCKED",
    );
    expect(await bridge.routes["bridge.status"]({})).toMatchObject({
      nativeError: "GLOBAL_CONFIG_SKILL_RECOVERY_BLOCKED",
    });
    await bridge.routes["memory.add"]({
      text: "synthetic unrelated memory",
      scope: "global",
      tags: [],
    });
    expect(await bridge.routes["bridge.status"]({})).toMatchObject({
      nativeError: "GLOBAL_CONFIG_SKILL_RECOVERY_BLOCKED",
    });
    expect(await fs.readFile(path.join(skill(".codex", "other"), "SKILL.md"), "utf8")).toBe(
      "other continues",
    );
    expect(await fs.readFile(path.join(old, "SKILL.md"), "utf8")).toBe("user-modified old foo");
    await fs.writeFile(path.join(old, "SKILL.md"), "old foo"); // Synthetic repair of the recovery evidence.
    await bridge.routes["bridge.syncNative"]({});
    expect(await bridge.routes["bridge.status"]({})).toMatchObject({ nativeError: null });
    await expect(fs.lstat(old)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
