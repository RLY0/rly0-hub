import { promises as fs } from "node:fs";
import path from "node:path";

import {
  compareSemanticVersions,
  fetchLatestGitHubRelease,
  parseDistributionMetadata,
} from "@codexhost/update-manager";
import type { UpdateCheckResult } from "@codexhost/shared-contracts";

/** Read-only update discovery without Launcher PID, controller or a running app-server. */
export async function checkHubUpdate(
  installRoot: string,
  fetchLatest = fetchLatestGitHubRelease,
): Promise<UpdateCheckResult> {
  let currentVersion = "0.0.0";
  try {
    const file = path.join(installRoot, "app", "codexhost-distribution.json");
    currentVersion = parseDistributionMetadata(JSON.parse(await fs.readFile(file, "utf8"))).version;
    const release = await fetchLatest({ signal: AbortSignal.timeout(15_000) });
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
  } catch {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      installation: null,
      installationAvailable: false,
      status: null,
      releaseNotes: null,
      releaseNotesUrl: null,
      error: "UPDATE_CHECK_FAILED",
    };
  }
}
