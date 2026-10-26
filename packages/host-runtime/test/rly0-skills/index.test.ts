import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Rly0SkillsManager, rly0SkillsRpcError } from "../../src/rly0-skills/index.js";

async function writeSkill(
  root: string,
  name: string,
  frontMatter: { name?: string; description?: string } = {},
): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const lines = ["---"];
  if (frontMatter.name) lines.push(`name: ${frontMatter.name}`);
  if (frontMatter.description) lines.push(`description: ${frontMatter.description}`);
  lines.push("---", "# body");
  await fs.writeFile(path.join(dir, "SKILL.md"), lines.join("\n"), "utf8");
  return dir;
}

describe("Rly0SkillsManager", () => {
  let codexHome: string;
  let backupRoot: string;
  let manager: Rly0SkillsManager;

  beforeEach(async () => {
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-skills-home-"));
    backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-skills-backup-"));
    manager = new Rly0SkillsManager({
      environment: {
        CODEX_HOME: codexHome,
        HOME: codexHome,
        USERPROFILE: codexHome,
        CODEXHOST_DATA_DIR: path.join(codexHome, "hub"),
        RLY0_MEMORY_DIR: path.join(codexHome, "memory"),
      },
      backupRoot,
    });
  });

  afterEach(async () => {
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(backupRoot, { recursive: true, force: true });
  });

  it("reports rootExists: false and an empty list when the skills dir is absent", async () => {
    const result = await manager.list();
    expect(result.rootExists).toBe(false);
    expect(result.installedCount).toBe(0);
    expect(result.installed).toEqual([]);
    expect(result.backups).toEqual([]);
    expect(result.skillsRoot).toBe(path.join(codexHome, "skills"));
  });

  it("lists installed skills with front matter title/description", async () => {
    const skillsRoot = path.join(codexHome, "skills");
    await writeSkill(skillsRoot, "pdf-tools", { name: "PDF Tools", description: "Work with PDFs" });
    const result = await manager.list();
    expect(result.rootExists).toBe(true);
    expect(result.installedCount).toBe(1);
    expect(result.installed).toEqual([
      { name: "pdf-tools", title: "PDF Tools", description: "Work with PDFs" },
    ]);
  });

  it("deactivates a skill by moving it to the backup root, then lists it under backups", async () => {
    const skillsRoot = path.join(codexHome, "skills");
    await writeSkill(skillsRoot, "pdf-tools", { name: "PDF Tools" });
    const { backupId } = await manager.deactivate("pdf-tools");
    expect(backupId).toMatch(/^pdf-tools-\d{8}T\d{9}Z$/);

    const afterDeactivate = await manager.list();
    expect(afterDeactivate.installed).toEqual([]);
    expect(afterDeactivate.backups).toEqual([
      expect.objectContaining({ backupId, name: "pdf-tools", title: "PDF Tools" }),
    ]);
    expect(await fs.stat(path.join(skillsRoot, "pdf-tools")).catch(() => null)).toBeNull();
    expect((await fs.stat(path.join(backupRoot, backupId))).isDirectory()).toBe(true);
  });

  it("restores a skill from backup back into the skills root", async () => {
    const skillsRoot = path.join(codexHome, "skills");
    await writeSkill(skillsRoot, "pdf-tools");
    const { backupId } = await manager.deactivate("pdf-tools");

    await manager.restore(backupId);
    const result = await manager.list();
    expect(result.installed).toEqual([expect.objectContaining({ name: "pdf-tools" })]);
    expect(result.backups).toEqual([]);
  });

  it("imports a skill directory from an arbitrary source path", async () => {
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-skills-import-"));
    try {
      const source = await writeSkill(sourceRoot, "external-skill", { name: "External" });
      const { name } = await manager.importSkill({ sourcePath: source });
      expect(name).toBe("external-skill");
      const result = await manager.list();
      expect(result.installed).toEqual([
        expect.objectContaining({ name: "external-skill", title: "External" }),
      ]);
    } finally {
      await fs.rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("rejects deactivating an unknown skill", async () => {
    await expect(manager.deactivate("missing")).rejects.toThrow("SKILL_NOT_FOUND");
  });

  it("rejects deactivating a directory without a SKILL.md manifest", async () => {
    await fs.mkdir(path.join(codexHome, "skills", "not-a-skill"), { recursive: true });
    await expect(manager.deactivate("not-a-skill")).rejects.toThrow("SKILL_NOT_FOUND");
  });

  it("rejects an unsafe skill name", async () => {
    await expect(manager.deactivate("../escape")).rejects.toThrow("SKILL_INVALID_NAME");
  });

  it("rejects restoring an unknown backup id", async () => {
    await expect(manager.restore("missing-20260101T000000000Z")).rejects.toThrow(
      "SKILL_BACKUP_NOT_FOUND",
    );
  });

  it("rejects an unsafe backup id", async () => {
    await expect(manager.restore("../escape")).rejects.toThrow("SKILL_INVALID_BACKUP_ID");
  });

  it("rejects restoring on top of an already-installed skill", async () => {
    const skillsRoot = path.join(codexHome, "skills");
    await writeSkill(skillsRoot, "pdf-tools");
    const { backupId } = await manager.deactivate("pdf-tools");
    await writeSkill(skillsRoot, "pdf-tools");
    await expect(manager.restore(backupId)).rejects.toThrow("SKILL_ALREADY_EXISTS");
  });

  it("rejects importing a source path without a SKILL.md", async () => {
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-skills-bad-import-"));
    try {
      await expect(manager.importSkill({ sourcePath: sourceRoot })).rejects.toThrow(
        "SKILL_SOURCE_INVALID",
      );
    } finally {
      await fs.rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("rejects importing on top of an already-installed skill", async () => {
    const skillsRoot = path.join(codexHome, "skills");
    await writeSkill(skillsRoot, "dup-skill");
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-skills-dup-import-"));
    try {
      await writeSkill(sourceRoot, "dup-skill");
      await expect(
        manager.importSkill({ sourcePath: path.join(sourceRoot, "dup-skill") }),
      ).rejects.toThrow("SKILL_ALREADY_EXISTS");
    } finally {
      await fs.rm(sourceRoot, { recursive: true, force: true });
    }
  });
});

describe("rly0SkillsRpcError", () => {
  it("forwards known business errors by message", () => {
    expect(rly0SkillsRpcError(new Error("SKILL_NOT_FOUND"))).toEqual({
      code: -32000,
      message: "SKILL_NOT_FOUND",
    });
  });

  it("collapses unknown failures to a generic message", () => {
    expect(rly0SkillsRpcError(new Error("some internal path leak"))).toEqual({
      code: -32000,
      message: "SKILL_OPERATION_FAILED",
    });
  });
});
