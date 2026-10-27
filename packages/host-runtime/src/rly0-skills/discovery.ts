import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { snapshot } from "../rly0-bridge/skill-tree.js";

export type SkillSource = "codex" | "claude" | "agents" | "external";
export interface SkillRoot {
  source: SkillSource;
  root: string;
}
export interface DiscoveredSkill {
  name: string;
  source: SkillSource;
  sourcePath: string;
  realPath: string;
  isLink: boolean;
  conflicts: string[];
}
export interface PausedSkill {
  directoryBackup?: boolean;
  name: string;
  backupId: string;
  backedUpAt: string;
  sourcePath: string;
}
export const within = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
export const userHome = (env: NodeJS.ProcessEnv) => env.USERPROFILE ?? env.HOME ?? os.homedir();
export function skillRoots(env: NodeJS.ProcessEnv): SkillRoot[] {
  const home = userHome(env);
  const codex = path.resolve(env.CODEX_HOME ?? path.join(home, ".codex"), "skills");
  // Only user-level locations; never scan project directories, plugin caches, or all of HOME.
  return [
    { source: "codex", root: codex },
    { source: "codex", root: path.join(codex, ".system") },
    {
      source: "claude",
      root: path.resolve(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "skills"),
    },
    { source: "claude", root: path.join(home, ".claude", "skills") },
    { source: "agents", root: path.join(home, ".agents", "skills") },
    { source: "external", root: path.join(home, ".grok", "skills") },
    { source: "external", root: path.join(home, ".pi", "agent", "skills") },
    {
      source: "external",
      root: path.join(env.HERMES_HOME ?? path.join(home, ".hermes"), "skills"),
    },
  ].filter(
    (v, i, all) => all.findIndex((other) => path.relative(v.root, other.root) === "") === i,
  ) as SkillRoot[];
}
export const skillManifestFile = (env: NodeJS.ProcessEnv) =>
  path.join(resolveRly0DataDir(env), "bridge", "native-skills.json");
const pausedFile = (env: NodeJS.ProcessEnv) =>
  path.join(resolveRly0DataDir(env), "bridge", "paused-skills.json");
export async function readPausedSkills(env: NodeJS.ProcessEnv): Promise<PausedSkill[]> {
  const text = await fs.readFile(pausedFile(env), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  const data: unknown = JSON.parse(text);
  if (
    !Array.isArray(data) ||
    data.some(
      (v) =>
        typeof v?.name !== "string" ||
        typeof v?.backupId !== "string" ||
        typeof v?.backedUpAt !== "string" ||
        typeof v?.sourcePath !== "string" ||
        (v?.directoryBackup !== undefined && typeof v.directoryBackup !== "boolean"),
    )
  )
    throw new Error("GLOBAL_CONFIG_SKILL_STATE_INVALID");
  return data as PausedSkill[];
}
export async function writePausedSkills(env: NodeJS.ProcessEnv, entries: PausedSkill[]) {
  const file = pausedFile(env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // This is local distribution state, never a move of the installer-owned source.
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(entries), { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

/** Canonicalize roots/links, ignore unchanged Hub mirrors, and choose a deterministic source. */
export async function discoverSkills(
  env: NodeJS.ProcessEnv,
  verifyMirrors = true,
): Promise<{ skills: DiscoveredSkill[]; skipped: string[] }> {
  const roots = skillRoots(env);
  const allowed = await Promise.all(
    roots.map((v) => fs.realpath(v.root).catch(() => path.resolve(v.root))),
  );
  // A skills-root link to HOME or a drive root must not authorize its entire contents.
  const safeRoot = (p: string) =>
    (path.dirname(p) !== p &&
      path.relative(userHome(env), p) !== "" &&
      path.basename(p).toLowerCase() === "skills") ||
    path.basename(p) === ".system";
  const managed = await fs
    .readFile(skillManifestFile(env), "utf8")
    .then((text): unknown => JSON.parse(text))
    .catch(() => []);
  const mirrors = new Map<string, string>();
  if (Array.isArray(managed))
    for (const v of managed)
      if (typeof v?.name === "string" && typeof v?.digest === "string")
        mirrors.set(path.resolve(v.name), v.digest);
  const skills = new Map<string, DiscoveredSkill>();
  const seen = new Set<string>();
  const skipped: string[] = [];
  for (let i = 0; i < roots.length; i++) {
    const location = roots[i];
    const canonical = allowed[i];
    if (!location || !canonical) continue;
    if (!safeRoot(canonical)) {
      skipped.push(location.root);
      continue;
    }
    const entries = await fs.readdir(location.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of entries.sort().slice(0, 256)) {
      if (name.startsWith(".") || !/^[A-Za-z0-9._-]{1,64}$/u.test(name)) continue;
      const sourcePath = path.join(location.root, name);
      if (skills.size >= 512) {
        skipped.push(sourcePath);
        break;
      }
      try {
        const realPath = await fs.realpath(sourcePath);
        if (!allowed.some((root) => safeRoot(root) && within(root, realPath) && root !== realPath))
          throw new Error();
        if (!(await fs.stat(realPath)).isDirectory()) continue;
        const manifest = await fs.realpath(path.join(realPath, "SKILL.md"));
        const info = await fs.stat(manifest);
        if (!within(realPath, manifest) || !info.isFile() || info.size > 64 * 1024)
          throw new Error();
        const key = process.platform === "win32" ? realPath.toLowerCase() : realPath;
        if (seen.has(key)) continue;
        const digest = mirrors.get(path.resolve(sourcePath));
        if (
          digest &&
          (!verifyMirrors || (await snapshot(sourcePath).catch(() => null))?.digest === digest)
        )
          continue;
        seen.add(key);
        const existing = skills.get(name.toLowerCase());
        if (existing) {
          existing.conflicts.push(sourcePath);
          continue;
        }
        skills.set(name.toLowerCase(), {
          name,
          source: location.source,
          sourcePath,
          realPath,
          isLink:
            (await fs.lstat(sourcePath)).isSymbolicLink() ||
            path.relative(sourcePath, realPath) !== "",
          conflicts: [],
        });
      } catch {
        skipped.push(sourcePath);
      }
    }
  }
  return { skills: [...skills.values()], skipped };
}
