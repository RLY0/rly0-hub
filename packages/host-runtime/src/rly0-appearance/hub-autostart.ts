import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { Rly0HubPage } from "@codexhost/shared-contracts";

/** The standalone RLY/0 Hub window, installed next to the Launcher in `bin/`. */
export const RLY0_HUB_EXECUTABLE_NAME = "rly0-hub.exe";
/** Starts the Hub in the tray only, without opening its window. */
export const RLY0_HUB_BACKGROUND_ARGUMENT = "--background";

/**
 * Installation root of a packaged RLY/0 Hub: `<root>/runtime/node.exe` runs every bundled script,
 * so the root is two levels above Node.
 */
export function resolveRly0InstallRoot(executablePath: string = process.execPath): string {
  // The Launcher starts Node with an extended-length path (`\\?\C:\...`); other programs (cmd,
  // Explorer) do not accept that prefix, so the root is kept as a plain path.
  const plain = executablePath.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/u, "");
  return path.win32.dirname(path.win32.dirname(plain));
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
 * Starts the Hub window, on `page` when given. A Hub already running in the tray receives this
 * second start and brings its window up on that page instead (single instance), so this is also
 * "show the Hub".
 */
export function openRly0Hub(
  installRoot: string = resolveRly0InstallRoot(),
  fileExists: (file: string) => boolean = existsSync,
  start: (executable: string, args: readonly string[]) => void = startDetached,
  page?: Rly0HubPage,
): { available: boolean; ok: boolean } {
  const executable = path.win32.join(installRoot, "bin", RLY0_HUB_EXECUTABLE_NAME);
  if (!rly0HubStatus(installRoot, fileExists).available) return { available: false, ok: false };
  try {
    start(executable, page ? ["--page", page] : []);
    return { available: true, ok: true };
  } catch {
    return { available: true, ok: false };
  }
}

// Started through `cmd /c start` so the Hub is not part of Codex's process tree: a Codex restart
// or quit stops Codex's own helpers and must not take the tray app with it. (Explorer, used
// before, drops arguments such as `--page`.) The page is one of RLY0_HUB_PAGES and the path holds
// no quotes (checked by the caller's install layout), so the command line needs no escaping.
function startDetached(executable: string, args: readonly string[]): void {
  if (executable.includes('"')) throw new Error("Unexpected Hub path");
  const line = ['start "" "' + executable + '"', ...args].join(" ");
  const child = spawn("cmd.exe", ["/d", "/s", "/c", '"' + line + '"'], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.on("error", () => undefined);
  child.unref();
}
