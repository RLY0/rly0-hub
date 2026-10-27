import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  Rly0SkillBackupEntry,
  Rly0SkillEntry,
  Rly0SkillsImportParams,
  Rly0SkillsListResult,
} from "@codexhost/shared-contracts";
import { rly0SkillBackupIdSchema, rly0SkillNameSchema } from "@codexhost/shared-contracts";

import { buildBackupDirName, parseBackupDirName } from "./backup-id.js";
import { discoverSkills, readPausedSkills, writePausedSkills, userHome } from "./discovery.js";
import { parseSkillFrontMatter } from "./frontmatter.js";
import { syncNativeResources } from "../rly0-bridge/native-resources.js";
import { sharedResourceSettings } from "../shared-harness-resources.js";
import { backupAddedAt, resourceAddedAt } from "../resource-added-at.js";

function resolveCodexHome(environment: NodeJS.ProcessEnv): string {
  return path.resolve(environment.CODEX_HOME ?? path.join(userHome(environment), ".codex"));
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
 * Discovers user-level skills across supported assistants. Deactivation backs up Codex-owned
 * directories; external/link sources only pause Hub distribution, preserving installer paths.
 */
export class Rly0SkillsManager {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #backupRoot: string;

  constructor(options: Rly0SkillsManagerOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#backupRoot =
      options.backupRoot ?? path.join(userHome(this.#environment), ".rly0-hub", "skills-backup");
  }

  skillsRoot(): string {
    return path.join(resolveCodexHome(this.#environment), "skills");
  }

  async list(): Promise<Rly0SkillsListResult> {
    const skillsRoot = this.skillsRoot();
    const { installed, unavailable } = await this.#listInstalled();
    const backups = await this.#listBackups();
    for (const entry of await readPausedSkills(this.#environment)) {
      if (!entry.directoryBackup || (await this.#backupMissing(entry.backupId))) {
        const { name, backupId, backedUpAt, sourcePath } = entry;
        backups.push({
          name,
          backupId,
          backedUpAt,
          sourcePath,
          distributionOnly: true,
          ...backupAddedAt(backedUpAt),
        });
      }
    }
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
      ...(unavailable ? { native: { error: "GLOBAL_CONFIG_SKILL_ROOT_UNAVAILABLE" } } : {}),
    };
  }

  async #listInstalled(): Promise<{ installed: Rly0SkillEntry[]; unavailable: boolean }> {
    const discovered = await discoverSkills(this.#environment);
    const paused = new Set(
      (await readPausedSkills(this.#environment)).map((v) => v.name.toLowerCase()),
    );
    const skills: Rly0SkillEntry[] = [];
    for (const skill of discovered.skills) {
      if (paused.has(skill.name.toLowerCase())) continue;
      const frontMatter = await this.#readFrontMatter(path.join(skill.realPath, "SKILL.md"));
      if (!frontMatter) continue;
      const addedAt = await resourceAddedAt(
        this.#environment,
        "skill",
        skill.name,
        skill.sourcePath,
      );
      skills.push({
        ...skill,
        ...(addedAt !== undefined ? { addedAt } : {}),
        distributionOnly:
          skill.source !== "codex" ||
          skill.isLink ||
          path.dirname(skill.sourcePath) !== this.skillsRoot(),
        ...(frontMatter.name ? { title: frontMatter.name } : {}),
        ...(frontMatter.description ? { description: frontMatter.description } : {}),
      });
    }
    skills.sort((left, right) => left.name.localeCompare(right.name));
    return { installed: skills, unavailable: discovered.unavailableRoots.length > 0 };
  }

  async skillPath(name: string): Promise<string> {
    assertSafeName(name);
    const skill = (await discoverSkills(this.#environment)).skills.find((v) => v.name === name);
    if (!skill) throw new Error("SKILL_NOT_FOUND");
    return skill.sourcePath;
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
        ...backupAddedAt(parsed.backedUpAt),
        ...(frontMatter?.name ? { title: frontMatter.name } : {}),
        ...(frontMatter?.description ? { description: frontMatter.description } : {}),
      });
    }
    backups.sort((left, right) => (left.backedUpAt ?? "").localeCompare(right.backedUpAt ?? ""));
    return backups;
  }

  async #backupMissing(backupId: string): Promise<boolean> {
    assertSafeBackupId(backupId);
    try {
      await fs.lstat(path.join(this.#backupRoot, backupId));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error; // Unreadable is not proof that the backup was deleted.
    }
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

  async deactivate(
    name: string,
  ): Promise<{ ok: true; backupId: string; native?: { error: string } }> {
    assertSafeName(name);
    const skill = (await discoverSkills(this.#environment)).skills.find((v) => v.name === name);
    if (!skill) throw new Error("SKILL_NOT_FOUND");
    if (
      skill.source !== "codex" ||
      skill.isLink ||
      path.dirname(skill.sourcePath) !== this.skillsRoot()
    ) {
      const paused = await readPausedSkills(this.#environment);
      const backupId = buildBackupDirName(name);
      await writePausedSkills(this.#environment, [
        ...paused.filter((v) => v.name !== name),
        {
          name,
          backupId,
          backedUpAt: new Date().toISOString(),
          sourcePath: skill.sourcePath,
        },
      ]);
      return { ok: true, backupId, ...(await this.#syncNative()) };
    }
    const skillsRoot = this.skillsRoot();
    const source = path.join(skillsRoot, name);
    if (path.dirname(source) !== path.resolve(skillsRoot)) throw new Error("SKILL_INVALID_NAME");
    if (!(await isDirectory(source))) throw new Error("SKILL_NOT_FOUND");
    if (!(await this.#hasSkillManifest(source))) throw new Error("SKILL_NOT_FOUND");
    await fs.mkdir(this.#backupRoot, { recursive: true });
    const backupId = buildBackupDirName(name);
    const destination = path.join(this.#backupRoot, backupId);
    const paused = await readPausedSkills(this.#environment);
    await writePausedSkills(this.#environment, [
      ...paused.filter((v) => v.name.toLowerCase() !== name.toLowerCase()),
      {
        name,
        backupId,
        backedUpAt: new Date().toISOString(),
        sourcePath: source,
        directoryBackup: true,
      },
    ]);
    try {
      await moveDirectory(source, destination);
    } catch (error) {
      await writePausedSkills(this.#environment, paused);
      throw error;
    }
    const native = await this.#syncNative();
    return { ok: true, backupId, ...native };
  }

  async restore(backupId: string): Promise<{ ok: true; native?: { error: string } }> {
    assertSafeBackupId(backupId);
    const paused = await readPausedSkills(this.#environment);
    const pausedEntry = paused.find((v) => v.backupId === backupId);
    if (pausedEntry && (!pausedEntry.directoryBackup || (await this.#backupMissing(backupId)))) {
      await writePausedSkills(
        this.#environment,
        paused.filter((v) => v.backupId !== backupId),
      );
      return { ok: true, ...(await this.#syncNative()) };
    }
    const parsed = parseBackupDirName(backupId);
    if (!parsed) throw new Error("SKILL_INVALID_BACKUP_ID");
    const source = path.join(this.#backupRoot, backupId);
    if (path.dirname(source) !== path.resolve(this.#backupRoot)) {
      throw new Error("SKILL_INVALID_BACKUP_ID");
    }
    if (!(await isDirectory(source))) throw new Error("SKILL_BACKUP_NOT_FOUND");
    const skillsRoot = this.skillsRoot();
    const destination = path.join(skillsRoot, parsed.name);
    let temporarilyPaused = false;
    try {
      if (await isDirectory(destination)) {
        // Only a legacy Hub-owned replacement may be reclaimed; a user's replacement survives.
        if (!pausedEntry) {
          await writePausedSkills(this.#environment, [
            ...paused,
            {
              name: parsed.name,
              backupId,
              backedUpAt: parsed.backedUpAt,
              sourcePath: destination,
              directoryBackup: true,
            },
          ]);
          temporarilyPaused = true;
        }
        await this.#syncNative();
        if (await isDirectory(destination)) throw new Error("SKILL_ALREADY_EXISTS");
      }
      await fs.mkdir(skillsRoot, { recursive: true });
      await moveDirectory(source, destination);
    } catch (error) {
      if (temporarilyPaused) {
        await writePausedSkills(this.#environment, paused);
        await this.#syncNative(); // Resume any copies removed while the attempted restore paused them.
      }
      throw error;
    }
    await writePausedSkills(
      this.#environment,
      paused.filter((v) => v.backupId !== backupId),
    );
    const native = await this.#syncNative();
    return { ok: true, ...native };
  }

  async importSkill(
    params: Rly0SkillsImportParams,
  ): Promise<{ ok: true; name: string; native?: { error: string } }> {
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
    const native = await this.#syncNative();
    return { ok: true, name, ...native };
  }

  async #syncNative(): Promise<{ native?: { error: string } }> {
    try {
      await syncNativeResources(this.#environment, await sharedResourceSettings(this.#environment));
      return {};
    } catch (error) {
      return {
        native: {
          error:
            error instanceof Error && /^GLOBAL_CONFIG_[A-Z_]+$/u.test(error.message)
              ? error.message
              : "GLOBAL_CONFIG_NATIVE_SYNC_FAILED",
        },
      };
    }
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
