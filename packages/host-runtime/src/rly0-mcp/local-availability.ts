import { promises as fs, constants } from "node:fs";
import path from "node:path";

import { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";

/**
 * Whether a shared STDIO MCP command can start on this computer. A Codex `config.toml` copied
 * between computers keeps the other system's paths (`…\Scripts\python.exe`, `AppData\Roaming\npm`);
 * those are never handed to an Agent as-is. A Windows-shaped path is mapped to the usual local
 * equivalent when one exists; otherwise the server is reported unavailable with a reason.
 */
export type LocalCommandCheck =
  { available: true; command: string; mappedFrom?: string } | { available: false; reason: string };

const WINDOWS_EXTENSION = /\.(?:exe|cmd|bat|ps1|com)$/iu;
/** Interpreters whose bare name on PATH would run without the server's own environment. */
const GENERIC_INTERPRETERS = /^(?:python[0-9.]*|pythonw|node|py)$/iu;

export function windowsShapedCommand(command: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/u.test(command) ||
    command.includes("\\") ||
    WINDOWS_EXTENSION.test(command) ||
    /\/AppData\/(?:Roaming|Local)\//iu.test(command)
  );
}

interface Probe {
  file?: string;
  reason?: string;
}

async function probeFile(file: string, platform: NodeJS.Platform): Promise<Probe> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { reason: `找不到程序：${file}` };
  }
  if (!stat.isFile()) return { reason: `不是可执行文件：${file}` };
  if (platform === "win32") return { file };
  try {
    await fs.access(file, constants.X_OK);
  } catch {
    return { reason: `没有执行权限：${file}` };
  }
  // A PE image ("MZ") is a Windows program even with the executable bit set on a shared drive.
  try {
    const handle = await fs.open(file, "r");
    try {
      const head = Buffer.alloc(2);
      await handle.read(head, 0, 2, 0);
      if (head.toString("latin1") === "MZ")
        return { reason: `这是 Windows 程序，本机无法运行：${file}` };
    } finally {
      await handle.close();
    }
  } catch {
    /* Unreadable but executable: let the Agent try. */
  }
  return { file };
}

function pathDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  // Agents start MCP servers with the Host's Node.js runtime appended to PATH.
  const value = withNodeRuntimeOnPath(env, process.execPath, platform);
  const key = Object.keys(value).find((name) => name.toLowerCase() === "path") ?? "PATH";
  return (value[key] ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
}

async function probeOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<Probe> {
  const extensions =
    platform === "win32" && !path.extname(name)
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  for (const directory of pathDirectories(env, platform))
    for (const extension of extensions) {
      const probe = await probeFile(join(directory, `${name}${extension}`), platform);
      if (probe.file) return probe;
    }
  return { reason: `本机 PATH 里找不到命令：${name}` };
}

function probe(candidate: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const bare = platform === "win32" ? !/[\\/]/u.test(candidate) : !candidate.includes("/");
  return bare ? probeOnPath(candidate, env, platform) : probeFile(candidate, platform);
}

function npmGlobalModuleRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = new Set<string>();
  for (const prefix of [env.npm_config_prefix, env.NPM_CONFIG_PREFIX])
    if (prefix) roots.add(path.posix.join(prefix, "lib", "node_modules"));
  for (const directory of pathDirectories(env, "darwin"))
    if (path.posix.basename(directory) === "bin")
      roots.add(path.posix.join(path.posix.dirname(directory), "lib", "node_modules"));
  roots.add("/opt/homebrew/lib/node_modules");
  roots.add("/usr/local/lib/node_modules");
  return [...roots];
}

/** Local equivalents of a Windows-shaped command, most specific first. */
export function localCandidates(
  command: string,
  env: NodeJS.ProcessEnv,
  arch: string = process.arch,
): string[] {
  const home = env.HOME ?? "";
  let p = command.replaceAll("\\", "/");
  const drive = /^[A-Za-z]:\/Users\/[^/]+\/(.*)$/iu.exec(p);
  if (drive && home) p = path.posix.join(home, drive[1] ?? "");
  const stripped = p.replace(WINDOWS_EXTENSION, "");
  const result: string[] = [];
  const venv = /^(.*)\/Scripts\/(?:python[0-9.]*|pythonw)(?:\.exe)?$/iu.exec(p);
  if (venv?.[1]) {
    // A Windows virtual environment cannot run here; a local one beside it can.
    result.push(`${venv[1]}/bin/python3`, `${venv[1]}/bin/python`);
    return result;
  }
  const npmModule = /\/AppData\/Roaming\/npm\/node_modules\/(.+)$/iu.exec(stripped);
  if (npmModule?.[1]) {
    const relative = npmModule[1].replace(/win32-(?:x64|arm64|ia32)/giu, `darwin-${arch}`);
    for (const root of npmGlobalModuleRoots(env)) result.push(path.posix.join(root, relative));
  }
  const npmShim = /\/AppData\/Roaming\/npm\/([^/]+)$/iu.exec(stripped);
  if (!npmModule && !npmShim && /^\//u.test(stripped) && stripped !== p) result.push(stripped);
  const name = path.posix.basename(stripped);
  if (name && !GENERIC_INTERPRETERS.test(name)) result.push(name);
  return [...new Set(result)];
}

export async function checkLocalCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<LocalCommandCheck> {
  const trimmed = command.trim();
  if (!trimmed) return { available: false, reason: "没有填写启动命令" };
  try {
    if (platform === "win32" || !windowsShapedCommand(trimmed)) {
      const found = await probe(trimmed, env, platform);
      return found.file
        ? { available: true, command: trimmed }
        : { available: false, reason: found.reason ?? "命令不可用" };
    }
    for (const candidate of localCandidates(trimmed, env, arch)) {
      const found = await probe(candidate, env, platform);
      if (found.file)
        return {
          available: true,
          command: candidate.includes("/") ? candidate : found.file,
          mappedFrom: trimmed,
        };
    }
    return {
      available: false,
      reason: `这是 Windows 上的路径，本机没有找到对应的程序：${trimmed}`,
    };
  } catch {
    return { available: false, reason: "检查启动命令时出错" };
  }
}
