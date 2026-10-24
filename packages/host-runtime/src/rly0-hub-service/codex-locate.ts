import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Finds the official Codex executable for work the Hub does without Codex running (a private
 * `codex app-server` for "add account"). Only the file system is read; nothing is executed here.
 *
 * Windows, in the Launcher's order (`crates/platform/src/installation.rs`):
 * 1. `CODEXHOST_INSTALL_ROOT`, a portable (unpacked) Desktop: `<root>\app\resources\codex.exe`.
 * 2. The Desktop-managed CLI cache, `%LOCALAPPDATA%\OpenAI\Codex\bin[\<build>]\codex.exe`, newest
 *    first, which is what the Launcher hands to Codex as its stock CLI.
 * 3. The Microsoft Store package itself. Its folder under `C:\Program Files\WindowsApps` cannot be
 *    listed, but the package's app execution aliases in `%LOCALAPPDATA%\Microsoft\WindowsApps\
 *    OpenAI.Codex_<publisher>\` point into it, and its `app\resources\codex.exe` is readable and
 *    executable by the signed-in user.
 */

export type CodexLocationSource = "portable" | "desktopCache" | "storePackage" | "macosBundle";

export interface CodexLocation {
  readonly path: string;
  readonly source: CodexLocationSource;
}

export interface CodexLocateFileSystem {
  readdir(directory: string): Promise<{ name: string; isDirectory(): boolean }[]>;
  stat(file: string): Promise<{ isFile(): boolean; mtimeMs: number; mode?: number }>;
  realpath(file: string): Promise<string>;
  readlink(file: string): Promise<string>;
  readHeader?(file: string): Promise<Uint8Array>;
}

export interface CodexLocateOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly fileSystem?: CodexLocateFileSystem;
}

const nodeFileSystem: CodexLocateFileSystem = {
  readdir: (directory) => fs.readdir(directory, { withFileTypes: true }),
  stat: (file) => fs.stat(file),
  realpath: (file) => fs.realpath(file),
  readlink: (file) => fs.readlink(file),
  async readHeader(file) {
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(4);
      const { bytesRead } = await handle.read(buffer, 0, 4, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

const STORE_ALIAS_DIRECTORY = /^OpenAI\.Codex_[A-Za-z0-9]+$/u;
const STORE_PACKAGE_ROOT = /^(.*\\WindowsApps\\OpenAI\.Codex_[^\\]+)\\/iu;

async function isFile(fileSystem: CodexLocateFileSystem, file: string): Promise<boolean> {
  try {
    return (await fileSystem.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function portable(
  fileSystem: CodexLocateFileSystem,
  root: string | undefined,
): Promise<string | null> {
  if (!root || !path.win32.isAbsolute(root)) return null;
  for (const candidate of [
    path.win32.join(root, "app", "resources", "codex.exe"),
    path.win32.join(root, "resources", "codex.exe"),
  ]) {
    if (await isFile(fileSystem, candidate)) return candidate;
  }
  return null;
}

/** Newest `codex.exe` in the Desktop-managed cache that really lives inside it. */
async function desktopCache(
  fileSystem: CodexLocateFileSystem,
  localAppData: string,
): Promise<string | null> {
  const root = path.win32.join(localAppData, "OpenAI", "Codex", "bin");
  let canonicalRoot: string;
  try {
    canonicalRoot = (await fileSystem.realpath(root)).toLowerCase();
  } catch {
    return null;
  }
  const candidates = [path.win32.join(root, "codex.exe")];
  try {
    for (const entry of await fileSystem.readdir(root)) {
      if (entry.isDirectory()) candidates.push(path.win32.join(root, entry.name, "codex.exe"));
    }
  } catch {
    // The top-level copy is still worth checking.
  }
  let best: { file: string; modified: number } | null = null;
  for (const candidate of candidates) {
    try {
      const info = await fileSystem.stat(candidate);
      if (!info.isFile()) continue;
      const canonical = await fileSystem.realpath(candidate);
      if (!canonical.toLowerCase().startsWith(`${canonicalRoot}\\`)) continue;
      if (!best || info.mtimeMs > best.modified) best = { file: canonical, modified: info.mtimeMs };
    } catch {
      // Missing or unreadable: not a candidate.
    }
  }
  return best?.file ?? null;
}

/** `app\resources\codex.exe` of the installed Store package, found through its aliases. */
async function storePackage(
  fileSystem: CodexLocateFileSystem,
  localAppData: string,
): Promise<string | null> {
  const aliases = path.win32.join(localAppData, "Microsoft", "WindowsApps");
  let packages: { name: string; isDirectory(): boolean }[];
  try {
    packages = await fileSystem.readdir(aliases);
  } catch {
    return null;
  }
  for (const entry of packages) {
    if (!STORE_ALIAS_DIRECTORY.test(entry.name)) continue;
    const directory = path.win32.join(aliases, entry.name);
    let links: { name: string }[];
    try {
      links = await fileSystem.readdir(directory);
    } catch {
      continue;
    }
    for (const link of links) {
      if (!link.name.toLowerCase().endsWith(".exe")) continue;
      let target: string;
      try {
        target = await fileSystem.readlink(path.win32.join(directory, link.name));
      } catch {
        continue;
      }
      const root = STORE_PACKAGE_ROOT.exec(target.replaceAll("/", "\\"))?.[1];
      if (!root) continue;
      const candidate = path.win32.join(root, "app", "resources", "codex.exe");
      if (await isFile(fileSystem, candidate)) return candidate;
    }
  }
  return null;
}

export async function locateOfficialCodex(
  options: CodexLocateOptions,
): Promise<CodexLocation | null> {
  if ((options.platform ?? process.platform) === "darwin") return locateMacCodex(options);
  if ((options.platform ?? process.platform) !== "win32") return null;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const { environment } = options;
  const custom = await portable(fileSystem, environment.CODEXHOST_INSTALL_ROOT);
  if (custom) return { path: custom, source: "portable" };
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData || !path.win32.isAbsolute(localAppData)) return null;
  const cached = await desktopCache(fileSystem, localAppData);
  if (cached) return { path: cached, source: "desktopCache" };
  const packaged = await storePackage(fileSystem, localAppData);
  return packaged ? { path: packaged, source: "storePackage" } : null;
}

async function locateMacCodex(options: CodexLocateOptions): Promise<CodexLocation | null> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  if (!fileSystem.readHeader) return null;
  const explicit = options.environment.CODEXHOST_INSTALL_ROOT;
  const home = options.environment.HOME;
  const bundles =
    explicit !== undefined
      ? [explicit]
      : [
          "/Applications/Codex.app",
          ...(home && path.posix.isAbsolute(home)
            ? [path.posix.join(home, "Applications/Codex.app")]
            : []),
        ];
  for (const bundle of bundles) {
    if (!path.posix.isAbsolute(bundle) || !bundle.endsWith(".app")) continue;
    let canonicalBundle: string;
    try {
      canonicalBundle = await fileSystem.realpath(bundle);
    } catch {
      continue;
    }
    for (const relative of [
      "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "Contents/Resources/codex",
    ]) {
      try {
        const candidate = await fileSystem.realpath(path.posix.join(canonicalBundle, relative));
        const inside = path.posix.relative(canonicalBundle, candidate);
        if (!inside || inside === ".." || inside.startsWith("../") || path.posix.isAbsolute(inside))
          continue;
        const info = await fileSystem.stat(candidate);
        if (!info.isFile() || info.mode === undefined || (info.mode & 0o111) === 0) continue;
        const header = Buffer.from(await fileSystem.readHeader(candidate)).toString("hex");
        if (
          ![
            "cffaedfe",
            "cefaedfe",
            "feedfacf",
            "feedface",
            "cafebabe",
            "bebafeca",
            "cafebabf",
            "bfbafeca",
          ].includes(header)
        )
          continue;
        return { path: candidate, source: "macosBundle" };
      } catch {
        continue;
      }
    }
  }
  return null;
}
