#!/usr/bin/env node
// Builds the standalone macOS RLY/0 Hub: `RLY0 Hub.app` (Swift window shell, Hub service and
// pages, bundled Node, rly0-core and the codexhost payload that opens Codex) plus its DMG.
// `Contents/Resources` has the Windows Hub's install layout: the codexhost payload as is
// (`bin/codexhost` is the real Launcher: no arguments open Codex, `inspect --json` reports
// compatibility), with the Hub's `app/hub-service.mjs`, `app/hub-ui/` and `runtime/rly0-core`.
//
//   node scripts/release/macos/package-hub.mjs --core <rly0-core> [--core-sha256 <hex>]
//        [--sign -|<identity>] [--payload <prepared macos-arm64 payload>] [--output <new dir>]
//
// rly0-core is closed source and built in its own repository; the given binary is copied
// byte for byte and keeps its own signature, so Keychain access already granted to it survives.
// Public builds are ad-hoc signed ("-"); a Mac with a local code-signing identity signs its own
// copy with --sign <SHA-1>. No Developer ID, notarization or automatic update is involved.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildHubServiceBundle } from "../../../packages/host-runtime/scripts/build-hub-service.mjs";
import { prepareReleasePayload } from "../prepare-payload.mjs";
import { RELEASE_TARGETS } from "../targets.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const target = RELEASE_TARGETS["macos-arm64"];
export const BUNDLE_ID = "com.rly0.hub.macos";
export const APP_NAME = "RLY0 Hub.app";
// The codexhost payload (its Node also runs the Hub service).
const CODEXHOST_PARTS = ["bin", "libexec", "app", "runtime", "licenses", "THIRD_PARTY_NOTICES.txt"];
const CODEXHOST_EXECUTABLES = [
  "bin/codexhost",
  "libexec/codexhost-shim",
  "libexec/codexhost-updater",
  "runtime/node",
];

export function parsePackageArguments(args) {
  const options = { sign: "-" };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`duplicate option: ${flag}`);
    seen.add(flag);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value: ${flag}`);
    if (flag === "--core") options.core = path.resolve(value);
    else if (flag === "--core-sha256") options.coreSha256 = value.toLowerCase();
    else if (flag === "--sign") options.sign = value;
    else if (flag === "--payload") options.payload = path.resolve(value);
    else if (flag === "--output") options.output = path.resolve(value);
    else throw new Error(`unknown option: ${flag}`);
  }
  if (!options.core) throw new Error("--core <rly0-core binary> is required");
  if (options.coreSha256 && !/^[0-9a-f]{64}$/u.test(options.coreSha256)) {
    throw new Error("--core-sha256 must be 64 hex characters");
  }
  if (options.sign !== "-" && !/^[0-9A-F]{40}$/u.test(options.sign)) {
    throw new Error("--sign must be '-' (ad-hoc) or a code-signing identity SHA-1");
  }
  return options;
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)),
    );
  });
}

async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function listFiles(root, current = root) {
  const files = [];
  for (const name of (await readdir(current)).sort()) {
    const absolute = path.join(current, name);
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
}

/** Local absolute paths a release must never contain (build machine, user, repository). */
export function privatePathNeedles(environment = process.env, root = repositoryRoot) {
  const home = environment.HOME || os.homedir();
  // The account's own home too: a build under a temporary HOME must not miss /Users/<name>.
  const needles = new Set([home, os.userInfo().homedir, root, "/Volumes/RLY0Dev"]);
  return [...needles].filter((needle) => needle && needle.length > 4);
}

export async function findPrivatePaths(appRoot, needles = privatePathNeedles()) {
  const hits = [];
  for (const relative of await listFiles(appRoot)) {
    const file = path.join(appRoot, relative);
    if ((await lstat(file)).isSymbolicLink()) continue;
    const content = await readFile(file);
    for (const needle of needles) {
      if (content.includes(Buffer.from(needle))) hits.push({ file: relative, needle });
    }
  }
  return hits;
}

async function makeIcon(resources) {
  const work = await mkdtemp(path.join(os.tmpdir(), "rly0-hub-icon-"));
  try {
    const iconset = path.join(work, "AppIcon.iconset");
    await mkdir(iconset);
    const png = path.join(repositoryRoot, "crates/launcher/assets/codexhost.png");
    for (const size of [16, 32, 128, 256, 512]) {
      for (const [scale, suffix] of [
        [1, ""],
        [2, "@2x"],
      ]) {
        await execFileAsync("/usr/bin/sips", [
          "-z",
          String(size * scale),
          String(size * scale),
          png,
          "--out",
          path.join(iconset, `icon_${size}x${size}${suffix}.png`),
        ]);
      }
    }
    await execFileAsync("/usr/bin/iconutil", [
      "-c",
      "icns",
      iconset,
      "-o",
      path.join(resources, "AppIcon.icns"),
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function writeInfoPlist(contents, version) {
  const plist = path.join(contents, "Info.plist");
  await cp(path.join(repositoryRoot, "apps/hub-desktop/macos/Info.plist"), plist);
  for (const [key, value] of [
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
  ]) {
    await execFileAsync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
  }
  await execFileAsync("/usr/bin/plutil", [
    "-replace",
    "CFBundleIconFile",
    "-string",
    "AppIcon",
    plist,
  ]);
  await execFileAsync("/usr/bin/plutil", ["-lint", plist]);
  await writeFile(path.join(contents, "PkgInfo"), "APPL????");
}

async function compileShell(contents) {
  // Compiled from a neutral copy so no build-machine path ends up in the binary.
  const work = await mkdtemp(path.join(os.tmpdir(), "rly0-hub-swift-"));
  try {
    await cp(
      path.join(repositoryRoot, "apps/hub-desktop/macos/Rly0Hub.swift"),
      path.join(work, "Rly0Hub.swift"),
    );
    await mkdir(path.join(contents, "MacOS"), { recursive: true });
    await run(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-swift-version",
        "5",
        "-O",
        "-target",
        "arm64-apple-macos12.0",
        "-framework",
        "AppKit",
        "-framework",
        "WebKit",
        "Rly0Hub.swift",
        "-o",
        path.join(contents, "MacOS", "rly0-hub"),
      ],
      { cwd: work },
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function codesign(file, identity, extra = []) {
  await execFileAsync("/usr/bin/codesign", ["--force", "--sign", identity, ...extra, file]);
}

async function makeDmg({ app, dmg, version, output }) {
  const stage = await mkdtemp(path.join(output, ".dmg-stage-"));
  try {
    await run("/usr/bin/ditto", [app, path.join(stage, APP_NAME)]);
    await symlink("/Applications", path.join(stage, "Applications"));
    await cp(
      path.join(repositoryRoot, "apps/hub-desktop/macos/首次打开必读.txt"),
      path.join(stage, "首次打开必读.txt"),
    );
    await rm(dmg, { force: true });
    await run("/usr/bin/hdiutil", [
      "create",
      "-volname",
      `RLY0 Hub ${version}`,
      "-srcfolder",
      stage,
      "-fs",
      "HFS+",
      "-format",
      "UDZO",
      "-ov",
      dmg,
    ]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  await run("/usr/bin/hdiutil", ["verify", dmg]);
}

export async function packageMacHub(options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("the macOS Hub package is built on an Apple Silicon Mac");
  }
  const coreSha256 = await sha256(options.core);
  if (options.coreSha256 && coreSha256 !== options.coreSha256) {
    throw new Error(`rly0-core SHA-256 ${coreSha256} does not match --core-sha256`);
  }
  await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", options.core]);
  const version = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ).version;
  const payloadRoot =
    options.payload ?? (await prepareReleasePayload({ target, root: repositoryRoot })).payloadRoot;
  const output =
    options.output ?? path.join(repositoryRoot, "build", "release", version, target.id, "hub");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const app = path.join(output, APP_NAME);
  const contents = path.join(app, "Contents");
  const resources = path.join(contents, "Resources");
  await mkdir(resources, { recursive: true });

  // codexhost (opens Codex with the Hub's renderer extension and external agents).
  for (const part of CODEXHOST_PARTS) {
    await cp(path.join(payloadRoot, part), path.join(resources, part), { recursive: true });
  }
  await cp(options.core, path.join(resources, "runtime", "rly0-core"));
  await chmod(path.join(resources, "runtime", "rly0-core"), 0o755);
  // Hub service, pages and the page bridge.
  await buildHubServiceBundle({
    repositoryRoot,
    outputPath: path.join(resources, "app", "hub-service.mjs"),
  });
  await cp(
    path.join(repositoryRoot, "apps/hub-desktop/www"),
    path.join(resources, "app", "hub-ui"),
    {
      recursive: true,
    },
  );
  await cp(
    path.join(repositoryRoot, "apps/hub-desktop/macos/bridge.js"),
    path.join(resources, "mac-bridge.js"),
  );
  for (const file of ["LICENSE", "NOTICE.md"]) {
    await cp(path.join(repositoryRoot, file), path.join(resources, file));
  }
  await writeInfoPlist(contents, version);
  await makeIcon(resources);
  await compileShell(contents);

  // Sign inside out; Core keeps the signature it came with.
  const identity = options.sign;
  for (const relative of CODEXHOST_EXECUTABLES)
    await codesign(path.join(resources, relative), identity);
  await codesign(path.join(contents, "MacOS", "rly0-hub"), identity, ["--identifier", BUNDLE_ID]);
  await codesign(app, identity, ["--identifier", BUNDLE_ID]);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  if ((await sha256(path.join(resources, "runtime", "rly0-core"))) !== coreSha256) {
    throw new Error("rly0-core changed while packaging");
  }
  const { stdout: nodeVersion } = await execFileAsync(path.join(resources, "runtime", "node"), [
    "--version",
  ]);
  const { stdout: launcherVersion } = await execFileAsync(
    path.join(resources, "bin", "codexhost"),
    ["--version"],
  );
  if (launcherVersion.trim() !== version) {
    throw new Error(`bundled codexhost reports ${launcherVersion.trim()}, expected ${version}`);
  }
  const hits = await findPrivatePaths(app);
  if (hits.length > 0) {
    throw new Error(`private paths in the package: ${JSON.stringify(hits.slice(0, 10))}`);
  }

  const dmg = path.join(output, `RLY0-Hub-${version}-macos-arm64.dmg`);
  await makeDmg({ app, dmg, version, output });
  const manifest = {
    schemaVersion: 1,
    product: "RLY/0 Hub",
    version,
    target: target.id,
    signing: identity === "-" ? "ad-hoc" : `local identity ${identity}`,
    node: nodeVersion.trim(),
    core: { sha256: coreSha256, signatureKept: true },
    dmg: { file: path.basename(dmg), sha256: await sha256(dmg) },
    files: await Promise.all(
      (await listFiles(app)).map(async (relative) => ({
        path: relative,
        sha256: await sha256(path.join(app, relative)),
      })),
    ),
  };
  await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { app, dmg, manifest };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  packageMacHub(parsePackageArguments(process.argv.slice(2))).then(
    ({ app, dmg, manifest }) => {
      console.log(`app=${app}`);
      console.log(`dmg=${dmg}`);
      console.log(`dmg_sha256=${manifest.dmg.sha256}`);
    },
    (error) => {
      console.error(`macOS Hub package: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    },
  );
}
