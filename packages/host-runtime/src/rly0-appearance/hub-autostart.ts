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
