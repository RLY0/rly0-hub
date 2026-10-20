import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

import { withClaudeCodeInstallPaths } from "./claude-code-auth.js";

/** Common installer destinations, re-evaluated after every prerequisite install. */
export function withAgentInstallPaths(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const next = withClaudeCodeInstallPaths(environment, platform);
  if (platform !== "win32") return next;
  const extra = [
    path.win32.join(environment.ProgramFiles ?? "C:\\Program Files", "nodejs"),
    path.win32.join(environment.ProgramFiles ?? "C:\\Program Files", "Git", "cmd"),
    environment["ProgramFiles(x86)"]
      ? path.win32.join(environment["ProgramFiles(x86)"], "nodejs")
      : "",
    environment.LOCALAPPDATA ? path.win32.join(environment.LOCALAPPDATA, "Programs", "nodejs") : "",
    environment.LOCALAPPDATA
      ? path.win32.join(environment.LOCALAPPDATA, "Microsoft", "WindowsApps")
      : "",
    environment.NVM_SYMLINK ?? "",
    // The official Antigravity CLI installer (antigravity.google/cli/install.ps1) puts agy.exe
    // here and adds it to the user PATH, which processes started earlier do not see.
    environment.LOCALAPPDATA ? path.win32.join(environment.LOCALAPPDATA, "agy", "bin") : "",
  ];
  next.PATH = [next.PATH, ...extra].filter(Boolean).join(";");
  return next;
}

/**
 * `existsSync` reports Windows app execution aliases (`WindowsApps\winget.exe`) as missing: `stat`
 * on them fails with EACCES. `lstat` still sees them, and they start normally.
 */
export function fileOrAliasExists(file: string): boolean {
  if (existsSync(file)) return true;
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Full path of `command` found through PATH (and PATHEXT on Windows), or null. */
export function findCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fileExists: (file: string) => boolean = fileOrAliasExists,
): string | null {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const extensions =
    platform === "win32"
      ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const directories = (environment.PATH ?? environment.Path ?? "")
    .split(pathApi.delimiter)
    .filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, command + extension.toLowerCase());
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * An executable under `%SystemRoot%\System32`, by full path when it exists. A service started
 * without a console may have a PATH that does not reach System32 tools reliably.
 */
export function windowsSystemTool(
  environment: NodeJS.ProcessEnv,
  relative: string,
  fileExists: (file: string) => boolean = fileOrAliasExists,
): string {
  const root = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.windir;
  if (root) {
    const full = path.win32.join(root, "System32", relative);
    if (fileExists(full)) return full;
  }
  return path.win32.basename(relative);
}

/**
 * Prepended to every PowerShell script the installer runs (Windows PowerShell 5.1):
 * - UTF-8 output, so localized (GBK) error text survives and can be classified;
 * - TLS 1.2, which older .NET defaults do not offer and most download hosts require;
 * - no progress rendering (it slows `Invoke-WebRequest` badly);
 * - the Hub's custom proxy for `irm`/`iwr`, which ignore `HTTPS_PROXY` on their own.
 * Only single quotes are used so the script survives command-line quoting unchanged.
 */
export const POWERSHELL_PRELUDE = [
  "$ProgressPreference='SilentlyContinue'",
  "try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{}",
  "try{[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12}catch{}",
  "if($env:HTTPS_PROXY){try{[Net.WebRequest]::DefaultWebProxy=New-Object Net.WebProxy($env:HTTPS_PROXY,$true)}catch{}}",
].join(";");

/** Arguments for `powershell.exe` running `script` non-interactively, after the prelude. */
export function powershellArguments(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `${POWERSHELL_PRELUDE};${script}`,
  ];
}

/** A PowerShell single-quoted string literal. */
export function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
