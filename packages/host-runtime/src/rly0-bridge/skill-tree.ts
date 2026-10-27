import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type Snapshot = {
  digest: string;
  files: { name: string; bytes: Buffer }[];
  directories: string[];
};
const within = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** Follow only links inside this skill, with canonical ancestor cycle detection and fixed limits. */
export async function snapshot(root: string, filterCredentials = false): Promise<Snapshot> {
  const files: Snapshot["files"] = [],
    directories: string[] = [];
  const realRoot = await fs.realpath(root);
  const ancestors = new Set<string>();
  let bytes = 0,
    entries = 0;
  async function visit(relative: string) {
    const absolute = path.join(root, relative),
      real = await fs.realpath(absolute),
      stat = await fs.stat(real);
    if (++entries > 1024 || !within(realRoot, real) || ancestors.has(real))
      throw new Error("GLOBAL_CONFIG_SKILL_UNSAFE_TREE");
    if (stat.isDirectory()) {
      ancestors.add(real);
      directories.push(relative);
      for (const entry of (await fs.readdir(absolute)).sort()) {
        if (
          filterCredentials &&
          /^(?:\.env(?:[.-].*)?|\.aws|\.ssh|\.npmrc|\.netrc|\.pypirc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|tokens?(?:[._-].*)?|auth\.json|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?)$|\.(?:pem|key|p12|pfx|keystore)$/iu.test(
            entry,
          )
        )
          continue;
        if (entry.toLowerCase() === ".git") {
          if (filterCredentials) continue; // Never copy Git metadata, including worktree pointers/links.
          throw new Error("GLOBAL_CONFIG_SKILL_UNSAFE_TREE");
        }
        await visit(path.join(relative, entry));
      }
      ancestors.delete(real);
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
