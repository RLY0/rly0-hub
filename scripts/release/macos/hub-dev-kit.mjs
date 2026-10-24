import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { buildHubServiceBundle } from "../../../packages/host-runtime/scripts/build-hub-service.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const nativeSource = "apps/hub-desktop/macos";

export function parseHubDevArguments(args) {
  const options = { prepareOnly: false, nodePath: process.execPath, arch: "arm64" };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--prepare-only") options.prepareOnly = true;
    else if (flag === "--output" || flag === "--node" || flag === "--arch") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`missing value: ${flag}`);
      if (flag === "--output") options.outputDirectory = path.resolve(value);
      else if (flag === "--node") options.nodePath = path.resolve(value);
      else options.arch = value;
    } else throw new Error(`unknown option: ${flag}`);
  }
  if (!options.outputDirectory) throw new Error("--output <new-directory> is required");
  if (!["arm64", "x64"].includes(options.arch)) throw new Error("--arch must be arm64 or x64");
  if (options.prepareOnly && seen.has("--node")) {
    throw new Error("--node is only used when building on a Mac");
  }
  return options;
}

async function copyTree(source, destination) {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) throw new Error("source kit cannot contain symbolic links");
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
      await copyTree(path.join(source, name), path.join(destination, name));
    }
  } else if (metadata.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { errorOnExist: true, force: false });
  } else throw new Error("source kit can only contain regular files and directories");
}

async function fingerprint(root, directory = root) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolute = path.join(directory, name);
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) files.push(...(await fingerprint(root, absolute)));
    else if (metadata.isFile()) {
      files.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        sha256: createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      });
    } else throw new Error("unexpected source kit entry");
  }
  return files;
}

export async function prepareMacHubKit({ outputDirectory, root = repositoryRoot, arch = "arm64" }) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("--arch must be arm64 or x64");
  const output = path.resolve(outputDirectory);
  const source = path.join(root, "apps/hub-desktop");
  const relative = path.relative(source, output);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    throw new Error("output must be outside apps/hub-desktop");
  }
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  await copyTree(path.join(root, "apps/hub-desktop/www"), path.join(output, "payload/app/hub-ui"));
  await mkdir(path.join(output, "sources"));
  for (const file of ["Rly0Hub.swift", "bridge.js", "Info.plist"]) {
    await copyTree(path.join(root, nativeSource, file), path.join(output, "sources", file));
  }
  for (const file of ["build-on-mac.sh", "README.md"]) {
    await copyTree(path.join(root, nativeSource, file), path.join(output, file));
  }
  await buildHubServiceBundle({
    repositoryRoot: root,
    outputPath: path.join(output, "payload/app/hub-service.mjs"),
  });
  const manifest = {
    schemaVersion: 1,
    target: `macos-${arch}`,
    stage: "prepared",
    validation: { nativeBuild: "not_run", launch: "not_run", realAccount: "not_run" },
    included: { nodeRuntime: false, core: false },
    knownGaps: [
      "macOS secure credential storage",
      "Codex launch integration",
      "automatic updates",
      "Developer ID signing and notarization",
    ],
    files: await fingerprint(output),
  };
  await writeFile(path.join(output, "kit-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function runHubDevBuild(options, platform = process.platform) {
  if (!options.prepareOnly && platform !== "darwin") {
    throw new Error("native macOS build requires a Mac; use --prepare-only on Windows");
  }
  const manifest = await prepareMacHubKit(options);
  if (options.prepareOnly) return manifest;
  await new Promise((resolve, reject) => {
    const child = spawn(
      "/bin/bash",
      [path.join(options.outputDirectory, "build-on-mac.sh"), options.nodePath],
      {
        stdio: "inherit",
        shell: false,
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`macOS development build failed (${code})`));
    });
  });
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runHubDevBuild(parseHubDevArguments(process.argv.slice(2))).then(
    (manifest) =>
      console.log(
        `macOS source kit prepared: ${manifest.files.length} files; see kit-manifest.json for validation status`,
      ),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
