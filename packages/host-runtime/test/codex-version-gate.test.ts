import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexCompatManifestSchema,
  codexRendererPolicy,
  codexVersionVerified,
} from "@codexhost/shared-contracts";
import { compareSemanticVersions } from "@codexhost/update-manager";
import { CodexCompatibilityCatalog } from "../src/rly0-hub-service/codex-compat.js";
import {
  CodexUpdateManager,
  type CodexUpdateDriver,
} from "../src/rly0-hub-service/codex-update-manager.js";
import { Rly0HubStateStore } from "../src/rly0-hub-service/hub-state.js";
import {
  createMacCodexUpdateDriver,
  latestCodexAppcast,
  parseCodexAppcast,
  stagedSparkleUpdate,
} from "../src/rly0-hub-service/codex-sparkle.js";
import type { UpdateHttpGet } from "../src/rly0-hub-service/hub-update-net.js";
import { Rly0CodexControl } from "../src/rly0-hub-service/codex-control.js";

const roots: string[] = [];
const managers: CodexUpdateManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const manifest = {
  schemaVersion: 1,
  updatedAt: "2026-11-09T00:00:00Z",
  verified: [{ family: "26.1200", minHub: "0.11.40" }],
  disabled: [],
};
const response =
  (value: unknown): UpdateHttpGet =>
  async () => ({
    status: 200,
    headers: {},
    body: (async function* () {
      yield Buffer.from(JSON.stringify(value));
    })(),
    cancel() {},
  });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-codex-version-gate-"));
  roots.push(root);
  const environment = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CODEXHOST_DATA_DIR: path.join(root, "hub"),
    RLY0_MEMORY_DIR: path.join(root, "memory"),
    RLY0_SKIP_LEGACY_IMPORT: "1",
  };
  const state = new Rly0HubStateStore(environment);
  const catalog = new CodexCompatibilityCatalog({
    environment,
    installRoot: root,
    hubVersion: "0.11.40",
    get: async () => response(manifest),
  });
  let now = 1000;
  let current = "26.1103.1.0";
  const preference: (boolean | null)[] = [];
  const driver: CodexUpdateDriver = {
    readAutoUpdate: vi.fn(async () => true),
    writeAutoUpdate: vi.fn(async (value) => {
      preference.push(value);
    }),
    currentVersion: vi.fn(async () => current),
    latestVersion: vi.fn(async () => "26.1200.1.0"),
    requestCheck: vi.fn(async () => undefined),
    downloadReady: vi.fn(async () => true),
    quit: vi.fn(async () => undefined),
    installationStopped: vi.fn(async () => true),
    reopen: vi.fn(async () => true),
    healthy: vi.fn(async () => true),
  };
  const busy = vi.fn<() => Promise<boolean | null>>(async () => false);
  const options = { environment, state, catalog, driver, busy, now: () => now, idleMs: 10 };
  const manager = new CodexUpdateManager(options);
  managers.push(manager);
  return {
    root,
    environment,
    state,
    catalog,
    driver,
    busy,
    manager,
    options,
    preference,
    advance: (ms: number) => {
      now += ms;
    },
    install: () => {
      current = "26.1200.1.0";
    },
  };
}

describe("compatibility manifest (synthetic)", () => {
  it("accepts future fields/feature ids but rejects wrong known types", () => {
    expect(codexCompatManifestSchema.parse({ ...manifest, future: 1 }).verified).toHaveLength(1);
    expect(
      codexCompatManifestSchema.safeParse({
        ...manifest,
        verified: [{ family: "26.1200", minHub: 1 }],
      }).success,
    ).toBe(false);
    expect(
      codexCompatManifestSchema.safeParse({
        ...manifest,
        disabled: [{ feature: "usage", reason: "test", codexFamilies: "26.1200" }],
      }).success,
    ).toBe(false);
    expect(
      codexCompatManifestSchema.safeParse({ ...manifest, updatedAt: "yesterday" }).success,
    ).toBe(false);
    expect(codexCompatManifestSchema.safeParse({ ...manifest, schemaVersion: 2 }).success).toBe(
      false,
    );
  });
  it("unions the built-in table and minHub-qualified remote families", () => {
    const parsed = codexCompatManifestSchema.parse(manifest);
    expect(codexVersionVerified("26.1103.9", "0.0.0", parsed, compareSemanticVersions)).toBe(true);
    expect(codexVersionVerified("26.1200.9", "0.11.39", parsed, compareSemanticVersions)).toBe(
      false,
    );
    expect(codexVersionVerified("26.1200.9", "0.11.40", parsed, compareSemanticVersions)).toBe(
      true,
    );
    expect(codexVersionVerified("26.1200.9", "0.11.40-rc.1", parsed, compareSemanticVersions)).toBe(
      false,
    );
    expect(codexVersionVerified(null, "9.0.0", parsed, compareSemanticVersions)).toBe(false);
  });
  it("scopes remote disable by family and Hub version, including built-in verified families", () => {
    const parsed = codexCompatManifestSchema.parse({
      ...manifest,
      disabled: [
        {
          feature: "settings",
          codexFamilies: ["26.1103"],
          hubBelow: "0.12.0",
          reason: "synthetic regression",
        },
        { feature: "future-feature", reason: "future" },
      ],
    });
    expect(
      codexRendererPolicy("26.1103.1", "0.11.40", parsed, compareSemanticVersions),
    ).toMatchObject({ mode: "full", disabled: ["settings"] });
    expect(
      codexRendererPolicy("26.1103.1", "0.12.0", parsed, compareSemanticVersions).disabled,
    ).toEqual([]);
    expect(codexRendererPolicy(null, "0.12.0", parsed, compareSemanticVersions).mode).toBe("core");
    parsed.disabled.push({ feature: "draft-prewarm", reason: "routing unsafe" });
    expect(codexRendererPolicy("26.1103.1", "0.12.0", parsed, compareSemanticVersions).mode).toBe(
      "core",
    );
    parsed.disabled.push({ feature: "usage", reason: "core unsafe" });
    expect(codexRendererPolicy("26.1103.1", "0.12.0", parsed, compareSemanticVersions).mode).toBe(
      "safe",
    );
  });
  it("retains last valid cache during offline/invalid responses across a fresh process", async () => {
    const f = await fixture();
    await f.catalog.refresh();
    const offline = new CodexCompatibilityCatalog({
      ...f.options,
      installRoot: f.root,
      hubVersion: "0.11.40",
      get: async () => {
        throw new Error("offline");
      },
    });
    await offline.refresh();
    expect(offline.verified("26.1200.3")).toBe(true);
    expect(offline.status()).toMatchObject({ source: "cache", error: "COMPAT_UNAVAILABLE" });
    const invalid = new CodexCompatibilityCatalog({
      environment: f.environment,
      installRoot: f.root,
      hubVersion: "0.11.40",
      get: async () => response({ ...manifest, verified: false }),
    });
    await invalid.refresh();
    expect(invalid.verified("26.1200.3")).toBe(true);
    expect(invalid.status().error).toBe("COMPAT_INVALID");
    expect(JSON.parse(await fs.readFile(f.catalog.file, "utf8"))).toEqual(manifest);
  });
});

describe("managed Codex updates (synthetic driver, never OS defaults)", () => {
  it.each([true, false, null])(
    "defaults once and restores exact original preference %s",
    async (original) => {
      const f = await fixture();
      vi.mocked(f.driver.readAutoUpdate).mockResolvedValue(original);
      expect((await f.manager.check()).phase).toBe("downloading");
      expect(f.preference[0]).toBe(false);
      expect(await f.state.read()).toMatchObject({
        codexUpdates: { defaulted: true, enabled: true, originalAutoUpdate: original },
      });
      expect((await f.manager.setEnabled(false)).phase).toBe("disabled");
      expect(f.preference.at(-1)).toBe(original);
      const second = new CodexUpdateManager(f.options);
      managers.push(second);
      await second.check();
      expect(second.status()).toMatchObject({ enabled: false, defaulted: true, phase: "disabled" });
      expect(f.driver.readAutoUpdate).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps an unverified release held without a time limit", async () => {
    const f = await fixture();
    vi.mocked(f.driver.latestVersion).mockResolvedValue("27.9999.1");
    expect((await f.manager.check()).phase).toBe("waiting-compatibility");
    f.advance(365 * 24 * 60 * 60_000);
    expect((await f.manager.check()).phase).toBe("waiting-compatibility");
    expect(f.preference).not.toContain(true);
    expect(f.driver.quit).not.toHaveBeenCalled();
  });
  it("waits for signed staged download and continuous fresh idle, then reopens only the installed target", async () => {
    const f = await fixture();
    await f.manager.check();
    vi.mocked(f.driver.downloadReady).mockResolvedValue(false);
    await f.manager.tick();
    expect(f.driver.quit).not.toHaveBeenCalled();
    vi.mocked(f.driver.downloadReady).mockResolvedValue(true);
    await f.manager.tick();
    f.advance(10);
    f.busy.mockResolvedValue(null);
    await f.manager.tick();
    expect(f.driver.quit).not.toHaveBeenCalled();
    f.busy.mockResolvedValue(false);
    await f.manager.tick();
    f.advance(5);
    f.busy.mockResolvedValue(true);
    await f.manager.tick();
    f.advance(20);
    f.busy.mockResolvedValue(false);
    await f.manager.tick();
    f.advance(10);
    expect((await f.manager.tick()).phase).toBe("installing");
    expect(f.driver.quit).toHaveBeenCalledTimes(1);
    await f.manager.tick();
    expect(f.driver.reopen).not.toHaveBeenCalled();
    f.install();
    vi.mocked(f.driver.installationStopped).mockResolvedValue(false);
    await f.manager.tick();
    expect(f.driver.reopen).not.toHaveBeenCalled();
    vi.mocked(f.driver.installationStopped).mockResolvedValue(true);
    expect((await f.manager.tick()).phase).toBe("health-check");
    expect(f.preference.at(-1)).toBe(false);
    expect((await f.manager.tick()).phase).toBe("up-to-date");
  });
  it("disarms on native command failure, timeout and an appcast target change without quitting", async () => {
    const f = await fixture();
    vi.mocked(f.driver.requestCheck).mockRejectedValueOnce(new Error("permission denied"));
    expect((await f.manager.check()).error).toBe("CODEX_UPDATE_CHECK_FAILED");
    expect(f.preference.at(-1)).toBe(false);
    await f.manager.check();
    f.advance(31 * 60_000);
    expect((await f.manager.tick()).error).toBe("CODEX_DOWNLOAD_TIMEOUT");
    await f.manager.check();
    await f.manager.tick();
    f.advance(10);
    vi.mocked(f.driver.latestVersion).mockResolvedValueOnce("26.1300.1");
    expect((await f.manager.tick()).error).toBe("CODEX_UPDATE_TARGET_CHANGED");
    expect(f.driver.quit).not.toHaveBeenCalled();
  });
  it("serializes concurrent initialization and retains the original after interrupted release", async () => {
    const f = await fixture();
    await Promise.all([f.manager.check(), f.manager.check()]);
    expect(f.driver.readAutoUpdate).toHaveBeenCalledTimes(1);
    expect(f.driver.requestCheck).toHaveBeenCalledTimes(1);
    const restarted = new CodexUpdateManager(f.options);
    managers.push(restarted);
    await restarted.check();
    expect(f.driver.readAutoUpdate).toHaveBeenCalledTimes(1);
    await restarted.setEnabled(false);
    expect(f.preference.at(-1)).toBe(true);
  });
  it("reports preference failures and retries restore without losing ownership", async () => {
    const f = await fixture();
    await f.manager.check();
    vi.mocked(f.driver.writeAutoUpdate).mockRejectedValueOnce(new Error("no permission"));
    expect((await f.manager.setEnabled(false)).error).toBe("CODEX_PREFERENCES_FAILED");
    expect((await f.state.read()).codexUpdates?.enabled).toBe(true);
    expect((await f.manager.setEnabled(false)).enabled).toBe(false);
  });
  it("Windows reports unsupported, persists the user's toggle, still publishes a conservative policy", async () => {
    const f = await fixture();
    const manager = new CodexUpdateManager({
      ...f.options,
      driver: null,
      currentVersion: async () => "26.1300.1",
    });
    managers.push(manager);
    expect(await manager.check()).toMatchObject({
      enabled: true,
      supported: false,
      phase: "unsupported",
      renderer: { mode: "core" },
    });
    await manager.setEnabled(false);
    expect((await f.state.read()).codexUpdates).toEqual({
      defaulted: true,
      enabled: false,
      noticeAcknowledged: true,
    });
    expect(f.driver.writeAutoUpdate).not.toHaveBeenCalled();
  });
});

describe("Mac Sparkle adapter (synthetic commands only)", () => {
  it("parses actual appcast forms numerically and does not invent an installation id", async () => {
    const xml =
      '<rss><item><sparkle:shortVersionString>26.9.1</sparkle:shortVersionString><enclosure url="https://example.test/a"/></item><item><enclosure sparkle:shortVersionString="26.1103.2"/></item></rss>';
    expect(parseCodexAppcast(xml)).toEqual(["26.1103.2", "26.9.1"]);
    const f = await fixture();
    const get = vi.fn(response({}));
    await expect(
      latestCodexAppcast({ environment: f.environment, current: "26.9.1", get }),
    ).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    await fs.mkdir(path.join(f.root, "Library/Application Support/com.openai.codex"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        f.root,
        "Library/Application Support/com.openai.codex/production-appcast-bootstrap.json",
      ),
      JSON.stringify({ installationId: "synthetic-id" }),
    );
    const xmlGet: UpdateHttpGet = vi.fn(async (url, headers) => {
      expect(url).toContain(
        "installation_id=synthetic-id&arch=x86_64&app_version=26.9.1&beta=false",
      );
      expect(headers["user-agent"]).toBe("Codex/26.9.1 Sparkle");
      return {
        status: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from(xml);
        })(),
        cancel() {},
      };
    });
    expect(
      await latestCodexAppcast({
        environment: f.environment,
        current: "26.9.1",
        get: xmlGet,
        arch: "x64",
      }),
    ).toBe("26.1103.2");
  });
  it("writes only the real Sparkle preference and restores absence using injected exec", async () => {
    const f = await fixture();
    const exec = vi.fn(async (_file: string, args: string[]) => (args[0] === "read" ? "1" : ""));
    const driver = createMacCodexUpdateDriver({
      environment: f.environment,
      get: async () => response(manifest),
      currentVersion: f.driver.currentVersion,
      reopen: f.driver.reopen,
      healthy: f.driver.healthy,
      exec,
    });
    expect(await driver.readAutoUpdate()).toBe(true);
    await driver.writeAutoUpdate(false);
    await driver.writeAutoUpdate(null);
    expect(exec.mock.calls).toContainEqual([
      "/usr/bin/defaults",
      ["write", "com.openai.codex", "SUAutomaticallyUpdate", "-bool", "false"],
    ]);
    expect(exec.mock.calls).toContainEqual([
      "/usr/bin/defaults",
      ["delete", "com.openai.codex", "SUAutomaticallyUpdate"],
    ]);
  });
  it("does not accept a mere timer, wrong version or partial staging as download readiness", async () => {
    const f = await fixture();
    const exec = vi.fn(async (_file: string, args: string[]) =>
      args.includes("CFBundleIdentifier") ? "com.openai.codex" : "26.1200.1.0",
    );
    expect(await stagedSparkleUpdate(f.root, "26.1200.1.0", exec)).toBe(false);
    const app = path.join(
      f.root,
      "Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/Installation/synthetic/Codex.app",
    );
    await fs.mkdir(app, { recursive: true });
    expect(await stagedSparkleUpdate(f.root, "26.1300.1.0", exec)).toBe(false);
    expect(await stagedSparkleUpdate(f.root, "26.1200.1.0", exec)).toBe(true);
    exec.mockRejectedValueOnce(new Error("partial"));
    expect(await stagedSparkleUpdate(f.root, "26.1200.1.0", exec)).toBe(false);
  });
});

it("restart through a live Launcher quits and re-decides policy instead of its stale internal restart", async () => {
  const f = await fixture();
  const local = path.join(f.root, "local");
  const descriptor = path.join(local, "RLY0 Hub", "desktop-runtime-v1.json");
  // Use the shared directory name rather than relying on platform path guesses.
  const { RLY0_APP_DATA_DIRECTORY_NAME } = await import("@codexhost/shared-contracts");
  const file = path.join(local, RLY0_APP_DATA_DIRECTORY_NAME, path.basename(descriptor));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ launcherPid: 1234, nonce: "ab".repeat(16) }));
  const started: NodeJS.ProcessEnv[] = [];
  let mode: "full" | "core" = "full";
  const codex = new Rly0CodexControl({
    environment: { ...f.environment, LOCALAPPDATA: local },
    installRoot: f.root,
    platform: "win32",
    isAlive: () => true,
    fileExists: () => true,
    killProcesses: async () => 1,
    restartDelayMs: 0,
    startDetached: (_file, env) => {
      started.push(env);
    },
    launchModes: { decide: async () => mode, allowFullMode: async () => undefined },
  });
  mode = "core";
  expect(await codex.restart()).toEqual({ ok: true });
  expect(JSON.parse(started[0]?.CODEXHOST_RENDERER_POLICY ?? "null")).toMatchObject({
    mode: "core",
  });
  expect(started[0]?.CODEXHOST_DATA_DIR).toBe(f.environment.CODEXHOST_DATA_DIR);
});

it("persists first-default notice acknowledgement without reverting the update toggle", async () => {
  const f = await fixture();
  await f.manager.check();
  expect(f.manager.status().noticePending).toBe(true);
  expect((await f.manager.acknowledgeNotice()).noticePending).toBe(false);
  const restarted = new CodexUpdateManager(f.options);
  managers.push(restarted);
  expect((await restarted.check()).noticePending).toBe(false);
});
it("recovers a completed install after Hub interruption without reissuing native update check", async () => {
  const f = await fixture();
  await f.manager.check();
  await f.manager.tick();
  f.advance(10);
  expect((await f.manager.tick()).phase).toBe("installing");
  f.install();
  await f.manager.stop();
  const restarted = new CodexUpdateManager(f.options);
  managers.push(restarted);
  expect((await restarted.check()).phase).toBe("health-check");
  expect(f.driver.requestCheck).toHaveBeenCalledOnce();
  expect(f.driver.reopen).toHaveBeenCalledOnce();
  expect(f.preference.at(-1)).toBe(false);
});

it("serializes Hub state mutations so first-default ownership is not lost to an alert update", async () => {
  const f = await fixture();
  await Promise.all([
    f.state.update({ codexUpdates: { defaulted: true, enabled: false } }),
    f.state.update({ updateNotifiedFor: "0.11.40" }),
  ]);
  expect(await f.state.read()).toMatchObject({
    codexUpdates: { defaulted: true, enabled: false },
    updateNotifiedFor: "0.11.40",
  });
});

it("can opt out after a denied initial preference read without requiring OS write permission", async () => {
  const f = await fixture();
  vi.mocked(f.driver.readAutoUpdate).mockRejectedValue(new Error("synthetic permission denial"));
  expect((await f.manager.check()).error).toBe("CODEX_PREFERENCES_FAILED");
  expect(await f.manager.setEnabled(false)).toMatchObject({
    enabled: false,
    phase: "disabled",
    error: null,
  });
  expect(f.driver.writeAutoUpdate).not.toHaveBeenCalled();
  expect((await f.state.read()).codexUpdates?.enabled).toBe(false);
});

it("unsupported restart never submits a partial quit to the running Launcher", async () => {
  const f = await fixture();
  const { RLY0_APP_DATA_DIRECTORY_NAME } = await import("@codexhost/shared-contracts");
  const directory = path.join(f.root, RLY0_APP_DATA_DIRECTORY_NAME);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "desktop-runtime-v1.json"),
    JSON.stringify({ launcherPid: 1234, nonce: "ab".repeat(16) }),
  );
  const codex = new Rly0CodexControl({
    environment: { ...f.environment, LOCALAPPDATA: f.root },
    installRoot: f.root,
    platform: "win32",
    isAlive: () => true,
    fileExists: () => true,
  });
  expect(await codex.restart()).toEqual({ ok: false });
  await expect(fs.access(path.join(directory, "desktop-control-request.json"))).rejects.toThrow();
});
