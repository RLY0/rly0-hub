import { promises as fs } from "node:fs";
import path from "node:path";
import { snapshot } from "./skill-tree.js";
import type { NativeResourceSync } from "./native-resources.js";

export interface SkillRecovery {
  stage: string;
  old: string;
  digest: string;
  nextDigest: string;
  nextSource: string;
}
export interface ManagedSkill {
  name: string;
  source: string;
  root: string;
  digest: string;
  recovery?: SkillRecovery;
}
const present = (file: string) =>
  fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

/** Called under the existing native-resource lock, before discovery can mistake a copy for a source. */
export async function recoverSkillUpdates(
  entries: ManagedSkill[],
  roots: string[],
  result: NativeResourceSync,
  persist: () => Promise<void>,
) {
  let blocked = false;
  for (const entry of entries) {
    const recovery = entry.recovery;
    if (!recovery) continue;
    const parent = path.dirname(entry.name);
    const canonical = await fs.realpath(parent).catch(() => "");
    if (
      !roots.some((root) => path.relative(root, parent) === "") ||
      !canonical ||
      path.relative(canonical, entry.root) !== "" ||
      path.dirname(recovery.stage) !== parent ||
      recovery.old !== `${recovery.stage}-old` ||
      !/^\.rly0-sync-[A-Za-z0-9]{6}$/u.test(path.basename(recovery.stage))
    ) {
      blocked = true;
      result.skipped.push(entry.name);
      continue;
    }
    const checked = async (file: string) => {
      const stat = await present(file);
      if (!stat) return null;
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        path.dirname(await fs.realpath(file)) !== canonical
      )
        throw new Error("GLOBAL_CONFIG_SKILL_UNSAFE_PATH");
      return snapshot(file);
    };
    try {
      const current = await checked(entry.name),
        old = await checked(recovery.old),
        stage = await checked(recovery.stage);
      if (
        (old && old.digest !== recovery.digest) ||
        (stage && stage.digest !== recovery.nextDigest) ||
        (current && ![recovery.digest, recovery.nextDigest].includes(current.digest)) ||
        (!current && !old)
      ) {
        blocked = true;
        result.skipped.push(recovery.old);
        continue;
      }
      // Recheck proof immediately before each recursive removal; never infer ownership from the prefix.
      const remove = async (file: string, digest: string) => {
        if ((await checked(file))?.digest !== digest)
          throw new Error("GLOBAL_CONFIG_SKILL_CHANGED");
        await fs.rm(file, { recursive: true });
        result.removed.push(file);
      };
      if (!current && old) {
        await fs.rename(recovery.old, entry.name);
        entry.digest = recovery.digest;
      } else if (current?.digest === recovery.nextDigest) {
        entry.digest = recovery.nextDigest;
        entry.source = recovery.nextSource;
      }
      await persist();
      if (current && old) await remove(recovery.old, recovery.digest);
      if (stage) await remove(recovery.stage, recovery.nextDigest);
      delete entry.recovery;
      await persist();
    } catch {
      blocked = true;
      result.skipped.push(recovery.old); // Keep recovery proof and user-modified data for inspection.
    }
  }
  const recorded = new Set(entries.flatMap((v) => (v.recovery ? [v.recovery.old] : [])));
  for (const root of roots) {
    for (const name of await fs.readdir(root).catch(() => [])) {
      const file = path.join(root, name);
      if (/^\.rly0-sync-[A-Za-z0-9]{6}-old$/u.test(name) && !recorded.has(file))
        result.skipped.push(file); // Legacy unjournaled leftovers cannot be safely claimed.
    }
  }
  return blocked;
}
