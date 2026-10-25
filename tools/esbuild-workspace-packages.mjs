import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Resolves `@codexhost/*` imports to the Workspace package directory itself, never to whatever
 * sits under `node_modules/@codexhost/`. npm links those, so normally nothing changes; where
 * links cannot be created or followed (a sandbox that blocks symlinks and junctions), the
 * fallback is a copy that goes stale and that the bundle audits rightly reject as an
 * unreviewed runtime package.
 */
export async function workspacePackageDirectories(repositoryRoot) {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const directories = new Map();
  for (const pattern of manifest.workspaces ?? []) {
    if (!pattern.endsWith("/*")) throw new Error(`Unsupported workspace pattern: ${pattern}`);
    const parent = path.join(repositoryRoot, pattern.slice(0, -2));
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(parent, entry.name);
      const name = await readFile(path.join(directory, "package.json"), "utf8")
        .then((text) => JSON.parse(text).name)
        .catch(() => null);
      if (typeof name === "string" && name.startsWith("@codexhost/"))
        directories.set(name, directory);
    }
  }
  return directories;
}

/** The ESM target of a package `exports` entry: a path, or the `import`/`default` condition. */
function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") return exportTarget(entry.import ?? entry.default);
  return null;
}

export function workspacePackagesPlugin(directories) {
  return {
    name: "codexhost-workspace-packages",
    setup(build) {
      build.onResolve({ filter: /^@codexhost\// }, async (args) => {
        const [scope, name, ...rest] = args.path.split("/");
        const directory = directories.get(`${scope}/${name}`);
        if (!directory) return undefined;
        const { exports } = JSON.parse(
          await readFile(path.join(directory, "package.json"), "utf8"),
        );
        const subpath = rest.length > 0 ? `./${rest.join("/")}` : ".";
        const target = exportTarget(
          typeof exports === "string" && subpath === "." ? exports : exports?.[subpath],
        );
        if (!target) {
          return {
            errors: [{ text: `${args.path} is not exported by ${path.basename(directory)}` }],
          };
        }
        return { path: path.join(directory, target) };
      });
    },
  };
}
