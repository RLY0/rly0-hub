import { createHash } from "node:crypto";
import path from "node:path";

import type { CommandRunner } from "./agent-installer.js";
import { powershellArguments, powershellQuote } from "./install-paths.js";

/**
 * Node.js for PCs without winget: the official LTS MSI from nodejs.org (or its npmmirror copy when
 * nodejs.org is unreachable), checked against the release's SHASUMS256.txt before msiexec runs it.
 * The MSI is per-machine, so Windows asks for administrator approval (UAC) while it installs.
 */

export const NODE_DIST_SOURCES = [
  "https://nodejs.org/dist",
  "https://npmmirror.com/mirrors/node",
] as const;

export type NodeMsiArch = "x64" | "x86" | "arm64";

export interface NodeMsiRelease {
  readonly version: string;
  readonly file: string;
}

export interface InstallerFiles {
  makeTempDirectory(): Promise<string>;
  read(file: string): Promise<Uint8Array>;
  remove(target: string): Promise<void>;
}

export interface NodeMsiOptions {
  readonly runner: CommandRunner;
  readonly environment: NodeJS.ProcessEnv;
  readonly powershell: string;
  readonly msiexec: string;
  readonly arch: NodeMsiArch;
  readonly files: InstallerFiles;
  readonly log: (text: string) => void;
  readonly sources?: readonly string[];
}

export type NodeMsiOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "NETWORK" | "PERMISSION" | "INSTALL_FAILED" };

const SMALL_DOWNLOAD_MS = 60_000;
const MSI_DOWNLOAD_MS = 10 * 60_000;
const MSI_INSTALL_MS = 15 * 60_000;
const VERSION = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

export function windowsNodeArch(environment: NodeJS.ProcessEnv): NodeMsiArch {
  const arch = (
    environment.PROCESSOR_ARCHITEW6432 ??
    environment.PROCESSOR_ARCHITECTURE ??
    ""
  ).toUpperCase();
  if (arch === "ARM64") return "arm64";
  if (arch === "X86") return "x86";
  return "x64";
}

/** The newest LTS release in nodejs.org's `index.json` that ships an MSI for `arch`. */
export function pickNodeLtsMsi(index: unknown, arch: NodeMsiArch): NodeMsiRelease | null {
  if (!Array.isArray(index)) return null;
  for (const entry of index as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { version, lts, files } = entry as { version?: unknown; lts?: unknown; files?: unknown };
    if (typeof version !== "string" || !VERSION.test(version)) continue;
    if (!lts || !Array.isArray(files) || !files.includes(`win-${arch}-msi`)) continue;
    return { version, file: `node-${version}-${arch}.msi` };
  }
  return null;
}

/** The SHA-256 that `SHASUMS256.txt` lists for `file`, lower-case, or null. */
export function sha256FromShasums(text: string, file: string): string | null {
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/u.exec(line);
    if (match?.[1] && match[2] === file) return match[1].toLowerCase();
  }
  return null;
}

/** msiexec exit codes a person can act on. */
function msiexecOutcome(code: number | null): { outcome: NodeMsiOutcome; note: string } {
  if (code === 0 || code === 3010 || code === 1641) {
    return {
      outcome: { ok: true },
      note: code === 0 ? "Node.js 安装完成。" : "Node.js 安装完成（Windows 建议稍后重启）。",
    };
  }
  if (code === 1602) {
    return {
      outcome: { ok: false, reason: "PERMISSION" },
      note: "Node.js 安装被取消：安装需要在 Windows 弹出的管理员授权（UAC）窗口中点“是”。",
    };
  }
  if (code === 1625 || code === 1925 || code === 1730) {
    return {
      outcome: { ok: false, reason: "PERMISSION" },
      note: `Node.js 安装需要管理员权限（msiexec 退出码 ${code}）。请用管理员账号授权，或从 nodejs.org 手动安装。`,
    };
  }
  if (code === 1618) {
    return {
      outcome: { ok: false, reason: "INSTALL_FAILED" },
      note: "另一个程序正在安装（msiexec 退出码 1618），请等它结束后重试。",
    };
  }
  return {
    outcome: { ok: false, reason: "INSTALL_FAILED" },
    note:
      code === null
        ? "msiexec 没有正常结束（无法启动或超时）。"
        : `msiexec 安装失败，退出码 ${code}${code === 1603 ? "（常见原因：没有管理员权限或已有旧版本冲突）" : ""}。`,
  };
}

export async function installNodeFromMsi(options: NodeMsiOptions): Promise<NodeMsiOutcome> {
  const { runner, environment, files, log } = options;
  const download = async (url: string, file: string, timeoutMs: number): Promise<boolean> => {
    const result = await runner.run(
      options.powershell,
      powershellArguments(
        `$ErrorActionPreference='Stop';Invoke-WebRequest -UseBasicParsing -Uri ${powershellQuote(url)} -OutFile ${powershellQuote(file)}`,
      ),
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
      log(`[RLY/0 Hub] 从 ${source} 下载 Node.js LTS 安装包`);
      const indexFile = path.win32.join(directory, "index.json");
      if (!(await download(`${source}/index.json`, indexFile, SMALL_DOWNLOAD_MS))) continue;
      let release: NodeMsiRelease | null = null;
      try {
        release = pickNodeLtsMsi(JSON.parse(await text(indexFile)), options.arch);
      } catch {
        log(`${source}/index.json 不是有效的版本列表（可能被网络拦截）。`);
        continue;
      }
      if (!release) {
        log(`${source} 没有适用于 ${options.arch} 的 Node.js LTS 安装包。`);
        continue;
      }
      const base = `${source}/${release.version}`;
      const sumsFile = path.win32.join(directory, "SHASUMS256.txt");
      if (!(await download(`${base}/SHASUMS256.txt`, sumsFile, SMALL_DOWNLOAD_MS))) continue;
      const expected = sha256FromShasums(await text(sumsFile), release.file);
      if (!expected) {
        log(`SHASUMS256.txt 中没有 ${release.file} 的校验值。`);
        continue;
      }
      const msi = path.win32.join(directory, release.file);
      if (!(await download(`${base}/${release.file}`, msi, MSI_DOWNLOAD_MS))) continue;
      const actual = createHash("sha256")
        .update(await files.read(msi))
        .digest("hex");
      if (actual !== expected) {
        log(`${release.file} 校验失败（SHA256 不一致），已丢弃。`);
        reason = "INSTALL_FAILED";
        continue;
      }
      log(`[RLY/0 Hub] 安装 ${release.file}（SHA256 已校验）；Windows 会请求管理员授权。`);
      const installed = await runner.run(options.msiexec, ["/i", msi, "/passive", "/norestart"], {
        environment,
        shell: false,
        timeoutMs: MSI_INSTALL_MS,
      });
      if (installed.output.trim()) log(installed.output.trim());
      const { outcome, note } = msiexecOutcome(installed.code);
      log(note);
      return outcome;
    }
    return { ok: false, reason };
  } finally {
    await files.remove(directory).catch(() => undefined);
  }
}
