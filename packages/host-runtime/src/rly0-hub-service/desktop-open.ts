import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

/** Spawns a detached helper; failures are swallowed (opening is best effort, never fatal). */
type Spawn = (
  command: string,
  args: string[],
) => { on(event: "error", listener: () => void): unknown; unref(): void };

export interface DesktopOpenDependencies {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: Spawn;
}

function detached(
  spawn: Spawn | undefined,
  command: string,
  args: string[],
  fallback?: () => void,
): void {
  const run: Spawn = spawn ?? ((c, a) => nodeSpawn(c, a, { detached: true, stdio: "ignore" }));
  const child = run(command, args);
  child.on("error", () => fallback?.());
  child.unref();
}

/**
 * Opens a web page in the default browser. Windows uses url.dll's protocol handler (explorer.exe
 * mis-parses long sign-in URLs); macOS uses `open`, Linux `xdg-open`. Only http(s) URLs are opened
 * on macOS/Linux so a crafted value cannot launch a local file or another app's URL scheme.
 */
export function openInBrowser(url: string, dependencies: DesktopOpenDependencies = {}): void {
  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32") {
    const environment = dependencies.environment ?? process.env;
    const handler = path.win32.join(
      environment.SystemRoot ?? environment.windir ?? "C:\\Windows",
      "System32",
      "rundll32.exe",
    );
    detached(dependencies.spawn, handler, ["url.dll,FileProtocolHandler", url], () =>
      detached(dependencies.spawn, "explorer.exe", [url]),
    );
    return;
  }
  if (!/^https?:\/\//iu.test(url)) return;
  detached(dependencies.spawn, platform === "darwin" ? "/usr/bin/open" : "xdg-open", [url]);
}

/** Shows a folder: Explorer on Windows, Finder (`open`) on macOS, `xdg-open` elsewhere. */
export function revealFolder(directory: string, dependencies: DesktopOpenDependencies = {}): void {
  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32") {
    detached(dependencies.spawn, "explorer.exe", [directory]);
    return;
  }
  if (!path.isAbsolute(directory)) return;
  detached(dependencies.spawn, platform === "darwin" ? "/usr/bin/open" : "xdg-open", [directory]);
}
