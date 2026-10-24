import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyValidationKit(root) {
  const canonicalRoot = await realpath(root);
  const manifestPath = path.join(canonicalRoot, "validation-manifest.json");
  if (!(await lstat(manifestPath)).isFile()) throw new Error("KIT_MANIFEST_REJECTED");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    !["macos-arm64", "macos-x64"].includes(manifest.target) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 10 ||
    manifest.files.length > 10000
  ) {
    throw new Error("KIT_MANIFEST_REJECTED");
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path.includes("\\") ||
      entry.path.includes("\0") ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      /^[A-Za-z]:/u.test(entry.path) ||
      entry.path.startsWith("/") ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      seen.has(entry.path)
    ) {
      throw new Error("KIT_PATH_REJECTED");
    }
    seen.add(entry.path);
    let file = canonicalRoot;
    for (const part of entry.path.split("/")) {
      file = path.join(file, part);
      const metadata = await lstat(file);
      if (metadata.isSymbolicLink()) throw new Error("KIT_SYMLINK_REJECTED");
    }
    if (!(await lstat(file)).isFile()) throw new Error("KIT_FILE_REJECTED");
    const digest = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    if (digest !== entry.sha256) throw new Error(`KIT_HASH_MISMATCH: ${entry.path}`);
  }
  for (const required of [
    "run-on-mac.sh",
    "verify-kit.mjs",
    "README.md",
    "core/Cargo.toml",
    "core/Cargo.lock",
    "core/src/main.rs",
    "core/source-snapshot.json",
    "core/scripts/validate-macos.sh",
    "hub/kit-manifest.json",
    "hub/build-on-mac.sh",
    "hub/sources/Rly0Hub.swift",
    "hub/payload/app/hub-service.mjs",
  ]) {
    if (!seen.has(required)) throw new Error(`KIT_FILE_MISSING: ${required}`);
  }
  const hub = JSON.parse(await readFile(path.join(canonicalRoot, "hub/kit-manifest.json"), "utf8"));
  if (hub.target !== manifest.target) throw new Error("KIT_ARCH_MISMATCH");
  return { target: manifest.target, filesVerified: seen.size };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  verifyValidationKit(import.meta.dirname).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
