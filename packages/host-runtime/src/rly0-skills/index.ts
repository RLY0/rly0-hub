import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  Rly0SkillBackupEntry,
  Rly0SkillEntry,
  Rly0SkillsImportParams,
  Rly0SkillsListResult,
} from "@codexhost/shared-contracts";
import { rly0SkillBackupIdSchema, rly0SkillNameSchema } from "@codexhost/shared-contracts";

import { buildBackupDirName, parseBackupDirName } from "./backup-id.js";
import { parseSkillFrontMatter } from "./frontmatter.js";

function resolveCodexHome(environment: NodeJS.ProcessEnv): string {
  return path.resolve(
    environment.CODEX_HOME ?? path.join(environment.HOME ?? os.homedir(), ".codex"),
  );
}

export interface Rly0SkillsManagerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** Overrides `~/.rly0-hub/skills-backup` — used by tests to avoid touching the real home dir. */
  readonly backupRoot?: string;
}

function assertSafeName(name: string): void {
  if (!rly0SkillNameSchema.safeParse(name).success) throw new Error("SKILL_INVALID_NAME");
}

function assertSafeBackupId(backupId: string): void {
  if (!rly0SkillBackupIdSchema.safeParse(backupId).success)
    throw new Error("SKILL_INVALID_BACKUP_ID");
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    // EXDEV: source and destination are on different filesystems/devices; rename cannot cross
    // them, so fall back to a recursive copy followed by removing the original.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.cp(source, destination, { recursive: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

/**
 * Reads installed skills (and backups) under `${CODEX_HOME:-~/.codex}/skills/`, and moves skill
 * directories to/from a backup folder. Deletion is never permanent here: "deactivate" always
 * moves a skill directory into the backup folder rather than removing it.
 */
export class Rly0SkillsManager {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #backupRoot: string;

  constructor(options: Rly0SkillsManagerOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#backupRoot =
      options.backupRoot ??
      path.join(this.#environment.HOME ?? os.homedir(), ".rly0-hub", "skills-backup");
  }

  skillsRoot(): string {
    return path.join(resolveCodexHome(this.#environment), "skills");
  }

  async list(): Promise<Rly0SkillsListResult> {
    const skillsRoot = this.skillsRoot();
    const installed = await this.#listInstalled(skillsRoot);
    const backups = await this.#listBackups();
    let rootExists = true;
    try {
      rootExists = (await fs.stat(skillsRoot)).isDirectory();
    } catch {
      rootExists = false;
    }
    return {
      skillsRoot,
      rootExists,
      installedCount: installed.length,
      installed,
      backups,
    };
  }

  async #listInstalled(skillsRoot: string): Promise<Rly0SkillEntry[]> {
    let entries: string[];
    try {
      entries = (await fs.readdir(skillsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const skills: Rly0SkillEntry[] = [];
    for (const name of entries) {
      if (!rly0SkillNameSchema.safeParse(name).success) continue;
      const frontMatter = await this.#readFrontMatter(path.join(skillsRoot, name, "SKILL.md"));
      if (!frontMatter) continue;
      skills.push({
        name,
        ...(frontMatter.name ? { title: frontMatter.name } : {}),
        ...(frontMatter.description ? { description: frontMatter.description } : {}),
      });
    }
    skills.sort((left, right) => left.name.localeCompare(right.name));
    return skills;
  }

  async #listBackups(): Promise<Rly0SkillBackupEntry[]> {
    let entries: string[];
    try {
      entries = (await fs.readdir(this.#backupRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const backups: Rly0SkillBackupEntry[] = [];
    for (const backupId of entries) {
      const parsed = parseBackupDirName(backupId);
      if (!parsed) continue;
      const frontMatter = await this.#readFrontMatter(
        path.join(this.#backupRoot, backupId, "SKILL.md"),
      );
      backups.push({
        backupId,
        name: parsed.name,
        backedUpAt: parsed.backedUpAt,
        ...(frontMatter?.name ? { title: frontMatter.name } : {}),
        ...(frontMatter?.description ? { description: frontMatter.description } : {}),
      });
    }
    backups.sort((left, right) => (left.backedUpAt ?? "").localeCompare(right.backedUpAt ?? ""));
    return backups;
  }

  async #readFrontMatter(
    skillMdPath: string,
  ): Promise<{ name?: string; description?: string } | null> {
    try {
      const content = await fs.readFile(skillMdPath, "utf8");
      return parseSkillFrontMatter(content);
    } catch {
      return null;
    }
  }

  async deactivate(name: string): Promise<{ ok: true; backupId: string }> {
    assertSafeName(name);
    const skillsRoot = this.skillsRoot();
    const source = path.join(skillsRoot, name);
    if (path.dirname(source) !== path.resolve(skillsRoot)) throw new Error("SKILL_INVALID_NAME");
    if (!(await isDirectory(source))) throw new Error("SKILL_NOT_FOUND");
    if (!(await this.#hasSkillManifest(source))) throw new Error("SKILL_NOT_FOUND");
    await fs.mkdir(this.#backupRoot, { recursive: true });
    const backupId = buildBackupDirName(name);
    const destination = path.join(this.#backupRoot, backupId);
    await moveDirectory(source, destination);
    return { ok: true, backupId };
  }

  async restore(backupId: string): Promise<{ ok: true }> {
    assertSafeBackupId(backupId);
    const parsed = parseBackupDirName(backupId);
    if (!parsed) throw new Error("SKILL_INVALID_BACKUP_ID");
    const source = path.join(this.#backupRoot, backupId);
    if (path.dirname(source) !== path.resolve(this.#backupRoot)) {
      throw new Error("SKILL_INVALID_BACKUP_ID");
    }
    if (!(await isDirectory(source))) throw new Error("SKILL_BACKUP_NOT_FOUND");
    const skillsRoot = this.skillsRoot();
    const destination = path.join(skillsRoot, parsed.name);
    if (await isDirectory(destination)) throw new Error("SKILL_ALREADY_EXISTS");
    await fs.mkdir(skillsRoot, { recursive: true });
    await moveDirectory(source, destination);
    return { ok: true };
  }

  async importSkill(params: Rly0SkillsImportParams): Promise<{ ok: true; name: string }> {
    const sourcePath = path.resolve(params.sourcePath);
    if (!(await this.#hasSkillManifest(sourcePath))) throw new Error("SKILL_SOURCE_INVALID");
    const name = params.name ?? path.basename(sourcePath);
    assertSafeName(name);
    const skillsRoot = this.skillsRoot();
    const destination = path.join(skillsRoot, name);
    if (path.dirname(destination) !== path.resolve(skillsRoot))
      throw new Error("SKILL_INVALID_NAME");
    if (await isDirectory(destination)) throw new Error("SKILL_ALREADY_EXISTS");
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.cp(sourcePath, destination, { recursive: true });
    return { ok: true, name };
  }

  async #hasSkillManifest(directory: string): Promise<boolean> {
    try {
      return (await fs.stat(path.join(directory, "SKILL.md"))).isFile();
    } catch {
      return false;
    }
  }
}

const KNOWN_SKILLS_ERROR_MESSAGES = new Set([
  "SKILL_INVALID_NAME",
  "SKILL_INVALID_BACKUP_ID",
  "SKILL_NOT_FOUND",
  "SKILL_BACKUP_NOT_FOUND",
  "SKILL_ALREADY_EXISTS",
  "SKILL_SOURCE_INVALID",
]);

/** Maps a rejected `Rly0SkillsManager` call to a JSON-RPC error; unknown failures never leak detail. */
export function rly0SkillsRpcError(error: unknown): { code: number; message: string } {
  if (error instanceof Error && KNOWN_SKILLS_ERROR_MESSAGES.has(error.message)) {
    return { code: -32000, message: error.message };
  }
  return { code: -32000, message: "SKILL_OPERATION_FAILED" };
}
