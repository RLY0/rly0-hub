import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  Rly0HubUpdater,
  hubInstallerAssetName,
  selectHubInstaller,
} from "../src/rly0-hub-service/hub-updater.js";

const PREFIX = "https://github.com/RLY0/rly0-hub/releases/download/";
const SHA = "a".repeat(64);

function release(version: string, digest: string | null = `sha256:${SHA}`) {
  const name = hubInstallerAssetName(version);
  return {
    version,
    releaseNotes: null,
    releaseNotesUrl: `https://github.com/RLY0/rly0-hub/releases/tag/v${version}`,
    assets: [{ name, size: 10, digest, downloadUrl: `${PREFIX}v${version}/${name}` }],
  };
}

async function installRoot(version: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rly0-updater-"));
  await mkdir(path.join(root, "app"), { recursive: true });
  await writeFile(
    path.join(root, "app", "codexhost-distribution.json"),
    JSON.stringify({ schemaVersion: 1, version, distribution: "installer", target: "windows-x64" }),
  );
  return root;
}

async function settle(updater: Rly0HubUpdater): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const phase = updater.progress().phase;
    if (phase === "installing" || phase === "error") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("selectHubInstaller", () => {
  it("picks the setup asset with its SHA-256", () => {
    expect(selectHubInstaller(release("1.2.3"))).toEqual({
      url: `${PREFIX}v1.2.3/RLY0-Hub-1.2.3-setup.exe`,
      sha256: SHA,
      size: 10,
    });
  });

  it("refuses an asset GitHub has no digest for", () => {
    expect(() => selectHubInstaller(release("1.2.3", null))).toThrow("UPDATE_ASSET_UNVERIFIED");
  });

  it("refuses a release without the installer", () => {
    expect(() => selectHubInstaller({ ...release("1.2.3"), assets: [] })).toThrow(
      "UPDATE_ASSET_MISSING",
    );
  });
});

describe("Rly0HubUpdater", () => {
  it("downloads, verifies and launches the installer silently", async () => {
    const root = await installRoot("1.0.0");
    const downloadDir = path.join(root, "updates");
    const launched: { installer: string; args: readonly string[] }[] = [];
    const updater = new Rly0HubUpdater({
      installRoot: root,
      downloadDir,
      platform: "win32",
      fetchLatest: () => Promise.resolve(release("1.1.0")),
      download: async (_source, destination, onProgress) => {
        await writeFile(destination, "0123456789");
        await onProgress?.({ downloadedBytes: 10, totalBytes: 10 });
        return { bytes: 10, finalUrl: "https://objects.githubusercontent.com/x" };
      },
      verify: () => Promise.resolve(),
      launch: (installer, args) => launched.push({ installer, args }),
    });
    expect(updater.start({ reopenCodex: true }).phase).toBe("downloading");
    await settle(updater);
    expect(updater.progress()).toMatchObject({ phase: "installing", version: "1.1.0" });
    expect(launched).toEqual([
      {
        installer: path.join(downloadDir, "RLY0-Hub-1.1.0-setup.exe"),
        args: ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/RELAUNCH=1", "/REOPENCODEX=1"],
      },
    ]);
  });

  it("never runs an installer that fails verification", async () => {
    const root = await installRoot("1.0.0");
    const downloadDir = path.join(root, "updates");
    let launched = false;
    const updater = new Rly0HubUpdater({
      installRoot: root,
      downloadDir,
      platform: "win32",
      fetchLatest: () => Promise.resolve(release("1.1.0")),
      download: async (_source, destination) => {
        await writeFile(destination, "tampered!!");
        return { bytes: 10, finalUrl: "https://objects.githubusercontent.com/x" };
      },
      verify: () => Promise.reject(new Error("SHA-256 mismatch")),
      launch: () => {
        launched = true;
      },
    });
    updater.start({ reopenCodex: false });
    await settle(updater);
    expect(updater.progress()).toMatchObject({ phase: "error", error: "UPDATE_VERIFY_FAILED" });
    expect(launched).toBe(false);
    expect(await readdir(downloadDir)).toEqual([]);
  });

  it("does nothing when already up to date", async () => {
    const root = await installRoot("1.1.0");
    const updater = new Rly0HubUpdater({
      installRoot: root,
      downloadDir: path.join(root, "updates"),
      platform: "win32",
      fetchLatest: () => Promise.resolve(release("1.1.0")),
    });
    updater.start({ reopenCodex: false });
    await settle(updater);
    expect(updater.progress()).toMatchObject({ phase: "error", error: "UPDATE_NONE" });
  });
});
