import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Opens Codex Desktop the official way, as if RLY/0 Hub were not installed: no Launcher, no
 * remote-debugging port, no CODEX_CLI_PATH shim, so nothing is injected and Codex talks to its own
 * backend. Used while 恢复官方原样 is on.
 *
 * - macOS: LaunchServices by bundle id (`open -b com.openai.codex`), which also covers ChatGPT.app.
 * - Windows: the Store app through its AppUserModelID, `shell:AppsFolder\<AUMID>`. The AUMID is
 *   read from the Start menu's app list (`Get-StartApps`); when that cannot answer, the package
 *   family from the execution alias folder plus the usual `!App`.
 */
export const CODEX_MAC_BUNDLE_ID = "com.openai.codex";
const STORE_ALIAS_DIRECTORY = /^OpenAI\.Codex_[A-Za-z0-9]+$/u;

export interface CodexStockLaunchOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly readDirectory?: (directory: string) => Promise<string[]>;
  readonly run?: (executable: string, args: string[], environment: NodeJS.ProcessEnv) => void;
  /** macOS: runs `open` and resolves with its exit code (it fails when Codex is not installed). */
  readonly runChecked?: (
    executable: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
  ) => Promise<number>;
  /** Windows: the Codex AUMID from the Start menu's app list, or null. */
  readonly startAppsId?: () => Promise<string | null>;
}

/** Nothing of the Hub or the Launcher may reach the official Codex. */
export function officialEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !/^CODEXHOST_/u.test(name) &&
        !/^RLY0_/u.test(name) &&
        name !== "CODEX_CLI_PATH" &&
        name !== "ELECTRON_RUN_AS_NODE",
    ),
  );
}

function runDetached(executable: string, args: string[], environment: NodeJS.ProcessEnv): void {
  const child = spawn(executable, args, {
    env: environment,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.unref();
}

function runChecked(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve) => {
    execFile(executable, args, { env: environment, timeout: 60_000 }, (error) => {
      // A slow `open` was cut off, not refused: Codex may well be opening.
      if (error && (error as { killed?: boolean }).killed) return resolve(0);
      const code = (error as { code?: unknown } | null)?.code;
      resolve(error ? (typeof code === "number" ? code : 1) : 0);
    });
  });
}

const CODEX_AUMID = /^OpenAI\.Codex_[A-Za-z0-9]+![A-Za-z0-9._-]+$/u;

function startMenuCodexAppId(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*!*' } | Sort-Object { $_.AppID -notlike '*!App' } | Select-Object -First 1).AppID",
      ],
      { windowsHide: true, timeout: 20_000 },
      (error, stdout) => {
        const id = String(stdout).trim();
        resolve(!error && CODEX_AUMID.test(id) ? id : null);
      },
    );
  });
}

export async function windowsCodexAppId(
  environment: NodeJS.ProcessEnv,
  readDirectory: (directory: string) => Promise<string[]> = (directory) => fs.readdir(directory),
): Promise<string | null> {
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData || !path.win32.isAbsolute(localAppData)) return null;
  try {
    const names = await readDirectory(path.win32.join(localAppData, "Microsoft", "WindowsApps"));
    const family = names.filter((name) => STORE_ALIAS_DIRECTORY.test(name)).sort()[0];
    return family ? `${family}!App` : null;
  } catch {
    return null;
  }
}

/** Whether this platform can open Codex the official way at all (the app may still be missing). */
export function stockLaunchSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export async function launchStockCodex(options: CodexStockLaunchOptions): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runDetached;
  const environment = officialEnvironment(options.environment);
  if (platform === "darwin") {
    const code = await (options.runChecked ?? runChecked)(
      "/usr/bin/open",
      ["-b", CODEX_MAC_BUNDLE_ID],
      environment,
    );
    return code === 0;
  }
  if (platform === "win32") {
    const listed = await (options.startAppsId ?? startMenuCodexAppId)().catch(() => null);
    const appId = listed ?? (await windowsCodexAppId(options.environment, options.readDirectory));
    if (!appId) return false;
    const windowsRoot =
      options.environment.SystemRoot ?? options.environment.windir ?? "C:\\Windows";
    run(path.win32.join(windowsRoot, "explorer.exe"), [`shell:AppsFolder\\${appId}`], environment);
    return true;
  }
  return false;
}
