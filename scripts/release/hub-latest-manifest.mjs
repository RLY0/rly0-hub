// Writes `latest.json`, uploaded to each GitHub Release next to the Hub installer. The Hub reads it
// from https://github.com/RLY0/rly0-hub/releases/latest/download/latest.json (download CDN, no
// API quota); the parser is `parseHubReleaseManifest` in packages/host-runtime.
//
//   node scripts/release/hub-latest-manifest.mjs --installer <RLY0-Hub-X.Y.Z-setup.exe>
//     --version X.Y.Z [--notes notes.md] --output latest.json
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`bad argument ${flag}`);
    options[flag.slice(2)] = value;
  }
  for (const required of ["installer", "version", "output"])
    if (!options[required]) throw new Error(`--${required} is required`);
  return options;
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function writeHubLatestManifest({ installer, version, notes, output, publishedAt }) {
  if (!SEMVER.test(version)) throw new Error(`not a release version: ${version}`);
  const name = `RLY0-Hub-${version}-setup.exe`;
  if (path.basename(installer) !== name) throw new Error(`installer must be named ${name}`);
  const info = await stat(installer);
  if (!info.isFile() || info.size === 0) throw new Error(`installer is empty: ${installer}`);
  const manifest = {
    schemaVersion: 1,
    version,
    name,
    size: info.size,
    sha256: await sha256(installer),
    publishedAt: publishedAt ?? new Date().toISOString(),
  };
  if (notes) {
    const text = (await readFile(notes, "utf8")).trim();
    if (text.length > 20_000) throw new Error("release notes exceed 20000 characters");
    if (text) manifest.notes = text;
  }
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  writeHubLatestManifest(parseArguments(process.argv.slice(2))).then(
    (manifest) => console.log(`${manifest.name} ${manifest.size} ${manifest.sha256}`),
    (error) => {
      console.error(`hub-latest-manifest: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    },
  );
}
