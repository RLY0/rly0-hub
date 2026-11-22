import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { hubNodeBinDirectory } from "@codexhost/harness-discovery";

import type { CommandRunner } from "./agent-installer.js";
import { NODE_DIST_SOURCES, sha256FromShasums, type InstallerFiles } from "./node-msi.js";

/**
 * Node.js for a Mac without it: the official LTS `.tar.gz` from nodejs.org (or its npmmirror
 * copy), checked against the release's SHASUMS256.txt, extracted into the Hub's own data directory
 * (`<data dir>/runtime/node-vX-darwin-<arch>`, linked as `runtime/node`). No administrator rights,
 * nothing outside that directory changes, and `npm install -g` then installs CLIs beside it, where
 * harness discovery looks (`hubNodeBinDirectory`). An existing Hub-installed Node.js is kept.
 */

export type NodeMacArch = "arm64" | "x64";

export interface NodeMacRelease {
  readonly version: string;
  readonly file: string;
  readonly directory: string;
}

export interface NodeMacOptions {
  readonly runner: CommandRunner;
  /** Download environment (the Hub's proxy settings applied). */
  readonly environment: NodeJS.ProcessEnv;
  readonly arch: NodeMacArch;
  readonly files: InstallerFiles;
  readonly log: (text: string) => void;
  readonly sources?: readonly string[];
  readonly curl?: string;
  readonly tar?: string;
}

export type NodeMacOutcome =
  | { readonly ok: true; readonly bin: string }
  | { readonly ok: false; readonly reason: "NETWORK" | "INSTALL_FAILED" };

const SMALL_DOWNLOAD_MS = 60_000;
const ARCHIVE_DOWNLOAD_MS = 10 * 60_000;
const EXTRACT_MS = 5 * 60_000;
const VERSION = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

export function macNodeArch(arch: string = process.arch): NodeMacArch {
  return arch === "x64" ? "x64" : "arm64";
}

/** The newest LTS release in nodejs.org's `index.json` that ships a macOS tarball for `arch`. */
export function pickNodeLtsTarball(index: unknown, arch: NodeMacArch): NodeMacRelease | null {
  if (!Array.isArray(index)) return null;
  for (const entry of index as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { version, lts, files } = entry as { version?: unknown; lts?: unknown; files?: unknown };
    if (typeof version !== "string" || !VERSION.test(version)) continue;
    if (!lts || !Array.isArray(files) || !files.includes(`osx-${arch}-tar`)) continue;
    const directory = `node-${version}-darwin-${arch}`;
    return { version, file: `${directory}.tar.gz`, directory };
  }
  return null;
}

/** `<data dir>/runtime`, the parent of the `node` link. */
export function hubNodeRuntimeDirectory(environment: NodeJS.ProcessEnv): string {
  return path.dirname(path.dirname(hubNodeBinDirectory(environment, environment.HOME ?? "", "darwin")));
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  );
}

export async function installNodeForMac(options: NodeMacOptions): Promise<NodeMacOutcome> {
  const { runner, environment, files, log } = options;
  const curl = options.curl ?? "/usr/bin/curl";
  const tar = options.tar ?? "/usr/bin/tar";
  const runtime = hubNodeRuntimeDirectory(environment);
  const link = path.join(runtime, "node");
  const bin = path.join(link, "bin");

  const download = async (url: string, file: string, timeoutMs: number): Promise<boolean> => {
    const result = await runner.run(
      curl,
      ["-fsSL", "--retry", "2", "--connect-timeout", "20", "-o", file, url],
      { environment, shell: false, timeoutMs },
    );
    if (result.code === 0) return true;
    log(`下载失败：${url}\n${result.output.trim()}`);
    return false;
  };
  const text = async (file: string): Promise<string> =>
    Buffer.from(await files.read(file)).toString("utf8");

  let directory: string;
  try {
    directory = await files.makeTempDirectory();
  } catch (error) {
    log(`无法创建临时目录：${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reason: "INSTALL_FAILED" };
  }
  let reason: "NETWORK" | "INSTALL_FAILED" = "NETWORK";
  try {
    for (const source of options.sources ?? NODE_DIST_SOURCES) {
      log(`[RLY/0 Hub] 从 ${source} 下载 Node.js LTS（装在 RLY/0 Hub 自己的文件夹里，不需要电脑密码）`);
      const indexFile = path.join(directory, "index.json");
      if (!(await download(`${source}/index.json`, indexFile, SMALL_DOWNLOAD_MS))) continue;
      let release: NodeMacRelease | null = null;
      try {
        release = pickNodeLtsTarball(JSON.parse(await text(indexFile)), options.arch);
      } catch {
        log(`${source}/index.json 不是有效的版本列表（可能被网络拦截）。`);
        continue;
      }
      if (!release) {
        log(`${source} 没有适用于 ${options.arch} Mac 的 Node.js LTS。`);
        continue;
      }
      const base = `${source}/${release.version}`;
      const sumsFile = path.join(directory, "SHASUMS256.txt");
      if (!(await download(`${base}/SHASUMS256.txt`, sumsFile, SMALL_DOWNLOAD_MS))) continue;
      const expected = sha256FromShasums(await text(sumsFile), release.file);
      if (!expected) {
        log(`SHASUMS256.txt 中没有 ${release.file} 的校验值。`);
        continue;
      }
      const archive = path.join(directory, release.file);
      if (!(await download(`${base}/${release.file}`, archive, ARCHIVE_DOWNLOAD_MS))) continue;
      const actual = createHash("sha256")
        .update(await files.read(archive))
        .digest("hex");
      if (actual !== expected) {
        log(`${release.file} 校验失败（SHA256 不一致），已丢弃。`);
        reason = "INSTALL_FAILED";
        continue;
      }
      log(`[RLY/0 Hub] 解压 ${release.file}（SHA256 已校验）`);
      const extracted = path.join(directory, "extract");
      await fs.mkdir(extracted, { recursive: true, mode: 0o700 });
      const unpacked = await runner.run(tar, ["-xzf", archive, "-C", extracted], {
        environment,
        shell: false,
        timeoutMs: EXTRACT_MS,
      });
      const unpackedDirectory = path.join(extracted, release.directory);
      if (unpacked.code !== 0 || !(await exists(path.join(unpackedDirectory, "bin", "node")))) {
        log(`解压失败：${unpacked.output.trim() || "没有找到 bin/node"}`);
        return { ok: false, reason: "INSTALL_FAILED" };
      }
      await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
      const target = path.join(runtime, release.directory);
      if (!(await exists(target))) await fs.rename(unpackedDirectory, target);
      // Point `runtime/node` at it in one step: a new link renamed over the old one.
      const pending = path.join(runtime, `.node-${randomUUID()}`);
      await fs.symlink(release.directory, pending);
      await fs.rename(pending, link);
      log(`[RLY/0 Hub] Node.js ${release.version} 已装好：${bin}`);
      return { ok: true, bin };
    }
    return { ok: false, reason };
  } catch (error) {
    log(`安装 Node.js 时出错：${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reason: "INSTALL_FAILED" };
  } finally {
    await files.remove(directory).catch(() => undefined);
  }
}
