import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  compareSemanticVersions,
  parseDistributionMetadata,
  verifyDownloadedArtifact,
  type ArtifactSource,
} from "@codexhost/update-manager";

import { hubInstallerAssetName, type Rly0HubRelease } from "./hub-release.js";
import { type ResumableDownloadProgress } from "./hub-update-net.js";

export { hubInstallerAssetName, selectHubInstaller } from "./hub-release.js";

/**
 * One-click update of the installed Hub: takes the release the last check found (asking GitHub
 * again only when that is old), downloads the installer — continuing a partial download — checks
 * it against the published SHA-256, then runs it silently. The installer closes the Hub, replaces
 * the files and opens the Hub again (and Codex, if it was running and had to be closed).
 */
export type Rly0HubUpdatePhase = "idle" | "downloading" | "verifying" | "installing" | "error";

export interface Rly0HubUpdateProgress {
  readonly phase: Rly0HubUpdatePhase;
  readonly version: string | null;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly error: string | null;
}

export type Rly0HubInstallerDownload = (
  source: ArtifactSource,
  partialPath: string,
  onProgress: (progress: ResumableDownloadProgress) => void,
) => Promise<{ bytes: number }>;

export interface Rly0HubUpdaterOptions {
  readonly installRoot: string;
  /** Per-user folder for the downloaded installer. */
  readonly downloadDir: string;
  readonly platform?: NodeJS.Platform;
  /** The newest release (normally reused from the last check). */
  readonly release: () => Promise<Rly0HubRelease>;
  /** Downloads into `partialPath`, continuing what is already there. */
  readonly download: Rly0HubInstallerDownload;
  readonly verify?: typeof verifyDownloadedArtifact;
  readonly launch?: (installer: string, args: readonly string[]) => void;
}

/** The partial download keeps one name per version, so a retry continues it. */
export function hubPartialDownloadName(version: string): string {
  return `${hubInstallerAssetName(version)}.partial`;
}

const UPDATE_CODE = /^UPDATE_[A-Z_]+$/u;

function launchDetached(installer: string, args: readonly string[]): void {
  // The Hub's job lets children break away, so the installer outlives the Hub it closes.
  const child = spawn(installer, [...args], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export class Rly0HubUpdater {
  readonly #options: Rly0HubUpdaterOptions;
  #progress: Rly0HubUpdateProgress = {
    phase: "idle",
    version: null,
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
  };

  constructor(options: Rly0HubUpdaterOptions) {
    this.#options = options;
  }

  progress(): Rly0HubUpdateProgress {
    return this.#progress;
  }

  #set(next: Partial<Rly0HubUpdateProgress>): void {
    this.#progress = { ...this.#progress, ...next };
  }

  /**
   * Starts downloading and installing the latest version; returns at once and reports through
   * `progress()`. `reopenCodex` asks the installer to open Codex again when it is done.
   */
  start(options: { reopenCodex: boolean }): Rly0HubUpdateProgress {
    if (this.#progress.phase === "downloading" || this.#progress.phase === "verifying")
      return this.#progress;
    if (this.#progress.phase === "installing") return this.#progress;
    if ((this.#options.platform ?? process.platform) !== "win32") {
      this.#set({ phase: "error", error: "UPDATE_UNSUPPORTED" });
      return this.#progress;
    }
    this.#set({ phase: "downloading", downloadedBytes: 0, totalBytes: 0, error: null });
    void this.#run(options.reopenCodex).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      // A failed lookup reports its own cause; anything unexplained is a download problem.
      this.#set({
        phase: "error",
        error: UPDATE_CODE.test(message) ? message : "UPDATE_DOWNLOAD_FAILED",
      });
    });
    return this.#progress;
  }

  async #run(reopenCodex: boolean): Promise<void> {
    const current = parseDistributionMetadata(
      JSON.parse(
        await fs.readFile(
          path.join(this.#options.installRoot, "app", "codexhost-distribution.json"),
          "utf8",
        ),
      ),
    ).version;
    const release = await this.#options.release();
    if (compareSemanticVersions(current, release.version) >= 0) throw new Error("UPDATE_NONE");
    const source = release.installer;
    if (!source) throw new Error(release.installerProblem ?? "UPDATE_ASSET_MISSING");
    this.#set({ version: release.version, totalBytes: source.size ?? 0 });

    const dir = this.#options.downloadDir;
    await fs.mkdir(dir, { recursive: true });
    const name = hubInstallerAssetName(release.version);
    const partialName = hubPartialDownloadName(release.version);
    // Other versions' files are of no use; this version's partial download is kept to continue.
    for (const entry of await fs.readdir(dir).catch(() => []))
      if (/^RLY0-Hub-.*-setup\.exe(\.part-\d+|\.partial)?$/u.test(entry) && entry !== partialName)
        await fs.rm(path.join(dir, entry), { force: true });
    const partial = path.join(dir, partialName);
    const installer = path.join(dir, name);

    const result = await this.#options.download(source, partial, (progress) => {
      this.#set({ downloadedBytes: progress.downloadedBytes });
    });
    this.#set({ phase: "verifying" });
    try {
      await (this.#options.verify ?? verifyDownloadedArtifact)(source, partial, {
        bytes: result.bytes,
        finalUrl: source.url,
      });
    } catch {
      // Never install it, and do not continue a corrupt file next time.
      await fs.rm(partial, { force: true });
      throw new Error("UPDATE_VERIFY_FAILED");
    }
    await fs.rename(partial, installer);

    this.#set({ phase: "installing" });
    const args = ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/RELAUNCH=1"];
    if (reopenCodex) args.push("/REOPENCODEX=1");
    (this.#options.launch ?? launchDetached)(installer, args);
  }
}
