import { syncNativeSkills } from "../src/rly0-bridge/native-skills.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncNativeResources } from "../src/rly0-bridge/native-resources.js";
import { snapshot } from "../src/rly0-bridge/skill-tree.js";
import { Rly0SkillsManager } from "../src/rly0-skills/index.js";
import { readPausedSkills } from "../src/rly0-skills/discovery.js";
import { externalMcp, syncExternalMcp } from "../src/rly0-mcp/discovery.js";
import { Rly0McpManager } from "../src/rly0-mcp/index.js";
import { sharedResourcesProvider } from "../src/shared-harness-resources.js";
import { createBridgeRoutes } from "../src/rly0-hub-service/bridge-routes.js";
import type { ManagedSkill } from "../src/rly0-bridge/skill-recovery.js";

describe("HUB-52 independent review regressions (synthetic isolated home)", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let config: string;
  const raw = { command: "synthetic-mcp", args: ["--offline"] };
  const sync = () => syncNativeResources(env, { memory: false, skills: true, mcp: false });
  const skill = (assistant: string) => path.join(root, assistant, "skills", "foo");
  async function writeSkill(dir: string, text: string) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), text);
  }
  async function json(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  }
  async function installMcp(
    servers: Record<string, unknown>,
    file = path.join(root, ".claude.json"),
  ) {
    await json(file, { mcpServers: servers });
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hub52-review-synthetic-"));
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
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("R1: shares .system only to other assistants and reclaims the old erroneous Codex duplicate", async () => {
    const system = path.join(root, ".codex", "skills", ".system", "foo");
    await writeSkill(system, "system v1");
    // Synthetic pre-fix manifest records the erroneous duplicate as Hub-owned.
    const duplicate = skill(".codex");
    await writeSkill(duplicate, "system v1");
    await json(path.join(root, "hub", "bridge", "native-skills.json"), [
      {
        name: duplicate,
        source: system,
        root: await fs.realpath(path.dirname(duplicate)),
        digest: (await snapshot(duplicate)).digest,
      },
    ]);
    await sync();
    await expect(fs.lstat(duplicate)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(skill(".claude"), "SKILL.md"), "utf8")).toBe("system v1");
    await fs.writeFile(path.join(system, "SKILL.md"), "system v2");
    await sync();
    await expect(fs.lstat(duplicate)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(skill(".agents"), "SKILL.md"), "utf8")).toBe("system v2");
  });

  it("R1: a destination junction back to Codex cannot bypass the .system exclusion", async () => {
    await writeSkill(path.join(root, ".codex", "skills", ".system", "foo"), "system original");
    await fs.mkdir(path.join(root, ".agents"));
    await fs.symlink(
      path.join(root, ".codex", "skills"),
      path.join(root, ".agents", "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await sync();
    await expect(fs.lstat(skill(".codex"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(skill(".claude"), "SKILL.md"), "utf8")).toBe(
      "system original",
    );
  });

  it("R2: pausing a Codex name prevents external substitution and restores the exact original", async () => {
    await writeSkill(skill(".codex"), "Codex original");
    await writeSkill(skill(".claude"), "Claude independent installation");
    await sync();
    const manager = new Rly0SkillsManager({
      environment: env,
      backupRoot: path.join(root, "backups"),
    });
    const paused = await manager.deactivate("foo");
    expect(paused.native).toBeUndefined();
    expect(await readPausedSkills(env)).toEqual([
      expect.objectContaining({ name: "foo", directoryBackup: true }),
    ]);
    expect((await manager.list()).backups).toHaveLength(1);
    await sync();
    await expect(fs.lstat(skill(".codex"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(skill(".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(skill(".claude"), "SKILL.md"), "utf8")).toBe(
      "Claude independent installation",
    );
    expect(await manager.restore(paused.backupId)).toEqual({ ok: true });
    expect(await readPausedSkills(env)).toEqual([]);
    expect(await fs.readFile(path.join(skill(".codex"), "SKILL.md"), "utf8")).toBe(
      "Codex original",
    );
    expect(await fs.readFile(path.join(skill(".agents"), "SKILL.md"), "utf8")).toBe(
      "Codex original",
    );
  });

  it("R2: a legacy backup can reclaim only the Hub-owned replacement left by the old bug", async () => {
    await writeSkill(skill(".codex"), "Codex original");
    await writeSkill(skill(".claude"), "Claude replacement");
    await sync();
    const manager = new Rly0SkillsManager({
      environment: env,
      backupRoot: path.join(root, "backups"),
    });
    const { backupId } = await manager.deactivate("foo");
    await fs.unlink(path.join(root, "hub", "bridge", "paused-skills.json")); // Synthetic pre-fix state.
    await sync();
    expect(await fs.readFile(path.join(skill(".codex"), "SKILL.md"), "utf8")).toBe(
      "Claude replacement",
    );
    expect(await manager.restore(backupId)).toEqual({ ok: true });
    expect(await fs.readFile(path.join(skill(".codex"), "SKILL.md"), "utf8")).toBe(
      "Codex original",
    );
    expect(await fs.readFile(path.join(skill(".claude"), "SKILL.md"), "utf8")).toBe(
      "Claude replacement",
    );
    expect(await fs.readFile(path.join(skill(".agents"), "SKILL.md"), "utf8")).toBe(
      "Codex original",
    );
  });

  it("R3: manual MCP deletion persists across scans and installer updates until explicit restore", async () => {
    await installMcp({ docs: raw });
    await syncExternalMcp(env, true);
    await fs.writeFile(config, 'model="synthetic"\n');
    for (let i = 0; i < 2; i++) await syncExternalMcp(env, true);
    await installMcp({ docs: { command: "synthetic-v2" } });
    await syncExternalMcp(env, true);
    expect(parse(await fs.readFile(config, "utf8"))).toEqual({ model: "synthetic" });
    expect((await externalMcp(env))[0]?.raw.enabled).toBe(false);
    expect(await new Rly0McpManager({ environment: env }).setEnabled("docs", true)).toEqual({
      ok: true,
    });
    expect(parse(await fs.readFile(config, "utf8"))).toMatchObject({
      mcp_servers: { docs: { command: "synthetic-v2", enabled: true } },
    });
  });
  it("R3: manual edits relinquish ownership permanently even if the edited table is later deleted", async () => {
    await installMcp({ docs: raw });
    await syncExternalMcp(env, true);
    await fs.writeFile(config, '[mcp_servers.docs]\ncommand="user-owned"\n');
    await syncExternalMcp(env, true);
    expect(parse(await fs.readFile(config, "utf8"))).toEqual({
      mcp_servers: { docs: { command: "user-owned" } },
    });
    await fs.writeFile(config, 'model="synthetic"\n');
    await syncExternalMcp(env, true);
    expect(parse(await fs.readFile(config, "utf8"))).toEqual({ model: "synthetic" });
  });
  it.each([
    ["claude-code", ".claude.json"],
    ["cursor", ".cursor/mcp.json"],
    ["antigravity", ".gemini/config/mcp_config.json"],
  ])(
    "R4: %s receives no copy of its own MCP before or after Codex import",
    async (harnessId, file) => {
      await installMcp({ own: raw }, path.join(root, file));
      const provider = sharedResourcesProvider(env);
      for (const imported of [false, true]) {
        if (imported) await syncExternalMcp(env, true);
        const own = await provider(root, { harnessId, mcp: true });
        expect(own.mcpServers).toEqual({});
        const other = await provider(root, { harnessId: "synthetic-other", mcp: true });
        expect(other.mcpServers).toEqual({
          codex_own: { type: "stdio", command: raw.command, args: raw.args, env: {} },
        });
      }
    },
  );
  it("R4: the real global bridge keeps Antigravity's own entry single and removes its earlier Hub duplicate", async () => {
    const file = path.join(root, ".gemini/config/mcp_config.json");
    await installMcp({ own: raw }, file);
    await fs.writeFile(config, '[mcp_servers.other]\ncommand="synthetic-other"\n');
    await syncExternalMcp(env, true);
    await installMcp({ own: raw, "rly0-own": raw }, file);
    await json(path.join(root, "hub", "bridge", "global-blocks.json"), {
      antigravity: { enabled: true, servers: ["rly0-own"], skipped: [] },
    });
    const bridge = createBridgeRoutes({
      environment: env,
      installRoot: root,
      memoryLaunch: null,
      openFolder: () => undefined,
    });
    await bridge.routes["bridge.globalSet"]({ agent: "antigravity", enabled: true });
    const result = JSON.parse(await fs.readFile(file, "utf8"));
    expect(result.mcpServers.own).toEqual(raw);
    expect(Object.keys(result.mcpServers).sort()).toEqual(["own", "rly0-other"]);
  });

  it.each([
    { command: "synthetic", args: ["ghp_" + "A".repeat(36)] },
    { command: "synthetic", args: ["https://example.test/mcp?key=syntheticvalue"] },
    { url: "https://example.test/mcp?key=syntheticvalue" },
    { url: "https://example.test/key/shortvalue/mcp" },
    { url: "https://example.test/%61%42%30/mcp" },
    { url: "https://example.test/" + "aB0".repeat(12) + "/mcp" },
  ])("R5: suspected credential values are never persisted: %j", async (server) => {
    await installMcp({ sensitive: server });
    const source = await fs.readFile(path.join(root, ".claude.json"), "utf8");
    await syncExternalMcp(env, true);
    expect(parse(await fs.readFile(config, "utf8"))).toEqual({ model: "synthetic" });
    expect(await fs.readFile(path.join(root, ".claude.json"), "utf8")).toBe(source);
    const bridge = createBridgeRoutes({
      environment: env,
      installRoot: root,
      memoryLaunch: null,
      openFolder: () => undefined,
    });
    expect(
      await bridge.routes["bridge.globalSet"]({ agent: "antigravity", enabled: true }),
    ).toMatchObject({ skipped: ["sensitive"] });
    await expect(fs.lstat(path.join(root, ".gemini/config/mcp_config.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
  it("R6: empty env and headers do not prevent credential-free persistence", async () => {
    await installMcp({ empty: { ...raw, env: {}, headers: {} } });
    await syncExternalMcp(env, true);
    expect(parse(await fs.readFile(config, "utf8"))).toMatchObject({
      mcp_servers: { empty: { command: raw.command, enabled: true } },
    });
  });
  it("R7: a malformed URL does not discard later entries in the same file", async () => {
    await installMcp({ broken: { url: "not an absolute URL" }, later: raw });
    expect((await externalMcp(env)).map((v) => v.name)).toEqual(["later"]);
    await syncExternalMcp(env, true);
    expect(parse(await fs.readFile(config, "utf8"))).toMatchObject({
      mcp_servers: { later: { command: raw.command } },
    });
  });
  it.each(["directory", "worktree-file"])(
    "R8: clone-installed skills share without their .git %s",
    async (kind) => {
      const original = skill(".claude");
      await writeSkill(original, "git-installed skill");
      if (kind === "directory") {
        await fs.mkdir(path.join(original, ".git"));
        await fs.writeFile(path.join(original, ".git", "config"), "synthetic private metadata");
      } else await fs.writeFile(path.join(original, ".git"), "gitdir: synthetic-private-path");
      expect((await sync()).skipped).toEqual([]);
      expect(await fs.readFile(path.join(skill(".codex"), "SKILL.md"), "utf8")).toBe(
        "git-installed skill",
      );
      await expect(fs.lstat(path.join(skill(".codex"), ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.lstat(path.join(original, ".git"))).toBeTruthy();
    },
  );

  async function interruptedUpdate(phase: "old-renamed" | "installed", modifiedOld = false) {
    await writeSkill(skill(".claude"), "new contents");
    const name = skill(".codex");
    const parent = path.dirname(name);
    const stage = path.join(parent, ".rly0-sync-Ab1234"),
      old = `${stage}-old`;
    await writeSkill(old, "old contents");
    await writeSkill(stage, "new contents");
    const oldTree = await snapshot(old),
      nextTree = await snapshot(stage);
    const recovery = {
      stage,
      old,
      digest: oldTree.digest,
      nextDigest: nextTree.digest,
      nextSource: skill(".claude"),
    };
    if (phase === "installed") await fs.rename(stage, name);
    if (modifiedOld) await fs.writeFile(path.join(old, "SKILL.md"), "user-modified old contents");
    const entry: ManagedSkill = {
      name,
      source: skill(".claude"),
      root: await fs.realpath(parent),
      digest: phase === "installed" ? nextTree.digest : oldTree.digest,
      recovery,
    };
    await json(path.join(root, "hub", "bridge", "native-skills.json"), [entry]);
    return { name, old, stage };
  }
  it.each(["old-renamed", "installed"] as const)(
    "R9: startup recovers a journaled interruption at %s and reclaims the verified old tree",
    async (phase) => {
      const { name, old, stage } = await interruptedUpdate(phase);
      await sync();
      expect(await fs.readFile(path.join(name, "SKILL.md"), "utf8")).toBe("new contents");
      await expect(fs.lstat(old)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
      const manifest = JSON.parse(
        await fs.readFile(path.join(root, "hub", "bridge", "native-skills.json"), "utf8"),
      );
      expect(manifest.every((v: ManagedSkill) => v.recovery === undefined)).toBe(true);
      await fs.writeFile(path.join(skill(".claude"), "SKILL.md"), "next installer update");
      await sync();
      expect(await fs.readFile(path.join(name, "SKILL.md"), "utf8")).toBe("next installer update");
    },
  );
  it("R9: startup preserves modified or unjournaled old trees", async () => {
    const { old } = await interruptedUpdate("installed", true);
    const unjournaled = path.join(root, ".codex", "skills", ".rly0-sync-Xy5678-old");
    await writeSkill(unjournaled, "no ownership proof");
    await expect(sync()).rejects.toThrow("GLOBAL_CONFIG_SKILL_RECOVERY_BLOCKED");
    const result = { instructions: [], synced: [], skipped: [] as string[], removed: [] };
    expect(
      await syncNativeSkills(
        path.join(root, ".codex", "skills"),
        [path.join(root, ".claude", "skills"), path.join(root, ".agents", "skills")],
        path.join(root, "hub", "bridge", "native-skills.json"),
        true,
        result,
        env,
      ),
    ).toBe(true);
    expect(result.skipped).toContain(old);
    expect(result.skipped).toContain(unjournaled);
    expect(await fs.readFile(path.join(old, "SKILL.md"), "utf8")).toBe(
      "user-modified old contents",
    );
    expect(await fs.readFile(path.join(unjournaled, "SKILL.md"), "utf8")).toBe(
      "no ownership proof",
    );
  });
  it("R9: startup rejects a recorded old tree replaced with a junction", async () => {
    const { old } = await interruptedUpdate("installed");
    await fs.rm(old, { recursive: true });
    const outside = path.join(root, "outside-skill-root");
    await writeSkill(outside, "must survive");
    await fs.symlink(outside, old, process.platform === "win32" ? "junction" : "dir");
    await expect(sync()).rejects.toThrow("GLOBAL_CONFIG_SKILL_RECOVERY_BLOCKED");
    const result = { instructions: [], synced: [], skipped: [] as string[], removed: [] };
    expect(
      await syncNativeSkills(
        path.join(root, ".codex", "skills"),
        [path.join(root, ".claude", "skills"), path.join(root, ".agents", "skills")],
        path.join(root, "hub", "bridge", "native-skills.json"),
        true,
        result,
        env,
      ),
    ).toBe(true);
    expect(result.skipped).toContain(old);
    expect((await fs.lstat(old)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(outside, "SKILL.md"), "utf8")).toBe("must survive");
  });

  it("R9: the real updater records ownership proof before renaming its current copy", async () => {
    await writeSkill(skill(".claude"), "before");
    await sync();
    await fs.writeFile(path.join(skill(".claude"), "SKILL.md"), "after");
    const rename = fs.rename.bind(fs);
    let checked = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === skill(".codex") && String(to).endsWith("-old")) {
        const manifest: ManagedSkill[] = JSON.parse(
          await fs.readFile(path.join(root, "hub", "bridge", "native-skills.json"), "utf8"),
        );
        const proof = manifest.find((v) => v.name === skill(".codex"))?.recovery;
        expect(proof).toBeDefined();
        expect(proof?.old).toBe(String(to));
        expect(proof?.digest).toBe((await snapshot(String(from))).digest);
        checked++;
      }
      await rename(from, to);
    });
    try {
      await sync();
    } finally {
      spy.mockRestore();
    }
    expect(checked).toBe(1);
  });
  it("imported external MCP entries retain their source and stop/resume metadata", async () => {
    await installMcp({ docs: raw });
    await syncExternalMcp(env, true);
    const manager = new Rly0McpManager({ environment: env });
    expect((await manager.list()).servers).toEqual([
      expect.objectContaining({ name: "docs", external: true, source: "claude", enabled: true }),
    ]);
    await manager.setEnabled("docs", false);
    expect((await manager.list()).servers).toEqual([
      expect.objectContaining({ name: "docs", external: true, source: "claude", enabled: false }),
    ]);
    await manager.setEnabled("docs", true);
    expect((await manager.list()).servers).toEqual([
      expect.objectContaining({ name: "docs", external: true, enabled: true }),
    ]);
  });
  it("legacy removed state stays visible as stopped and can be restored through setEnabled", async () => {
    await installMcp({ docs: raw });
    await json(path.join(root, "hub", "bridge", "external-mcp-controls.json"), { docs: "removed" });
    const manager = new Rly0McpManager({ environment: env });
    expect((await manager.list()).servers).toEqual([
      expect.objectContaining({ name: "docs", enabled: false, external: true }),
    ]);
    await manager.setEnabled("docs", true);
    expect((await manager.list()).servers).toEqual([
      expect.objectContaining({ name: "docs", enabled: true }),
    ]);
  });
});
