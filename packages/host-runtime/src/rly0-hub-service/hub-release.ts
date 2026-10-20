import {
  RLY0_GITHUB_API_LATEST_RELEASE_URL,
  RLY0_GITHUB_RELEASE_DOWNLOAD_URL_PREFIX,
  RLY0_GITHUB_RELEASE_TAG_URL_PREFIX,
  RLY0_GITHUB_RELEASES_LATEST_URL,
  UPDATE_SEMVER_PATTERN,
} from "@codexhost/shared-contracts";
import {
  parseLatestGitHubRelease,
  type ArtifactSource,
  type CodexhostLatestRelease,
} from "@codexhost/update-manager";

import { getUpdateJson, HubUpdateHttpError, type UpdateHttpGet } from "./hub-update-net.js";

/**
 * Where the Hub learns about its newest release. First `latest.json`, a small manifest the
 * release uploads next to the installer and that github.com serves from its download CDN (no API
 * quota); when that is missing or unusable, the GitHub API (60 unauthenticated calls an hour per
 * address). The last answer is kept, so "立即更新" right after a check does not ask again.
 */

export const HUB_RELEASE_MANIFEST_NAME = "latest.json";
export const HUB_RELEASE_MANIFEST_URL = `${RLY0_GITHUB_RELEASES_LATEST_URL}/download/${HUB_RELEASE_MANIFEST_NAME}`;
/** How long a found release is reused before asking GitHub again. */
export const HUB_RELEASE_REUSE_MS = 60 * 60_000;

const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/u;

/** The installer asset name the release publishes. */
export function hubInstallerAssetName(version: string): string {
  return `RLY0-Hub-${version}-setup.exe`;
}

function installerUrl(version: string): string {
  return `${RLY0_GITHUB_RELEASE_DOWNLOAD_URL_PREFIX}v${version}/${hubInstallerAssetName(version)}`;
}

export interface Rly0HubRelease {
  readonly version: string;
  readonly releaseNotes: string | null;
  readonly releaseNotesUrl: string;
  /** Null when the release cannot be installed safely; `installerProblem` says why. */
  readonly installer: ArtifactSource | null;
  readonly installerProblem: "UPDATE_ASSET_MISSING" | "UPDATE_ASSET_UNVERIFIED" | null;
  readonly via: "manifest" | "api";
}

/** `latest.json`, exactly as `scripts/release/hub-latest-manifest.mjs` writes it. */
export interface Rly0HubReleaseManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly publishedAt: string;
  readonly notes?: string;
}

const MANIFEST_KEYS = new Set([
  "schemaVersion",
  "version",
  "name",
  "size",
  "sha256",
  "publishedAt",
  "notes",
]);

/** Strict: unknown keys, a name that is not this version's installer, or a bad digest all fail. */
export function parseHubReleaseManifest(value: unknown): Rly0HubRelease {
  const fail = (why: string): never => {
    throw new Error(`release manifest is invalid: ${why}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("not an object");
  const manifest = value as Record<string, unknown>;
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.has(key)) fail(`unknown ${key}`);
  if (manifest.schemaVersion !== 1) fail("schemaVersion");
  const version = manifest.version;
  if (typeof version !== "string" || version.length > 64 || !UPDATE_SEMVER_PATTERN.test(version))
    fail("version");
  const release = version as string;
  if (manifest.name !== hubInstallerAssetName(release)) fail("name");
  const size = manifest.size;
  if (
    !Number.isSafeInteger(size) ||
    (size as number) <= 0 ||
    (size as number) > MAX_INSTALLER_BYTES
  )
    fail("size");
  if (typeof manifest.sha256 !== "string" || !SHA256_HEX.test(manifest.sha256)) fail("sha256");
  const published = manifest.publishedAt;
  if (typeof published !== "string" || published.length > 40 || Number.isNaN(Date.parse(published)))
    fail("publishedAt");
  const notes = manifest.notes;
  if (notes !== undefined && (typeof notes !== "string" || notes.length > 20_000)) fail("notes");
  return Object.freeze({
    version: release,
    releaseNotes: typeof notes === "string" && notes.trim() ? notes : null,
    releaseNotesUrl: `${RLY0_GITHUB_RELEASE_TAG_URL_PREFIX}v${release}`,
    installer: Object.freeze({
      url: installerUrl(release),
      sha256: manifest.sha256 as string,
      size: size as number,
    }),
    installerProblem: null,
    via: "manifest" as const,
  });
}

/** The installer of an API release, with the SHA-256 GitHub recorded for it. */
export function selectHubInstaller(release: CodexhostLatestRelease): ArtifactSource {
  const name = hubInstallerAssetName(release.version);
  const matches = release.assets.filter((asset) => asset.name === name);
  const asset = matches.length === 1 ? matches[0] : undefined;
  if (!asset) throw new Error("UPDATE_ASSET_MISSING");
  const sha256 = asset.digest ? SHA256_DIGEST.exec(asset.digest)?.[1] : undefined;
  if (!sha256) throw new Error("UPDATE_ASSET_UNVERIFIED");
  if (asset.downloadUrl !== installerUrl(release.version)) throw new Error("UPDATE_ASSET_MISSING");
  return { url: asset.downloadUrl, sha256, size: asset.size };
}

export function hubReleaseFromApi(release: CodexhostLatestRelease): Rly0HubRelease {
  let installer: ArtifactSource | null = null;
  let installerProblem: Rly0HubRelease["installerProblem"] = null;
  try {
    installer = selectHubInstaller(release);
  } catch (error) {
    installerProblem =
      error instanceof Error && error.message === "UPDATE_ASSET_UNVERIFIED"
        ? "UPDATE_ASSET_UNVERIFIED"
        : "UPDATE_ASSET_MISSING";
  }
  return Object.freeze({
    version: release.version,
    releaseNotes: release.releaseNotes,
    releaseNotesUrl: release.releaseNotesUrl,
    installer,
    installerProblem,
    via: "api" as const,
  });
}

/** What a failed lookup means for the person reading the window. */
export function hubReleaseErrorCode(
  error: unknown,
): "UPDATE_RATE_LIMITED" | "UPDATE_NETWORK" | "UPDATE_CHECK_FAILED" {
  if (error instanceof HubUpdateHttpError) {
    // GitHub answers an exhausted quota with 403 (sometimes 429) and x-ratelimit-remaining: 0.
    if (
      error.status === 429 ||
      error.status === 403 ||
      error.headers["x-ratelimit-remaining"] === "0"
    )
      return "UPDATE_RATE_LIMITED";
    return "UPDATE_CHECK_FAILED";
  }
  if (error instanceof Error && error.message === "UPDATE_NETWORK") return "UPDATE_NETWORK";
  return "UPDATE_CHECK_FAILED";
}

export interface Rly0HubReleaseSourceOptions {
  /** A GET with the proxy in force right now. */
  readonly get: () => Promise<UpdateHttpGet>;
  readonly now?: () => number;
}

export class Rly0HubReleaseSource {
  readonly #options: Rly0HubReleaseSourceOptions;
  #cached: { at: number; release: Rly0HubRelease } | null = null;
  #running: Promise<Rly0HubRelease> | null = null;

  constructor(options: Rly0HubReleaseSourceOptions) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /**
   * The newest release, reusing the last answer when it is younger than `maxAgeMs` (0 asks
   * again). Fails with `UPDATE_RATE_LIMITED`, `UPDATE_NETWORK` or `UPDATE_CHECK_FAILED`.
   */
  async latest(options: { maxAgeMs?: number } = {}): Promise<Rly0HubRelease> {
    const maxAge = options.maxAgeMs ?? HUB_RELEASE_REUSE_MS;
    if (this.#cached && maxAge > 0 && this.#now() - this.#cached.at <= maxAge)
      return this.#cached.release;
    this.#running ??= this.#lookup().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #lookup(): Promise<Rly0HubRelease> {
    const get = await this.#options.get();
    let release: Rly0HubRelease;
    try {
      release = parseHubReleaseManifest(await getUpdateJson(get, HUB_RELEASE_MANIFEST_URL));
    } catch {
      try {
        release = hubReleaseFromApi(
          parseLatestGitHubRelease(
            await getUpdateJson(get, RLY0_GITHUB_API_LATEST_RELEASE_URL, {
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
            }),
          ),
        );
      } catch (error) {
        throw new Error(hubReleaseErrorCode(error), { cause: error });
      }
    }
    this.#cached = { at: this.#now(), release };
    return release;
  }
}
