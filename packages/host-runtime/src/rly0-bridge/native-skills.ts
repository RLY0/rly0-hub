import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { NativeResourceSync } from "./native-resources.js";

type ManagedSkill = { name: string; source: string; root: string; digest: string };
type Snapshot = { digest: string; files: { name: string; bytes: Buffer }[]; directories: string[] };
const within = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** A bounded tree of real files: never follows links or copies a skill's nested Git repository. */
async function snapshot(root: string, filterCredentials = false): Promise<Snapshot> {
  const files: Snapshot["files"] = [],
    directories: string[] = [];
  let bytes = 0,
    entries = 0;
  async function visit(relative: string) {
    const absolute = path.join(root, relative),
      stat = await fs.lstat(absolute);
    if (++entries > 1024 || stat.isSymbolicLink())
      throw new Error("GLOBAL_CONFIG_SKILL_UNSAFE_TREE");
    if (stat.isDirectory()) {
      directories.push(relative);
      for (const entry of (await fs.readdir(absolute)).sort()) {
        if (
          filterCredentials &&
          /^(?:\.env(?:[.-].*)?|\.aws|\.ssh|\.npmrc|\.netrc|\.pypirc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|tokens?(?:[._-].*)?|auth\.json|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?)$|\.(?:pem|key|p12|pfx|keystore)$/iu.test(
            entry,
          )
        )
          continue;
        if (entry === ".git") throw new Error("GLOBAL_CONFIG_SKILL_UNSAFE_TREE");
        await visit(path.join(relative, entry));
      }
    } else {
      if (!stat.isFile() || stat.nlink > 1 || (bytes += stat.size) > 16 * 1024 * 1024)
        throw new Error("GLOBAL_CONFIG_SKILL_UNSAFE_TREE");
      files.push({ name: relative, bytes: await fs.readFile(absolute) });
    }
  }
  await visit("");
  const hash = createHash("sha256");
  hash.update(JSON.stringify(directories));
  for (const file of files)
    hash
      .update(JSON.stringify(file.name))
      .update(String(file.bytes.length))
      .update(":")
      .update(file.bytes);
  return { digest: hash.digest("hex"), files, directories };
}

export async function syncNativeSkills(
  source: string,
  destinations: string[],
  manifestFile: string,
  enabled: boolean,
  result: NativeResourceSync,
) {
  let previous: ManagedSkill[];
  const realSource = await fs.realpath(source).catch(() => path.resolve(source));
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (v) =>
          typeof v?.name !== "string" ||
          typeof v?.source !== "string" ||
          typeof v?.root !== "string" ||
          !/^[a-f0-9]{64}$/u.test(v?.digest),
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
  if (enabled)
    for (const base of [source, path.join(source, ".system")]) {
      const entries = await fs
        .readdir(base, { withFileTypes: true })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
      for (const entry of entries.slice(0, 256)) {
        if (
          !entry.isDirectory() ||
          entry.name.startsWith(".") ||
          !/^[\p{L}\p{N}_.-]+$/u.test(entry.name)
        )
          continue;
        const target = path.join(base, entry.name);
        try {
          if (!(await fs.lstat(path.join(target, "SKILL.md"))).isFile()) continue;
          const tree = await snapshot(target, true);
          const bytes = tree.files.reduce((sum, file) => sum + file.bytes.length, 0);
          if (
            totalBytes + bytes > 64 * 1024 * 1024 ||
            totalEntries + tree.files.length + tree.directories.length > 4096
          )
            throw new Error("GLOBAL_CONFIG_SKILL_SYNC_LIMIT");
          totalBytes += bytes;
          totalEntries += tree.files.length + tree.directories.length;
          for (const destination of destinations) {
            const name = path.join(destination, entry.name);
            if (!wanted.has(name)) wanted.set(name, { source: target, tree });
          }
        } catch {
          unavailable.add(target);
          result.skipped.push(target);
        }
      }
    }
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
  // Every recursive delete below verifies the absolute path against an explicit native root.
  const remove = async (file: string) => {
    const absolute = path.resolve(file);
    const real = await fs.realpath(absolute);
    const parent = await fs.realpath(path.dirname(absolute));
    if (
      !destinations.some((root) => path.relative(root, path.dirname(absolute)) === "") ||
      path.relative(parent, path.dirname(real)) !== "" ||
      within(realSource, real) ||
      !(await fs.lstat(absolute)).isDirectory() ||
      (await fs.lstat(absolute)).isSymbolicLink()
    )
      throw new Error("GLOBAL_CONFIG_SKILL_UNSAFE_PATH");
    await fs.rm(absolute, { recursive: true });
  };
  for (const entry of previous) {
    const index = owned.indexOf(entry);
    if (!destinations.includes(path.dirname(entry.name)) || !within(source, entry.source)) {
      owned.splice(index, 1);
      continue;
    }
    const currentRoot = await fs.realpath(path.dirname(entry.name)).catch(() => "");
    if (
      !currentRoot ||
      path.relative(currentRoot, entry.root) !== "" ||
      within(realSource, currentRoot)
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
        };
        await persist();
        if ((await snapshot(old)).digest === entry.digest) await remove(old);
        else result.skipped.push(old);
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
    if (within(realSource, realRoot)) {
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
}

async function materialize(root: string, tree: Snapshot) {
  for (const dir of tree.directories) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const file of tree.files)
    await fs.writeFile(path.join(root, file.name), file.bytes, { flag: "wx" });
}
