import { recoverSkillUpdates, type ManagedSkill } from "./skill-recovery.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { snapshot, type Snapshot } from "./skill-tree.js";
import { discoverSkills, readPausedSkills, skillRoots, within } from "../rly0-skills/discovery.js";

import type { NativeResourceSync } from "./native-resources.js";

export async function syncNativeSkills(
  source: string,
  destinations: string[],
  manifestFile: string,
  enabled: boolean,
  result: NativeResourceSync,
  environment?: NodeJS.ProcessEnv,
) {
  let previous: ManagedSkill[];
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (v) =>
          typeof v?.name !== "string" ||
          typeof v?.source !== "string" ||
          typeof v?.root !== "string" ||
          !/^[a-f0-9]{64}$/u.test(v?.digest) ||
          (v?.recovery !== undefined &&
            (typeof v.recovery?.stage !== "string" ||
              typeof v.recovery?.old !== "string" ||
              !/^[a-f0-9]{64}$/u.test(v.recovery?.digest) ||
              !/^[a-f0-9]{64}$/u.test(v.recovery?.nextDigest) ||
              typeof v.recovery?.nextSource !== "string")),
      )
    )
      throw new Error();
    previous = parsed as ManagedSkill[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("GLOBAL_CONFIG_SKILL_MANIFEST_INVALID");
    previous = [];
  }
  const wanted = new Map<string, { source: string; tree: Snapshot }>();
  const unavailable = new Set<string>();
  let totalBytes = 0,
    totalEntries = 0;
  const locations = environment
    ? skillRoots(environment).map((v) => v.root)
    : [source, path.join(source, ".system")];
  const allDestinations = [...new Set(environment ? [source, ...destinations] : destinations)];
  const owned: ManagedSkill[] = [...previous];
  const persist = async () => {
    const next = JSON.stringify(owned);
    if ((await fs.readFile(manifestFile, "utf8").catch(() => "")) === next) return;
    await fs.mkdir(path.dirname(manifestFile), { recursive: true });
    const temp = `${manifestFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, next, { flag: "wx", mode: 0o600 });
      await fs.rename(temp, manifestFile);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  };
  const recoveryBlocked = await recoverSkillUpdates(owned, allDestinations, result, persist);
  const protectedRoots = new Set<string>();
  const realCodexRoot = await fs.realpath(source).catch(() => path.resolve(source));
  const systemRoot = path.join(source, ".system");
  const realSystemRoot = await fs.realpath(systemRoot).catch(() => path.resolve(systemRoot));
  const paused = new Set(
    environment ? (await readPausedSkills(environment)).map((v) => v.name.toLowerCase()) : [],
  );
  // Even paused/unavailable originals remain protected from every cleanup operation.
  const discovered = environment
    ? await discoverSkills(environment)
    : await discoverSkills({
        HOME: path.dirname(path.dirname(source)),
        USERPROFILE: path.dirname(path.dirname(source)),
        CODEX_HOME: path.dirname(source),
      });
  result.skipped.push(...discovered.skipped);
  for (const skill of discovered.skills) protectedRoots.add(skill.realPath);
  if (enabled)
    for (const skill of discovered.skills) {
      if (paused.has(skill.name.toLowerCase())) continue;
      try {
        const tree = await snapshot(skill.sourcePath, true);
        const bytes = tree.files.reduce((sum, file) => sum + file.bytes.length, 0);
        if (
          totalBytes + bytes > 64 * 1024 * 1024 ||
          totalEntries + tree.files.length + tree.directories.length > 4096
        )
          throw new Error("GLOBAL_CONFIG_SKILL_SYNC_LIMIT");
        totalBytes += bytes;
        totalEntries += tree.files.length + tree.directories.length;
        for (const destination of allDestinations) {
          const destinationRoot = await fs
            .realpath(destination)
            .catch(() => path.resolve(destination));
          if (
            path.relative(realCodexRoot, destinationRoot) === "" &&
            (within(systemRoot, skill.sourcePath) || within(realSystemRoot, skill.realPath))
          )
            continue;
          const name = path.join(destination, skill.name);
          const real = await fs.realpath(name).catch(() => path.resolve(name));
          if (real === skill.realPath || protectedRoots.has(real)) continue;
          if (!wanted.has(name)) wanted.set(name, { source: skill.sourcePath, tree });
        }
        result.skipped.push(...skill.conflicts);
      } catch {
        unavailable.add(skill.sourcePath);
        result.skipped.push(skill.sourcePath);
      }
    }
  // Every recursive delete below verifies the absolute path against an explicit native root.
  const remove = async (file: string) => {
    const absolute = path.resolve(file);
    const real = await fs.realpath(absolute);
    const parent = await fs.realpath(path.dirname(absolute));
    if (
      !allDestinations.some((root) => path.relative(root, path.dirname(absolute)) === "") ||
      path.relative(parent, path.dirname(real)) !== "" ||
      [...protectedRoots].some((root) => within(root, real)) ||
      !(await fs.lstat(absolute)).isDirectory() ||
      (await fs.lstat(absolute)).isSymbolicLink()
    )
      throw new Error("GLOBAL_CONFIG_SKILL_UNSAFE_PATH");
    await fs.rm(absolute, { recursive: true });
  };
  for (const entry of previous) {
    const index = owned.indexOf(entry);
    if (entry.recovery) {
      result.skipped.push(entry.name);
      continue;
    }
    if (
      !allDestinations.includes(path.dirname(entry.name)) ||
      !locations.some((root) => within(root, entry.source))
    ) {
      owned.splice(index, 1);
      continue;
    }
    const currentRoot = await fs.realpath(path.dirname(entry.name)).catch(() => "");
    if (
      !currentRoot ||
      path.relative(currentRoot, entry.root) !== "" ||
      protectedRoots.has(currentRoot)
    ) {
      result.skipped.push(entry.name);
      owned.splice(index, 1);
      continue;
    }
    const current = await snapshot(entry.name).catch(() => null);
    if (!current || current.digest !== entry.digest) {
      result.skipped.push(entry.name);
      owned.splice(index, 1); // A modified/replaced tree becomes the person's property.
      continue;
    }
    if (enabled && unavailable.has(entry.source)) {
      result.skipped.push(entry.name);
      continue;
    }
    const next = wanted.get(entry.name);
    if (!next) {
      await remove(entry.name);
      result.removed.push(entry.name);
      owned.splice(index, 1);
      await persist();
    } else if (next.tree.digest !== entry.digest) {
      // Stage before renaming the unchanged old tree; a failure keeps the previous version.
      const stage = await fs.mkdtemp(path.join(path.dirname(entry.name), ".rly0-sync-"));
      const old = `${stage}-old`;
      try {
        await materialize(stage, next.tree);
        if ((await snapshot(entry.name)).digest !== entry.digest)
          throw new Error("GLOBAL_CONFIG_SKILL_CHANGED");
        const recovery = {
          stage,
          old,
          digest: entry.digest,
          nextDigest: next.tree.digest,
          nextSource: next.source,
        };
        owned[index] = { ...entry, recovery };
        await persist(); // Proof must survive a crash between the two directory renames.
        await fs.rename(entry.name, old);
        try {
          await fs.rename(stage, entry.name);
        } catch (error) {
          await fs.rename(old, entry.name);
          throw error;
        }
        owned[index] = {
          name: entry.name,
          source: next.source,
          root: currentRoot,
          digest: next.tree.digest,
          recovery,
        };
        await persist();
        if ((await snapshot(old)).digest === entry.digest) {
          await remove(old);
          delete owned[index]?.recovery;
          await persist();
        } else result.skipped.push(old);
        result.synced.push(entry.name);
      } finally {
        if (await fs.lstat(stage).catch(() => null)) await remove(stage);
      }
    }
  }
  await persist();
  for (const [name, next] of wanted) {
    if (owned.some((v) => v.name === name)) continue;
    await fs.mkdir(path.dirname(name), { recursive: true });
    const realRoot = await fs.realpath(path.dirname(name));
    if (protectedRoots.has(realRoot)) {
      result.skipped.push(name);
      continue;
    }
    if (await fs.lstat(name).catch(() => null)) {
      result.skipped.push(name);
      continue;
    }
    const stage = await fs.mkdtemp(path.join(path.dirname(name), ".rly0-sync-"));
    try {
      await materialize(stage, next.tree);
      if (await fs.lstat(name).catch(() => null)) {
        result.skipped.push(name);
        continue;
      }
      try {
        await fs.rename(stage, name);
      } catch (error) {
        if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          result.skipped.push(name);
          continue;
        }
        throw error;
      }
      owned.push({ name, source: next.source, root: realRoot, digest: next.tree.digest });
      await persist();
      result.synced.push(name);
    } finally {
      if (await fs.lstat(stage).catch(() => null)) await remove(stage);
    }
  }
  return recoveryBlocked;
}

async function materialize(root: string, tree: Snapshot) {
  for (const dir of tree.directories) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const file of tree.files)
    await fs.writeFile(path.join(root, file.name), file.bytes, { flag: "wx" });
}
