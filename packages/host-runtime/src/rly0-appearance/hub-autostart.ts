import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** The standalone RLY/0 Hub window, installed next to the Launcher in `bin/`. */
export const RLY0_HUB_EXECUTABLE_NAME = "rly0-hub.exe";
/** Starts the Hub in the tray only, without opening its window. */
export const RLY0_HUB_BACKGROUND_ARGUMENT = "--background";

/**
 * Installation root of a packaged RLY/0 Hub: `<root>/runtime/node.exe` runs every bundled script,
 * so the root is two levels above Node.
 */
export function resolveRly0InstallRoot(executablePath: string = process.execPath): string {
  return path.win32.dirname(path.win32.dirname(executablePath));
}

/**
 * What "开机自启" registers: the standalone Hub in the tray. Returns `undefined` when this build has
 * no Hub executable (a source checkout), so the toggle reports unsupported instead of registering
 * a bare script that would start without its window.
 */
export function resolveRly0HubAutostartCommand(
  installRoot: string = resolveRly0InstallRoot(),
  fileExists: (file: string) => boolean = existsSync,
): string | undefined {
  const executable = path.win32.join(installRoot, "bin", RLY0_HUB_EXECUTABLE_NAME);
  if (!fileExists(executable) || executable.includes('"')) return undefined;
  return `"${executable}" ${RLY0_HUB_BACKGROUND_ARGUMENT}`;
}

/** No launch side effects: packaged builds route settings to this window. */
export function rly0HubStatus(
  installRoot: string = resolveRly0InstallRoot(),
  fileExists: (file: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): { available: boolean } {
  return {
    available:
      platform === "win32" &&
      fileExists(path.win32.join(installRoot, "bin", RLY0_HUB_EXECUTABLE_NAME)),
  };
}

/**
 * Starts the Hub window. A Hub already running in the tray receives this second start and brings
 * its window up instead (single instance), so this is also "show the Hub".
 */
export function openRly0Hub(
  installRoot: string = resolveRly0InstallRoot(),
  fileExists: (file: string) => boolean = existsSync,
  start: (executable: string) => void = startDetached,
): { available: boolean; ok: boolean } {
  const executable = path.win32.join(installRoot, "bin", RLY0_HUB_EXECUTABLE_NAME);
  if (!rly0HubStatus(installRoot, fileExists).available) return { available: false, ok: false };
  try {
    start(executable);
    return { available: true, ok: true };
  } catch {
    return { available: true, ok: false };
  }
}

// Started through Explorer so the Hub is not part of Codex's process tree: a Codex restart or
// quit stops Codex's own helpers and must not take the tray app with it.
function startDetached(executable: string): void {
  const child = spawn("explorer.exe", [executable], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
