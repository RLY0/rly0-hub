import { promises as fs } from "node:fs";
import path from "node:path";

import { compareSemanticVersions, parseDistributionMetadata } from "@codexhost/update-manager";
import type { UpdateCheckResult } from "@codexhost/shared-contracts";

import { Rly0HubReleaseSource, type Rly0HubRelease } from "./hub-release.js";
import {
  createUpdateHttpGet,
  readWindowsSystemProxy,
  resolveUpdateProxy,
} from "./hub-update-net.js";

type LatestRelease = Pick<Rly0HubRelease, "version" | "releaseNotes" | "releaseNotesUrl">;

let fallbackSource: Rly0HubReleaseSource | null = null;

/** Used when no source is passed: HTTPS_PROXY or the Windows system proxy, nothing Hub-specific. */
function defaultLatest(): Promise<LatestRelease> {
  fallbackSource ??= new Rly0HubReleaseSource({
    get: async () =>
      createUpdateHttpGet({
        proxy: await resolveUpdateProxy({
          settings: { mode: "system" },
          environment: process.env,
          systemProxy: () => readWindowsSystemProxy(),
        }),
        timeoutMs: 15_000,
      }),
  });
  return fallbackSource.latest({ maxAgeMs: 0 });
}

/**
 * The distribution metadata, or on macOS the app bundle's version (`Contents/Resources` is the
 * install root): a Hub.app assembled without the codexhost payload's metadata still knows its version.
 */
async function installedVersion(installRoot: string): Promise<string> {
  try {
    const file = path.join(installRoot, "app", "codexhost-distribution.json");
    return parseDistributionMetadata(JSON.parse(await fs.readFile(file, "utf8"))).version;
  } catch (error) {
    const plist = await fs.readFile(path.join(installRoot, "..", "Info.plist"), "utf8").catch(() => null);
    const version = plist?.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+\.\d+\.\d+)<\/string>/u,
    )?.[1];
    if (version) return version;
    throw error;
  }
}

/**
 * Read-only update discovery without Launcher PID, controller or a running app-server. `error` is
 * UPDATE_RATE_LIMITED, UPDATE_NETWORK or UPDATE_CHECK_FAILED.
 */
export async function checkHubUpdate(
  installRoot: string,
  fetchLatest: () => Promise<LatestRelease> = defaultLatest,
): Promise<UpdateCheckResult> {
  let currentVersion = "0.0.0";
  try {
    currentVersion = await installedVersion(installRoot);
    const release = await fetchLatest();
    return {
      currentVersion,
      latestVersion: release.version,
      updateAvailable: compareSemanticVersions(currentVersion, release.version) < 0,
      installation: null,
      installationAvailable: false,
      status: null,
      releaseNotes: release.releaseNotes,
      releaseNotesUrl: release.releaseNotesUrl,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      installation: null,
      installationAvailable: false,
      status: null,
      releaseNotes: null,
      releaseNotesUrl: null,
      error:
        message === "UPDATE_RATE_LIMITED" || message === "UPDATE_NETWORK"
          ? message
          : "UPDATE_CHECK_FAILED",
    };
  }
}
