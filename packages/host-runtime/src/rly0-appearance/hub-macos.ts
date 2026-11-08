import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { posix as path } from "node:path";

import type { Rly0HubPage } from "@codexhost/shared-contracts";

/**
 * The RLY/0 Hub window on macOS: `RLY0 Hub.app` (bundle id below) wherever the user keeps it. Codex
 * opens it the way Windows starts `rly0-hub.exe --page`: a running Hub is brought to the front and
 * told the page through the distributed notification it listens to; otherwise the app is launched
 * with `--page`.
 */
export const RLY0_HUB_MAC_BUNDLE_ID = "com.rly0.hub.macos";
const NAVIGATE_NOTIFICATION = "com.rly0.hub.navigate";
const EXECUTABLE_SUFFIX = ".app/Contents/MacOS/rly0-hub";
const CACHE_MS = 30_000;

export interface MacHubSystem {
  /** Command lines of running processes (`ps -axo command`). */
  processes(): string[];
  /** App bundles LaunchServices/Spotlight knows under the bundle id. */
  registered(): string[];
  exists(file: string): boolean;
  home(): string;
  run(file: string, args: readonly string[]): Promise<void>;
  wait(ms: number): Promise<void>;
}

const quiet = {
  encoding: "utf8" as const,
  timeout: 3000,
  stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
};

export const realMacHubSystem: MacHubSystem = {
  processes: () => execFileSync("/bin/ps", ["-axo", "command"], quiet).split("\n"),
  registered: () =>
    execFileSync(
      "/usr/bin/mdfind",
      [`kMDItemCFBundleIdentifier == '${RLY0_HUB_MAC_BUNDLE_ID}'`],
      quiet,
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  exists: existsSync,
  home: os.homedir,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  run: (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, [...args], { timeout: 10_000 }, (error) =>
        error ? reject(error) : resolve(),
      );
    }),
};

/** The bundle of a Hub that is running now, if any. */
function runningBundle(system: MacHubSystem): string | undefined {
  for (const line of system.processes()) {
    const at = line.indexOf(EXECUTABLE_SUFFIX);
    if (at > 0 && line.startsWith("/")) return line.slice(0, at + ".app".length);
  }
  return undefined;
}

/** A running Hub first, then the usual install folders, then any other copy the system knows. */
export function findMacHub(system: MacHubSystem = realMacHubSystem): {
  bundle: string;
  running: boolean;
} | null {
  try {
    const running = runningBundle(system);
    if (running) return { bundle: running, running: true };
  } catch {
    // ps failed: look for an installed copy instead.
  }
  const usual = ["/Applications", path.join(system.home(), "Applications")].map((folder) =>
    path.join(folder, "RLY0 Hub.app"),
  );
  let known: string[] = [];
  try {
    known = system
      .registered()
      .filter((file) => file.endsWith(".app") && !file.includes("/.Trash/"));
  } catch {
    known = [];
  }
  const bundle = [...usual, ...known].find((file) => system.exists(file));
  return bundle ? { bundle, running: false } : null;
}

let cache: { at: number; available: boolean } | null = null;

/** Whether the icon in Codex can open the Hub window; checked at most every 30 s. */
export function macHubAvailable(
  system: MacHubSystem = realMacHubSystem,
  now = Date.now(),
): boolean {
  if (system === realMacHubSystem && cache && now - cache.at < CACHE_MS) return cache.available;
  const available = findMacHub(system) !== null;
  if (system === realMacHubSystem) cache = { at: now, available };
  return available;
}

// JXA: posts the page to a running Hub (Rly0Hub.swift observes this name).
function navigateScript(page: Rly0HubPage): string {
  return (
    "ObjC.import('Foundation');" +
    "$.NSDistributedNotificationCenter.defaultCenter" +
    `.postNotificationNameObjectUserInfoDeliverImmediately('${NAVIGATE_NOTIFICATION}', '${page}', $(), true);`
  );
}

/** Brings the Hub window up, on `page` when given. */
export async function openMacHub(
  page: Rly0HubPage | undefined,
  system: MacHubSystem = realMacHubSystem,
): Promise<{ available: boolean; ok: boolean }> {
  const hub = findMacHub(system);
  if (!hub) return { available: false, ok: false };
  try {
    await system.run("/usr/bin/open", [
      "-a",
      hub.bundle,
      ...(page ? ["--args", "--page", page] : []),
    ]);
    // `--args` only reaches a Hub that is starting now; a running one gets the page this way,
    // after it has handled the reopen that `open` sent (which shows the window as it was).
    if (page && hub.running) {
      await system.wait(400);
      await system.run("/usr/bin/osascript", ["-l", "JavaScript", "-e", navigateScript(page)]);
    }
    return { available: true, ok: true };
  } catch {
    return { available: true, ok: false };
  }
}
