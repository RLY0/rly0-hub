import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  HUB_RELEASE_MANIFEST_URL,
  Rly0HubReleaseSource,
  parseHubReleaseManifest,
  type Rly0HubRelease,
} from "../src/rly0-hub-service/hub-release.js";
import {
  createUpdateHttpGet,
  downloadResumable,
  parseWindowsProxyQuery,
  resolveUpdateProxy,
  type UpdateHttpGet,
  type UpdateHttpResponse,
} from "../src/rly0-hub-service/hub-update-net.js";
import {
  Rly0HubUpdater,
  hubInstallerAssetName,
  hubPartialDownloadName,
  selectHubInstaller,
} from "../src/rly0-hub-service/hub-updater.js";
import { checkHubUpdate } from "../src/rly0-hub-service/update-check.js";

const PREFIX = "https://github.com/RLY0/rly0-hub/releases/download/";
const API = "https://api.github.com/repos/RLY0/rly0-hub/releases/latest";
const SHA = "a".repeat(64);
const PAYLOAD = Buffer.from("0123456789abcdefghij");
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

function apiRelease(version: string, digest: string | null = `sha256:${SHA}`) {
  const name = hubInstallerAssetName(version);
  return {
    version,
    releaseNotes: null,
    releaseNotesUrl: `https://github.com/RLY0/rly0-hub/releases/tag/v${version}`,
    assets: [{ name, size: 10, digest, downloadUrl: `${PREFIX}v${version}/${name}` }],
  };
}

/** What GitHub's REST API answers for releases/latest. */
function apiJson(version: string, sha256 = PAYLOAD_SHA, size = PAYLOAD.length) {
  const name = hubInstallerAssetName(version);
  return {
    draft: false,
    prerelease: false,
    tag_name: `v${version}`,
    html_url: `https://github.com/RLY0/rly0-hub/releases/tag/v${version}`,
    body: "notes",
    assets: [
      {
        name,
        size,
        digest: `sha256:${sha256}`,
        browser_download_url: `${PREFIX}v${version}/${name}`,
      },
    ],
  };
}

function manifest(version: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version,
    name: hubInstallerAssetName(version),
    size: PAYLOAD.length,
    sha256: PAYLOAD_SHA,
    publishedAt: "2026-10-20T08:00:00.000Z",
    notes: "修复软件内更新",
    ...overrides,
  };
}

type Answer =
  | {
      status: number;
      headers?: Record<string, string>;
      json?: unknown;
      chunks?: Buffer[];
      failAfter?: number;
    }
  | Error;

/** A scripted GitHub: each URL answers from its handler; every request is recorded. */
function fakeGet(handlers: Record<string, (headers: Record<string, string>) => Answer>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const get: UpdateHttpGet = async (url, headers) => {
    calls.push({ url, headers: { ...headers } });
    const handler = handlers[url];
    if (!handler) return response({ status: 404 });
    const answer = handler({ ...headers });
    if (answer instanceof Error) throw answer;
    return response(answer);
  };
  return { get, calls };
}

function response(answer: Exclude<Answer, Error>): UpdateHttpResponse {
  const chunks =
    answer.chunks ?? (answer.json === undefined ? [] : [Buffer.from(JSON.stringify(answer.json))]);
  return {
    status: answer.status,
    headers: answer.headers ?? {},
    body: (async function* () {
      let index = 0;
      for (const chunk of chunks) {
        if (answer.failAfter !== undefined && index >= answer.failAfter)
          throw new Error("ECONNRESET");
        index += 1;
        yield new Uint8Array(chunk);
      }
    })(),
    cancel: () => undefined,
  };
}

/** Serves PAYLOAD in 5-byte chunks, honouring `Range: bytes=N-` unless told not to. */
function installerServer(options: { range?: boolean; failAfter?: number } = {}) {
  return (headers: Record<string, string>): Answer => {
    const match = /^bytes=(\d+)-$/u.exec(headers.range ?? "");
    const start = options.range !== false && match ? Number(match[1]) : 0;
    const rest = PAYLOAD.subarray(start);
    const chunks: Buffer[] = [];
    for (let i = 0; i < rest.length; i += 5) chunks.push(rest.subarray(i, i + 5));
    return {
      status: start > 0 ? 206 : 200,
      headers:
        start > 0
          ? { "content-range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}` }
          : {},
      chunks,
      ...(options.failAfter !== undefined ? { failAfter: options.failAfter } : {}),
    };
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
  for (let i = 0; i < 200; i += 1) {
    const phase = updater.progress().phase;
    if (phase === "installing" || phase === "error") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function updaterWith(
  root: string,
  get: UpdateHttpGet,
  source = new Rly0HubReleaseSource({ get: async () => get }),
) {
  const launched: { installer: string; args: readonly string[] }[] = [];
  const downloadDir = path.join(root, "updates");
  const updater = new Rly0HubUpdater({
    installRoot: root,
    downloadDir,
    platform: "win32",
    release: () => source.latest(),
    download: (artifact, partial, onProgress) =>
      downloadResumable(get, artifact, partial, onProgress),
    launch: (installer, args) => launched.push({ installer, args }),
  });
  return { updater, launched, downloadDir, source };
}

describe("selectHubInstaller", () => {
  it("picks the setup asset with its SHA-256", () => {
    expect(selectHubInstaller(apiRelease("1.2.3"))).toEqual({
      url: `${PREFIX}v1.2.3/RLY0-Hub-1.2.3-setup.exe`,
      sha256: SHA,
      size: 10,
    });
  });

  it("refuses an asset GitHub has no digest for", () => {
    expect(() => selectHubInstaller(apiRelease("1.2.3", null))).toThrow("UPDATE_ASSET_UNVERIFIED");
  });

  it("refuses a release without the installer", () => {
    expect(() => selectHubInstaller({ ...apiRelease("1.2.3"), assets: [] })).toThrow(
      "UPDATE_ASSET_MISSING",
    );
  });
});

describe("parseHubReleaseManifest", () => {
  it("accepts the manifest the release writes", () => {
    expect(parseHubReleaseManifest(manifest("1.2.3"))).toMatchObject({
      version: "1.2.3",
      releaseNotes: "修复软件内更新",
      releaseNotesUrl: "https://github.com/RLY0/rly0-hub/releases/tag/v1.2.3",
      installer: { url: `${PREFIX}v1.2.3/RLY0-Hub-1.2.3-setup.exe`, sha256: PAYLOAD_SHA, size: 20 },
      via: "manifest",
    });
  });

  it.each([
    ["an unknown key", { url: "https://evil.example/x.exe" }],
    ["another installer name", { name: "RLY0-Hub-9.9.9-setup.exe" }],
    ["an upper-case digest", { sha256: "A".repeat(64) }],
    ["a short digest", { sha256: "a".repeat(63) }],
    ["a non-semver version", { version: "1.2", name: "RLY0-Hub-1.2-setup.exe" }],
    ["a zero size", { size: 0 }],
    ["another schema", { schemaVersion: 2 }],
    ["a bad date", { publishedAt: "yesterday" }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseHubReleaseManifest(manifest("1.2.3", overrides))).toThrow(/manifest/u);
  });
});

describe("Rly0HubReleaseSource", () => {
  it("reads latest.json from the download CDN and never asks the API", async () => {
    const { get, calls } = fakeGet({
      [HUB_RELEASE_MANIFEST_URL]: () => ({ status: 200, json: manifest("1.2.3") }),
    });
    const release = await new Rly0HubReleaseSource({ get: async () => get }).latest();
    expect(release).toMatchObject({ version: "1.2.3", via: "manifest" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://github.com/RLY0/rly0-hub/releases/latest/download/latest.json",
    ]);
  });

  it("falls back to the API when the release has no manifest", async () => {
    const { get, calls } = fakeGet({ [API]: () => ({ status: 200, json: apiJson("1.2.3") }) });
    const release = await new Rly0HubReleaseSource({ get: async () => get }).latest();
    expect(release).toMatchObject({
      version: "1.2.3",
      via: "api",
      installer: { sha256: PAYLOAD_SHA, size: 20 },
      installerProblem: null,
    });
    expect(calls.map((call) => call.url)).toEqual([HUB_RELEASE_MANIFEST_URL, API]);
  });

  it("falls back to the API when the manifest does not validate", async () => {
    const { get } = fakeGet({
      [HUB_RELEASE_MANIFEST_URL]: () => ({ status: 200, json: manifest("1.2.3", { size: -1 }) }),
      [API]: () => ({ status: 200, json: apiJson("1.2.3") }),
    });
    expect(await new Rly0HubReleaseSource({ get: async () => get }).latest()).toMatchObject({
      via: "api",
    });
  });

  it("reports GitHub's 403 rate limit as UPDATE_RATE_LIMITED", async () => {
    const { get } = fakeGet({
      [API]: () => ({ status: 403, headers: { "x-ratelimit-remaining": "0" }, json: {} }),
    });
    await expect(new Rly0HubReleaseSource({ get: async () => get }).latest()).rejects.toThrow(
      "UPDATE_RATE_LIMITED",
    );
  });

  it("reports an unreachable GitHub as UPDATE_NETWORK", async () => {
    const offline = new Error("UPDATE_NETWORK");
    const { get } = fakeGet({ [HUB_RELEASE_MANIFEST_URL]: () => offline, [API]: () => offline });
    await expect(new Rly0HubReleaseSource({ get: async () => get }).latest()).rejects.toThrow(
      "UPDATE_NETWORK",
    );
  });

  it("reuses the last release for an hour, and asks again when forced or stale", async () => {
    let now = 0;
    const { get, calls } = fakeGet({
      [HUB_RELEASE_MANIFEST_URL]: () => ({ status: 200, json: manifest("1.2.3") }),
    });
    const source = new Rly0HubReleaseSource({ get: async () => get, now: () => now });
    await source.latest();
    now = 30 * 60_000;
    await source.latest();
    expect(calls).toHaveLength(1);
    await source.latest({ maxAgeMs: 0 });
    expect(calls).toHaveLength(2);
    now += 61 * 60_000;
    await source.latest();
    expect(calls).toHaveLength(3);
  });
});

describe("checkHubUpdate", () => {
  it("passes on why the check failed", async () => {
    const root = await installRoot("1.0.0");
    for (const code of ["UPDATE_RATE_LIMITED", "UPDATE_NETWORK"])
      expect(await checkHubUpdate(root, () => Promise.reject(new Error(code)))).toMatchObject({
        currentVersion: "1.0.0",
        error: code,
      });
    expect(
      await checkHubUpdate(root, () => Promise.reject(new Error("private detail"))),
    ).toMatchObject({ error: "UPDATE_CHECK_FAILED" });
  });
});

describe("Rly0HubUpdater", () => {
  it("installs with the release the check found, without asking GitHub again", async () => {
    const root = await installRoot("1.0.0");
    const { get, calls } = fakeGet({
      [HUB_RELEASE_MANIFEST_URL]: () => ({ status: 200, json: manifest("1.1.0") }),
      [`${PREFIX}v1.1.0/RLY0-Hub-1.1.0-setup.exe`]: installerServer(),
    });
    const { updater, launched, downloadDir, source } = updaterWith(root, get);
    expect((await checkHubUpdate(root, () => source.latest())).updateAvailable).toBe(true);
    expect(updater.start({ reopenCodex: true }).phase).toBe("downloading");
    await settle(updater);
    expect(updater.progress()).toMatchObject({
      phase: "installing",
      version: "1.1.0",
      downloadedBytes: 20,
      totalBytes: 20,
    });
    expect(calls.filter((call) => call.url === HUB_RELEASE_MANIFEST_URL)).toHaveLength(1);
    const installer = path.join(downloadDir, "RLY0-Hub-1.1.0-setup.exe");
    expect(launched).toEqual([
      {
        installer,
        args: ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/RELAUNCH=1", "/REOPENCODEX=1"],
      },
    ]);
    expect(await readFile(installer)).toEqual(PAYLOAD);
  });

  it("shows UPDATE_RATE_LIMITED, not a download failure, when the lookup is refused", async () => {
    const root = await installRoot("1.0.0");
    const { get } = fakeGet({
      [API]: () => ({ status: 403, headers: { "x-ratelimit-remaining": "0" }, json: {} }),
    });
    const { updater, launched } = updaterWith(root, get);
    updater.start({ reopenCodex: false });
    await settle(updater);
    expect(updater.progress()).toMatchObject({ phase: "error", error: "UPDATE_RATE_LIMITED" });
    expect(launched).toEqual([]);
  });

  it("shows UPDATE_NETWORK when GitHub cannot be reached", async () => {
    const root = await installRoot("1.0.0");
    const offline = new Error("UPDATE_NETWORK");
    const { get } = fakeGet({ [HUB_RELEASE_MANIFEST_URL]: () => offline, [API]: () => offline });
    const { updater } = updaterWith(root, get);
    updater.start({ reopenCodex: false });
    await settle(updater);
    expect(updater.progress()).toMatchObject({ phase: "error", error: "UPDATE_NETWORK" });
  });

  it("continues an interrupted download with a Range request on retry", async () => {
    const root = await installRoot("1.0.0");
    let failAfter: number | undefined = 2;
    const serve = (headers: Record<string, string>) => {
      const answer = installerServer(failAfter === undefined ? {} : { failAfter })(headers);
      failAfter = undefined;
      return answer;
    };
    const { get, calls } = fakeGet({
      [HUB_RELEASE_MANIFEST_URL]: () => ({ status: 200, json: manifest("1.1.0") }),
      [`${PREFIX}v1.1.0/RLY0-Hub-1.1.0-setup.exe`]: serve,
    });
    const { updater, launched, downloadDir } = updaterWith(root, get);
    updater.start({ reopenCodex: false });
    await settle(updater);
    expect(updater.progress()).toMatchObject({ phase: "error", error: "UPDATE_DOWNLOAD_FAILED" });
    expect(await readdir(downloadDir)).toEqual([hubPartialDownloadName("1.1.0")]);

    updater.start({ reopenCodex: false });
    await settle(updater);
    expect(updater.progress()).toMatchObject({ phase: "installing" });
    const downloads = calls.filter((call) => call.url.endsWith("setup.exe"));
    expect(downloads.map((call) => call.headers.range)).toEqual([undefined, "bytes=10-"]);
    expect(launched).toHaveLength(1);
    expect(await readFile(path.join(downloadDir, "RLY0-Hub-1.1.0-setup.exe"))).toEqual(PAYLOAD);
  });

  it("starts over when the server ignores Range", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rly0-resume-"));
    const partial = path.join(dir, "x.partial");
    await writeFile(partial, "XXXXX");
    const url = `${PREFIX}v1.1.0/RLY0-Hub-1.1.0-setup.exe`;
    const { get } = fakeGet({ [url]: installerServer({ range: false }) });
    const seen: number[] = [];
    await downloadResumable(get, { url, sha256: PAYLOAD_SHA, size: 20 }, partial, (p) =>
      seen.push(p.downloadedBytes),
    );
    expect(await readFile(partial)).toEqual(PAYLOAD);
    expect(seen[0]).toBe(0);
  });

  it("never runs an installer whose SHA-256 differs, and drops the bad file", async () => {
    const root = await installRoot("1.0.0");
    const { get } = fakeGet({
      [HUB_RELEASE_MANIFEST_URL]: () => ({
        status: 200,
        json: manifest("1.1.0", { sha256: "b".repeat(64) }),
      }),
      [`${PREFIX}v1.1.0/RLY0-Hub-1.1.0-setup.exe`]: installerServer(),
    });
    const { updater, launched, downloadDir } = updaterWith(root, get);
    updater.start({ reopenCodex: false });
    await settle(updater);
    expect(updater.progress()).toMatchObject({ phase: "error", error: "UPDATE_VERIFY_FAILED" });
    expect(launched).toEqual([]);
    expect(await readdir(downloadDir)).toEqual([]);
  });

  it("does nothing when already up to date", async () => {
    const root = await installRoot("1.1.0");
    const updater = new Rly0HubUpdater({
      installRoot: root,
      downloadDir: path.join(root, "updates"),
      platform: "win32",
      release: () => Promise.resolve(parseHubReleaseManifest(manifest("1.1.0")) as Rly0HubRelease),
      download: () => Promise.reject(new Error("must not download")),
    });
    updater.start({ reopenCodex: false });
    await settle(updater);
    expect(updater.progress()).toMatchObject({ phase: "error", error: "UPDATE_NONE" });
  });
});

describe("update proxy", () => {
  const none = () => Promise.resolve(null);
  const system = () => Promise.resolve("http://127.0.0.1:7890");

  it("follows the Hub setting first", async () => {
    const environment = { HTTPS_PROXY: "http://env:1" };
    expect(
      await resolveUpdateProxy({ settings: { mode: "direct" }, environment, systemProxy: system }),
    ).toBeNull();
    expect(
      await resolveUpdateProxy({
        settings: { mode: "custom", url: "http://hub:8080" },
        environment,
        systemProxy: system,
      }),
    ).toBe("http://hub:8080");
  });

  it("with 跟随系统, uses HTTPS_PROXY before the Windows proxy, and the Windows proxy last", async () => {
    expect(
      await resolveUpdateProxy({
        settings: { mode: "system" },
        environment: { HTTPS_PROXY: "env:3128" },
        systemProxy: system,
      }),
    ).toBe("http://env:3128");
    expect(
      await resolveUpdateProxy({
        settings: { mode: "system" },
        environment: {},
        systemProxy: system,
      }),
    ).toBe("http://127.0.0.1:7890");
    expect(
      await resolveUpdateProxy({
        settings: { mode: "system" },
        environment: {},
        systemProxy: none,
      }),
    ).toBeNull();
    expect(
      await resolveUpdateProxy({
        settings: { mode: "system" },
        environment: { HTTPS_PROXY: "http://env:1", NO_PROXY: ".github.com" },
        systemProxy: system,
      }),
    ).toBeNull();
  });

  it("reads the Windows system proxy only when it is switched on", () => {
    const query = (enable: string, server: string) =>
      `\r\nHKEY_CURRENT_USER\\...\\Internet Settings\r\n    ProxyEnable    REG_DWORD    ${enable}\r\n    ProxyServer    REG_SZ    ${server}\r\n`;
    expect(parseWindowsProxyQuery(query("0x1", "127.0.0.1:7890"))).toBe("http://127.0.0.1:7890");
    expect(parseWindowsProxyQuery(query("0x0", "127.0.0.1:7890"))).toBeNull();
    expect(parseWindowsProxyQuery(query("0x1", "http=h:1;https=s:2;socks=k:3"))).toBe("http://s:2");
    expect(parseWindowsProxyQuery(query("0x1", "socks=k:3"))).toBeNull();
  });

  it("tunnels to GitHub through the chosen proxy", async () => {
    const targets: string[] = [];
    const proxy = http.createServer();
    proxy.on("connect", (request: http.IncomingMessage, socket: Socket) => {
      targets.push(request.url ?? "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = proxy.address() as AddressInfo;
      const get = createUpdateHttpGet({ proxy: `http://127.0.0.1:${port}`, timeoutMs: 5_000 });
      await expect(get("https://github.com/RLY0/rly0-hub/releases/latest", {})).rejects.toThrow(
        "UPDATE_NETWORK",
      );
      expect(targets).toEqual(["github.com:443"]);
    } finally {
      proxy.close();
    }
  });
});
