import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rly0SkillsManager } from "../src/rly0-skills/index.js";
import { discoverSkills } from "../src/rly0-skills/discovery.js";
import { snapshot } from "../src/rly0-bridge/skill-tree.js";
import {
  syncNativeResources,
  syncNativeResourcesIfChanged,
} from "../src/rly0-bridge/native-resources.js";
import {
  sharedResourcesProvider,
  setSharedResourceSettings,
} from "../src/shared-harness-resources.js";

// Probe the actual permission instead of assuming Windows Developer Mode is enabled.
const probe = await fs.mkdtemp(path.join(os.tmpdir(), "hub-symlink-capability-"));
let directorySymlinks = true;
try {
  await fs.symlink(probe, path.join(probe, "link"), "dir");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  directorySymlinks = false;
} finally {
  await fs.rm(probe, { recursive: true, force: true });
}

describe("external installer skills (synthetic, isolated home)", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let manager: Rly0SkillsManager;
  const text = "---\nname: Oil UI Pro\ndescription: synthetic installer fixture\n---\nv1";
  const native = () => syncNativeResources(env, { memory: false, skills: true });
  const dir = (source: string, name = "oil-ui-pro") => path.join(root, source, "skills", name);
  async function skill(source: string, name = "oil-ui-pro", content = text) {
    const target = dir(source, name);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "SKILL.md"), content);
    return target;
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-external-skills-synthetic-"));
    env = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, ".codex"),
      CODEXHOST_DATA_DIR: path.join(root, "hub"),
      RLY0_MEMORY_DIR: path.join(root, "memory"),
    };
    manager = new Rly0SkillsManager({ environment: env, backupRoot: path.join(root, "backup") });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists the Claude original once, preserves its junction, and copies to Codex", async () => {
    const original = await skill(".claude");
    await fs.mkdir(path.dirname(dir(".agents")), { recursive: true });
    await fs.symlink(original, dir(".agents"), process.platform === "win32" ? "junction" : "dir");
    const before = await fs.readlink(dir(".agents"));
    expect((await manager.list()).installed).toEqual([
      {
        name: "oil-ui-pro",
        addedAt: expect.any(Number),
        title: "Oil UI Pro",
        description: "synthetic installer fixture",
        source: "claude",
        sourcePath: original,
        realPath: await fs.realpath(original),
        isLink: false,
        conflicts: [],
        distributionOnly: true,
      },
    ]);
    await native();
    expect(await fs.readFile(path.join(dir(".codex"), "SKILL.md"), "utf8")).toBe(text);
    expect(await fs.readlink(dir(".agents"))).toBe(before);
    expect(await fs.readFile(path.join(original, "SKILL.md"), "utf8")).toBe(text);
    expect((await manager.list()).installed).toHaveLength(1);
    expect((await manager.list()).installed[0]?.source).toBe("claude");
  });
  it.skipIf(!directorySymlinks)(
    "follows an actual directory symbolic link and reports link provenance",
    async () => {
      const original = await skill(".grok");
      await fs.mkdir(path.dirname(dir(".agents")), { recursive: true });
      await fs.symlink(original, dir(".agents"), "dir");
      expect((await manager.list()).installed[0]).toMatchObject({
        source: "agents",
        isLink: true,
        sourcePath: dir(".agents"),
        realPath: await fs.realpath(original),
      });
      await native();
      expect(await fs.readFile(path.join(dir(".codex"), "SKILL.md"), "utf8")).toBe(text);
    },
  );
  it("observes installer updates at the original location without adopting its mirror", async () => {
    const original = await skill(".claude");
    await syncNativeResourcesIfChanged(env, { memory: false, skills: true });
    await fs.writeFile(path.join(original, "SKILL.md"), text + "\nv2");
    await syncNativeResourcesIfChanged(env, { memory: false, skills: true });
    expect(await fs.readFile(path.join(dir(".codex"), "SKILL.md"), "utf8")).toBe(text + "\nv2");
    expect(await fs.readFile(path.join(dir(".agents"), "SKILL.md"), "utf8")).toBe(text + "\nv2");
  });
  it("pauses and restores distribution without moving the external original or junction", async () => {
    const original = await skill(".claude");
    await fs.mkdir(path.dirname(dir(".agents")), { recursive: true });
    await fs.symlink(original, dir(".agents"), process.platform === "win32" ? "junction" : "dir");
    await native();
    const disabled = await manager.deactivate("oil-ui-pro");
    expect(disabled.native).toBeUndefined();
    expect(await fs.lstat(dir(".codex")).catch(() => null)).toBeNull();
    expect((await fs.lstat(dir(".agents"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(original, "SKILL.md"), "utf8")).toBe(text);
    expect((await manager.list()).backups).toEqual([
      expect.objectContaining({
        backupId: disabled.backupId,
        distributionOnly: true,
        sourcePath: original,
      }),
    ]);
    await fs.writeFile(path.join(original, "SKILL.md"), text + " latest");
    await native();
    expect(await fs.lstat(dir(".codex")).catch(() => null)).toBeNull();
    await manager.restore(disabled.backupId);
    expect(await fs.readFile(path.join(dir(".codex"), "SKILL.md"), "utf8")).toBe(text + " latest");
  });
  it("preserves same-name user installations and reports their conflict", async () => {
    const original = await skill(".codex");
    const other = await skill(".claude", "oil-ui-pro", text + " user");
    expect((await manager.list()).installed[0]).toMatchObject({
      sourcePath: original,
      conflicts: [other],
    });
    expect((await native()).skipped).toContain(other);
    expect(await fs.readFile(path.join(other, "SKILL.md"), "utf8")).toBe(text + " user");
  });
  it("honors CLAUDE_CONFIG_DIR and still discovers the default Claude directory", async () => {
    env.CLAUDE_CONFIG_DIR = path.join(root, "custom-claude");
    await skill("custom-claude");
    await skill(".claude", "default-skill");
    expect((await manager.list()).installed.map((v) => v.name)).toEqual([
      "default-skill",
      "oil-ui-pro",
    ]);
    await native();
    expect(await fs.readFile(path.join(dir(".codex"), "SKILL.md"), "utf8")).toBe(text);
  });
  it("follows safe nested links, rejects cycles and escaping links", async () => {
    const original = await skill(".claude");
    await fs.mkdir(path.join(original, "docs"));
    await fs.writeFile(path.join(original, "docs", "guide.md"), "guide");
    await fs.symlink(
      path.join(original, "docs"),
      path.join(original, "refs"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await native();
    expect(await fs.readFile(path.join(dir(".codex"), "refs", "guide.md"), "utf8")).toBe("guide");
    await fs.symlink(
      original,
      path.join(original, "loop"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(snapshot(original, true)).rejects.toThrow("GLOBAL_CONFIG_SKILL_UNSAFE_TREE");
    expect((await native()).skipped).toContain(original);
    await fs.unlink(path.join(original, "loop"));
    await fs.symlink(
      root,
      path.join(original, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(snapshot(original, true)).rejects.toThrow("GLOBAL_CONFIG_SKILL_UNSAFE_TREE");
  });
  it("ignores dangling and out-of-scope top-level links", async () => {
    await fs.mkdir(path.dirname(dir(".agents")), { recursive: true });
    await fs.symlink(
      path.join(root, "missing"),
      dir(".agents"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect((await discoverSkills(env)).skills).toEqual([]);
    await fs.unlink(dir(".agents"));
    await fs.symlink(root, dir(".agents"), process.platform === "win32" ? "junction" : "dir");
    expect((await discoverSkills(env)).skipped).toContain(dir(".agents"));
  });
  it("never removes user-modified copies when the installer removes its original", async () => {
    const original = await skill(".claude");
    await native();
    await fs.writeFile(path.join(dir(".codex"), "SKILL.md"), "user edit");
    await fs.rm(original, { recursive: true });
    await native();
    expect(await fs.readFile(path.join(dir(".codex"), "SKILL.md"), "utf8")).toBe("user edit");
  });
  it("exposes the external source to the session before background copies exist", async () => {
    const original = await skill(".claude");
    await setSharedResourceSettings(env, { memory: false, skills: true, mcp: false });
    const shared = await sharedResourcesProvider(env)(root, {
      harnessId: "synthetic",
      skills: true,
    });
    expect(shared.context).toContain(
      JSON.stringify(path.join(await fs.realpath(original), "SKILL.md")),
    );
    // Wait for this test's background scan before deleting its isolated directory.
    await syncNativeResourcesIfChanged(env, { memory: false, skills: true, mcp: false });
  });
});
