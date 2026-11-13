import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  compareSemanticVersions,
  verifyDownloadedArtifact,
  type ArtifactSource,
} from "@codexhost/update-manager";

import {
  hubInstallerAssetName,
  hubPackageKind,
  type HubPackageKind,
  type Rly0HubRelease,
} from "./hub-release.js";
import { type ResumableDownloadProgress } from "./hub-update-net.js";
import { installedHubVersion } from "./update-check.js";

export { hubInstallerAssetName, selectHubInstaller } from "./hub-release.js";

/**
 * Update of the installed Hub: takes the release the last check found (asking GitHub again only
 * when that is old), downloads the package — continuing a partial download — and checks it against
 * the published SHA-256.
 * - Windows: runs the installer silently; it closes the Hub, replaces the files and opens the Hub
 *   again (and Codex, if it was running and had to be closed).
 * - macOS: stops at `downloaded`. The disk image is not opened, mounted or changed; the person
 *   opens it (or its folder) from the window and replaces the app themselves, wherever it lives.
 *   Without a Developer ID the Hub never replaces its own bundle or touches quarantine.
 */
export type Rly0HubUpdatePhase =
  "idle" | "downloading" | "verifying" | "installing" | "downloaded" | "error";

export interface Rly0HubUpdateProgress {
  readonly phase: Rly0HubUpdatePhase;
  readonly version: string | null;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly error: string | null;
  /** macOS: the verified disk image, once `downloaded`. */
  readonly file: string | null;
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
  /** macOS: shows the downloaded disk image (`open`) or selects it in Finder (`open -R`). */
  readonly open?: (args: readonly string[]) => Promise<boolean>;
  /** Overrides the package derived from `platform` (tests). */
  readonly kind?: HubPackageKind | null;
}

/** The partial download keeps one name per version, so a retry continues it. */
export function hubPartialDownloadName(version: string, kind: HubPackageKind = "windows"): string {
  return `${hubInstallerAssetName(version, kind)}.partial`;
}

/** Files of either package, finished or partial; other versions' ones are of no use. */
const PACKAGE_FILE = /^RLY0-Hub-.*-(setup\.exe|macos-arm64\.dmg)(\.part-\d+|\.partial)?$/u;

const UPDATE_CODE = /^UPDATE_[A-Z_]+$/u;

/** `open` hands the file to Finder and exits at once; its exit status says whether that worked. */
function openWithFinder(args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/open", [...args], { timeout: 15_000 }, (error) => resolve(!error));
  });
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
    file: null,
  };

  constructor(options: Rly0HubUpdaterOptions) {
    this.#options = options;
  }

  #kind(): HubPackageKind | null {
    if (this.#options.kind !== undefined) return this.#options.kind;
    return hubPackageKind(this.#options.platform ?? process.platform);
  }

  progress(): Rly0HubUpdateProgress {
    return this.#progress;
  }

  #set(next: Partial<Rly0HubUpdateProgress>): void {
    this.#progress = { ...this.#progress, ...next };
  }

  /**
   * Starts downloading (and on Windows installing) the latest version; returns at once and reports
   * through `progress()`. `reopenCodex` asks the Windows installer to open Codex again when done.
   */
  start(options: { reopenCodex: boolean }): Rly0HubUpdateProgress {
    if (this.#progress.phase === "downloading" || this.#progress.phase === "verifying")
      return this.#progress;
    if (this.#progress.phase === "installing") return this.#progress;
    const kind = this.#kind();
    if (!kind) {
      this.#set({ phase: "error", error: "UPDATE_UNSUPPORTED" });
      return this.#progress;
    }
    this.#set({ phase: "downloading", downloadedBytes: 0, totalBytes: 0, error: null, file: null });
    void this.#run(kind, options.reopenCodex).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      // A failed lookup reports its own cause; anything unexplained is a download problem.
      this.#set({
        phase: "error",
        error: UPDATE_CODE.test(message) ? message : "UPDATE_DOWNLOAD_FAILED",
      });
    });
    return this.#progress;
  }

  /**
   * macOS: shows the verified disk image (Finder mounts it and opens its window) or, with
   * `folder`, selects it in its folder. Nothing is mounted, copied or replaced by the Hub itself.
   */
  async reveal(folder: boolean): Promise<{ ok: boolean; missing?: true }> {
    const file = this.#progress.file;
    if (this.#kind() !== "macos" || this.#progress.phase !== "downloaded" || !file)
      return { ok: false, missing: true };
    if (
      !(await fs.stat(file).then(
        (stat) => stat.isFile(),
        () => false,
      ))
    ) {
      this.#set({ phase: "idle", file: null });
      return { ok: false, missing: true };
    }
    const opened = await (this.#options.open ?? openWithFinder)(
      folder ? ["-R", file] : [file],
    ).catch(() => false);
    return { ok: opened };
  }

  /**
   * macOS, once the check finds no newer version (the app was replaced): drops the disk images and
   * partial downloads kept for updating. Nothing is touched while a download is running.
   */
  async discardDownloads(): Promise<void> {
    if (this.#kind() !== "macos") return;
    const phase = this.#progress.phase;
    if (phase === "downloading" || phase === "verifying") return;
    await this.#clean(null);
    // A download started meanwhile keeps its own state.
    if (this.#progress.phase === "downloaded") this.#set({ phase: "idle", file: null });
  }

  /** Removes package files from the download folder, except `keep`. */
  async #clean(keep: string | null): Promise<void> {
    const dir = this.#options.downloadDir;
    for (const entry of await fs.readdir(dir).catch(() => []))
      if (PACKAGE_FILE.test(entry) && entry !== keep)
        await fs.rm(path.join(dir, entry), { force: true });
  }

  async #run(kind: HubPackageKind, reopenCodex: boolean): Promise<void> {
    const current = await installedHubVersion(this.#options.installRoot);
    const release = await this.#options.release();
    if (compareSemanticVersions(current, release.version) >= 0) {
      if (kind === "macos") await this.#clean(null);
      throw new Error("UPDATE_NONE");
    }
    const source = release.installer;
    if (!source) throw new Error(release.installerProblem ?? "UPDATE_ASSET_MISSING");
    this.#set({ version: release.version, totalBytes: source.size ?? 0 });

    const dir = this.#options.downloadDir;
    await fs.mkdir(dir, { recursive: true });
    const name = hubInstallerAssetName(release.version, kind);
    const partialName = hubPartialDownloadName(release.version, kind);
    const installer = path.join(dir, name);
    // A disk image already downloaded and still intact is offered again, not fetched again.
    if (kind === "macos" && (await this.#intact(source, installer))) {
      await this.#clean(name);
      this.#set({ phase: "downloaded", file: installer, downloadedBytes: source.size ?? 0 });
      return;
    }
    // Other versions' files are of no use; this version's partial download is kept to continue.
    await this.#clean(partialName);
    const partial = path.join(dir, partialName);

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
    if (kind === "macos") {
      this.#set({ phase: "downloaded", file: installer });
      return;
    }

    this.#set({ phase: "installing" });
    const args = ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/RELAUNCH=1"];
    if (reopenCodex) args.push("/REOPENCODEX=1");
    (this.#options.launch ?? launchDetached)(installer, args);
  }

  async #intact(source: ArtifactSource, file: string): Promise<boolean> {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return false;
    try {
      await (this.#options.verify ?? verifyDownloadedArtifact)(source, file, {
        bytes: stat.size,
        finalUrl: source.url,
      });
      return true;
    } catch {
      return false;
    }
  }
}
