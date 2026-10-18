import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  compareSemanticVersions,
  downloadArtifact,
  fetchLatestGitHubRelease,
  parseDistributionMetadata,
  verifyDownloadedArtifact,
  type ArtifactSource,
  type CodexhostLatestRelease,
} from "@codexhost/update-manager";
import { RLY0_GITHUB_RELEASE_DOWNLOAD_URL_PREFIX } from "@codexhost/shared-contracts";

/**
 * One-click update of the installed Hub: downloads the newer installer from the project's GitHub
 * Release, checks it against the SHA-256 GitHub publishes for the asset, then runs it silently.
 * The installer closes the Hub, replaces the files and opens the Hub again (and Codex, if it was
 * running and had to be closed for the update).
 */
export type Rly0HubUpdatePhase = "idle" | "downloading" | "verifying" | "installing" | "error";

export interface Rly0HubUpdateProgress {
  readonly phase: Rly0HubUpdatePhase;
  readonly version: string | null;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly error: string | null;
}

export interface Rly0HubUpdaterOptions {
  readonly installRoot: string;
  /** Per-user folder for the downloaded installer. */
  readonly downloadDir: string;
  readonly platform?: NodeJS.Platform;
  readonly fetchLatest?: typeof fetchLatestGitHubRelease;
  readonly download?: typeof downloadArtifact;
  readonly verify?: typeof verifyDownloadedArtifact;
  readonly launch?: (installer: string, args: readonly string[]) => void;
}

/** The installer asset name the release workflow publishes. */
export function hubInstallerAssetName(version: string): string {
  return `RLY0-Hub-${version}-setup.exe`;
}

const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/u;

/** The installer of `release`, with the SHA-256 GitHub recorded for it. */
export function selectHubInstaller(release: CodexhostLatestRelease): ArtifactSource {
  const name = hubInstallerAssetName(release.version);
  const matches = release.assets.filter((asset) => asset.name === name);
  const asset = matches.length === 1 ? matches[0] : undefined;
  if (!asset) throw new Error("UPDATE_ASSET_MISSING");
  const sha256 = asset.digest ? SHA256_DIGEST.exec(asset.digest)?.[1] : undefined;
  if (!sha256) throw new Error("UPDATE_ASSET_UNVERIFIED");
  const expected = `${RLY0_GITHUB_RELEASE_DOWNLOAD_URL_PREFIX}v${release.version}/${name}`;
  if (asset.downloadUrl !== expected) throw new Error("UPDATE_ASSET_MISSING");
  return { url: asset.downloadUrl, sha256, size: asset.size };
}

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
      const code = error instanceof Error && /^UPDATE_[A-Z_]+$/u.test(error.message);
      this.#set({
        phase: "error",
        error: code ? (error as Error).message : "UPDATE_DOWNLOAD_FAILED",
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
    const release = await (this.#options.fetchLatest ?? fetchLatestGitHubRelease)({
      signal: AbortSignal.timeout(20_000),
    });
    if (compareSemanticVersions(current, release.version) >= 0) throw new Error("UPDATE_NONE");
    const source = selectHubInstaller(release);
    this.#set({ version: release.version, totalBytes: source.size ?? 0 });

    await fs.mkdir(this.#options.downloadDir, { recursive: true });
    // Old downloads are of no use once a newer one starts.
    for (const entry of await fs.readdir(this.#options.downloadDir).catch(() => []))
      if (/^RLY0-Hub-.*-setup\.exe(\.part-\d+)?$/u.test(entry))
        await fs.rm(path.join(this.#options.downloadDir, entry), { force: true });
    const name = hubInstallerAssetName(release.version);
    const partial = path.join(this.#options.downloadDir, `${name}.part-${process.pid}`);
    const installer = path.join(this.#options.downloadDir, name);
    try {
      const result = await (this.#options.download ?? downloadArtifact)(
        source,
        partial,
        (progress) => {
          this.#set({ downloadedBytes: progress.downloadedBytes });
        },
      );
      this.#set({ phase: "verifying" });
      try {
        await (this.#options.verify ?? verifyDownloadedArtifact)(source, partial, result);
      } catch {
        throw new Error("UPDATE_VERIFY_FAILED");
      }
      await fs.rename(partial, installer);
    } finally {
      await fs.rm(partial, { force: true });
    }

    this.#set({ phase: "installing" });
    const args = ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/RELAUNCH=1"];
    if (reopenCodex) args.push("/REOPENCODEX=1");
    (this.#options.launch ?? launchDetached)(installer, args);
  }
}
