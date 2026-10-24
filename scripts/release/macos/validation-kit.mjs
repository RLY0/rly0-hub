import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { prepareMacHubKit } from "./hub-dev-kit.mjs";

const runFile = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const templates = "apps/hub-desktop/macos/validation";

async function sourceFiles(root, directory = root) {
  const files = [];
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("SOURCE_SYMLINK_REJECTED");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("SOURCE_SYMLINK_REJECTED");
    if (entry.isDirectory()) files.push(...(await sourceFiles(root, file)));
    else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(file);
  }
  return files.sort();
}

async function copyFileChecked(source, destination) {
  if (!(await lstat(source)).isFile()) throw new Error("SOURCE_FILE_REJECTED");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source), { flag: "wx" });
}

async function fingerprints(root, directory = root) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await fingerprints(root, file)));
    else if (entry.isFile())
      files.push({
        path: path.relative(root, file).split(path.sep).join("/"),
        sha256: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      });
    else throw new Error("KIT_FILE_REJECTED");
  }
  return files;
}

async function revision(root) {
  const { stdout } = await runFile("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("SOURCE_REVISION_REJECTED");
  const status = await runFile("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  return { commit, hasLocalChanges: status.stdout.trim().length > 0 };
}

function outside(source, output) {
  const relative = path.relative(source, output);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export async function prepareValidationKit({
  outputDirectory,
  coreRoot,
  arch = "arm64",
  root = repositoryRoot,
  readRevision = revision,
}) {
  if (!outputDirectory || !coreRoot || !["arm64", "x64"].includes(arch))
    throw new Error("KIT_OPTIONS_REJECTED");
  const output = path.resolve(outputDirectory);
  const core = path.resolve(coreRoot);
  if (
    !outside(core, output) ||
    !outside(path.join(root, "apps"), output) ||
    !outside(output, core) ||
    !outside(output, root)
  )
    throw new Error("KIT_OUTPUT_REJECTED");
  const coreRevision = await readRevision(core);
  const hubRevision = await readRevision(root);
  const entries = [
    "Cargo.toml",
    "Cargo.lock",
    "scripts/validate-macos.sh",
    "docs/macos-secure-store.md",
  ];
  for (const file of await sourceFiles(path.join(core, "src")))
    entries.push(path.relative(core, file));
  for (const relative of entries) {
    const file = path.join(core, relative);
    if (!(await lstat(file)).isFile()) throw new Error("SOURCE_FILE_REJECTED");
  }
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  await prepareMacHubKit({ outputDirectory: path.join(output, "hub"), arch, root });
  for (const relative of entries)
    await copyFileChecked(path.join(core, relative), path.join(output, "core", relative));
  const snapshot = {
    schemaVersion: 1,
    ...coreRevision,
    files: await fingerprints(path.join(output, "core")),
  };
  await writeFile(
    path.join(output, "core/source-snapshot.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { flag: "wx" },
  );
  for (const file of ["verify-kit.mjs", "run-on-mac.sh", "README.md"]) {
    await copyFileChecked(path.join(root, templates, file), path.join(output, file));
  }
  const manifest = {
    schemaVersion: 1,
    target: `macos-${arch}`,
    sources: { core: coreRevision, hub: hubRevision },
    included: { coreSource: true, coreBinary: false, nodeRuntime: false, cargoDependencies: false },
    validation: {
      nativeBuild: "not_run",
      window: "not_run",
      persistentKeychain: "not_run",
      realAccount: "not_run",
      independentReview: "not_run",
    },
    files: await fingerprints(output),
  };
  await writeFile(
    path.join(output, "validation-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  return manifest;
}

export function parseValidationArguments(args) {
  const options = { arch: "arm64" };
  const seen = new Set();
  const keys = { "--output": "outputDirectory", "--core-source": "coreRoot", "--arch": "arch" };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!Object.hasOwn(keys, flag) || seen.has(flag)) throw new Error("KIT_OPTIONS_REJECTED");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("KIT_OPTIONS_REJECTED");
    seen.add(flag);
    options[keys[flag]] = value;
  }
  if (!options.outputDirectory || !options.coreRoot || !["arm64", "x64"].includes(options.arch)) {
    throw new Error(
      "usage: validation-kit.mjs --core-source <private-core-checkout> --output <new-directory> [--arch arm64|x64]",
    );
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  prepareValidationKit(parseValidationArguments(process.argv.slice(2))).then(
    (manifest) =>
      console.log(
        `Local Mac validation kit prepared: ${manifest.target}, ${manifest.files.length} files. Native tests have not run.`,
      ),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
