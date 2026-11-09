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
    watchLease: vi.fn(async () => undefined),
    readAutoUpdate: vi.fn(async () => true),
    writeAutoUpdate: vi.fn(async (value) => {
      preference.push(value);
    }),
    currentVersion: vi.fn(async () => current),
    latestVersion: vi.fn(async () => "26.1200.1.0"),
    readCheckPreferences: vi.fn(async () => ({ automaticChecks: null, lastCheckTime: null })),
    restoreCheckPreferences: vi.fn(async () => undefined),
    requestCheck: vi.fn(async () => undefined),
    downloadReady: vi.fn(async () => true),
    quit: vi.fn(async () => undefined),
    installationStopped: vi.fn(async () => true),
    isRunning: vi.fn(async () => false),
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
      expect((await f.manager.check()).phase).toBe("waiting-idle");
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
  it("disarms an appcast target change without quitting", async () => {
    const f = await fixture();
    await f.manager.check();
    f.advance(10);
    vi.mocked(f.driver.latestVersion).mockResolvedValueOnce("26.1300.1");
    expect((await f.manager.tick()).error).toBe("CODEX_UPDATE_TARGET_CHANGED");
    expect(f.preference.at(-1)).toBe(false);
    expect(f.driver.quit).not.toHaveBeenCalled();
  });
  it("serializes concurrent initialization and retains the original after interrupted release", async () => {
    const f = await fixture();
    await Promise.all([f.manager.check(), f.manager.check()]);
    expect(f.driver.readAutoUpdate).toHaveBeenCalledTimes(1);
    expect(f.driver.requestCheck).not.toHaveBeenCalled();
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
  // Synthetic abrupt interruption: do not call stop(), which deliberately recovers.
  const restarted = new CodexUpdateManager(f.options);
  managers.push(restarted);
  expect((await restarted.check()).phase).toBe("health-check");
  expect(f.driver.requestCheck).not.toHaveBeenCalled();
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

// Independent-review regressions. All processes and preferences below are synthetic.
it.each(["0.11.40-.", "1.0.0-a..b", "1.0.0+."])(
  "rejects comparison-invalid manifest version %s before caching",
  async (minHub) => {
    const f = await fixture();
    await f.catalog.refresh();
    const catalog = new CodexCompatibilityCatalog({
      environment: f.environment,
      installRoot: f.root,
      hubVersion: "0.11.40",
      get: async () => response({ ...manifest, verified: [{ family: "26.1200", minHub }] }),
    });
    await catalog.refresh();
    expect(catalog.status().error).toBe("COMPAT_INVALID");
    expect(catalog.verified("26.1200.1")).toBe(true);
    expect(JSON.parse(await fs.readFile(catalog.file, "utf8"))).toEqual(manifest);
  },
);
it("comparison exceptions cannot escape status or check and never widen compatibility", async () => {
  const f = await fixture();
  expect(
    codexVersionVerified("26.1200.1", "bad", codexCompatManifestSchema.parse(manifest), () => {
      throw new Error("bad");
    }),
  ).toBe(false);
  vi.spyOn(f.catalog, "refresh").mockRejectedValueOnce(new Error("unexpected failure"));
  expect((await f.manager.check()).error).toBe("CODEX_UPDATE_CHECK_FAILED");
  expect(() => f.manager.status()).not.toThrow();
});
it("invalid persisted manifests are discarded instead of repeatedly crashing startup", async () => {
  const f = await fixture();
  await fs.mkdir(path.dirname(f.catalog.file), { recursive: true });
  await fs.writeFile(
    f.catalog.file,
    JSON.stringify({ ...manifest, verified: [{ family: "26.1200", minHub: "1.0.0-a..b" }] }),
  );
  const catalog = new CodexCompatibilityCatalog({
    environment: f.environment,
    installRoot: f.root,
    hubVersion: "bad",
  });
  await catalog.load();
  expect(catalog.verified("26.1200.1")).toBe(false);
  expect(catalog.policy("26.1200.1").mode).toBe("core");
});
it("transient version inspection failure preserves the version-bound running policy", async () => {
  const f = await fixture();
  await f.manager.check();
  const file = path.join(f.environment.CODEXHOST_DATA_DIR, "codex-renderer-policy.json");
  const original = await fs.readFile(file, "utf8");
  vi.mocked(f.driver.currentVersion).mockRejectedValue(new Error("transient read"));
  await f.manager.check();
  expect(f.manager.status().currentVersion).toBe("26.1103.1.0");
  expect(await fs.readFile(file, "utf8")).toBe(original);
  await f.catalog.publishPolicy(null);
  expect(await fs.readFile(file, "utf8")).toBe(original);
});
it("tolerates future/invalid optional state fields while retaining opt-out and original preference", async () => {
  const f = await fixture();
  await f.state.update({
    codexUpdates: { defaulted: true, enabled: false, originalAutoUpdate: true },
  });
  const file = path.join(f.environment.CODEXHOST_DATA_DIR, "hub-desktop.json");
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  raw.codexUpdates.futureField = 1;
  raw.codexUpdates.noticeAcknowledged = "broken";
  await fs.writeFile(file, JSON.stringify(raw));
  expect((await f.state.read()).codexUpdates).toMatchObject({
    enabled: false,
    originalAutoUpdate: true,
  });
  expect((await f.manager.check()).enabled).toBe(false);
  expect(f.driver.readAutoUpdate).not.toHaveBeenCalled();
});
it.each([true, null])(
  "waits indefinitely for idle (%s), without arming or restarting",
  async (busy) => {
    const f = await fixture();
    f.busy.mockResolvedValue(busy);
    vi.mocked(f.driver.downloadReady).mockResolvedValue(false);
    await f.manager.check();
    f.advance(48 * 60 * 60_000);
    expect((await f.manager.tick()).phase).toBe("waiting-idle");
    expect(f.preference).not.toContain(true);
    expect(f.driver.requestCheck).not.toHaveBeenCalled();
    expect(f.driver.quit).not.toHaveBeenCalled();
  },
);
it("a ready staged update waits through prolonged work without a download timeout or repeated check", async () => {
  const f = await fixture();
  f.busy.mockResolvedValue(true);
  await f.manager.check();
  f.advance(48 * 60 * 60_000);
  expect((await f.manager.tick()).phase).toBe("waiting-idle");
  expect(f.driver.downloadReady).toHaveBeenCalledOnce();
  expect(f.driver.requestCheck).not.toHaveBeenCalled();
});
async function backgroundRestart(f: Awaited<ReturnType<typeof fixture>>) {
  vi.mocked(f.driver.downloadReady).mockResolvedValue(false);
  await f.manager.check();
  f.advance(10);
  expect((await f.manager.tick()).phase).toBe("installing");
  expect((await f.manager.tick()).phase).toBe("downloading");
}
it("starts scheduled background checking only after idle, with durable original preferences and live lease", async () => {
  const f = await fixture();
  await backgroundRestart(f);
  expect(f.driver.requestCheck).toHaveBeenCalledOnce();
  expect(f.driver.reopen).toHaveBeenCalledOnce();
  expect((await f.state.read()).codexUpdates?.originalCheckPreferences).toEqual({
    automaticChecks: null,
    lastCheckTime: null,
  });
  const lease = JSON.parse(
    await fs.readFile(
      path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-armed.json"),
      "utf8",
    ),
  );
  expect(lease).toMatchObject({ pid: process.pid, target: "26.1200.1.0" });
  f.advance(2000);
  await f.manager.tick();
  expect(
    JSON.parse(
      await fs.readFile(
        path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-armed.json"),
        "utf8",
      ),
    ),
  ).toHaveProperty("at", lease.at + 2000);
  await f.manager.setEnabled(false);
  expect(f.driver.restoreCheckPreferences).toHaveBeenCalledWith({
    automaticChecks: null,
    lastCheckTime: null,
  });
  await expect(
    fs.access(path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-armed.json")),
  ).rejects.toThrow();
});
it("native background preparation failure disarms before any quit and backs off", async () => {
  const f = await fixture();
  vi.mocked(f.driver.downloadReady).mockResolvedValue(false);
  vi.mocked(f.driver.requestCheck).mockRejectedValue(new Error("synthetic denial"));
  await f.manager.check();
  f.advance(10);
  expect((await f.manager.tick()).error).toBe("CODEX_UPDATE_CHECK_FAILED");
  expect(f.preference.at(-1)).toBe(false);
  expect(f.driver.quit).not.toHaveBeenCalled();
  f.advance(5 * 60_000);
  await f.manager.check();
  expect(f.driver.requestCheck).toHaveBeenCalledOnce();
});
it("download timeout backs off across checks and process restarts, restoring scheduled-check keys", async () => {
  const f = await fixture();
  await backgroundRestart(f);
  f.advance(31 * 60_000);
  expect((await f.manager.tick()).error).toBe("CODEX_DOWNLOAD_TIMEOUT");
  expect(f.driver.restoreCheckPreferences).toHaveBeenCalledOnce();
  f.advance(5 * 60_000);
  await f.manager.check();
  const restarted = new CodexUpdateManager(f.options);
  managers.push(restarted);
  await restarted.check();
  expect(f.driver.requestCheck).toHaveBeenCalledOnce();
});
it("all feed candidates must be verified even if Sparkle picks an older OS/rollout candidate", async () => {
  const f = await fixture();
  f.driver.availableVersions = vi.fn(async () => ["26.1200.1.0", "26.1199.1.0"]);
  await f.manager.check();
  f.advance(10);
  expect((await f.manager.tick()).phase).toBe("waiting-compatibility");
  expect(f.preference).not.toContain(true);
  expect(f.driver.quit).not.toHaveBeenCalled();
});
it.each(["timeout", "disarm failure", "lost quit reply"])(
  "reopens a Codex closed by Hub after %s",
  async (failure) => {
    const f = await fixture();
    await f.manager.check();
    f.advance(10);
    if (failure === "lost quit reply")
      vi.mocked(f.driver.quit).mockRejectedValueOnce(new Error("lost reply"));
    await f.manager.tick();
    if (failure === "disarm failure") {
      f.install();
      vi.mocked(f.driver.writeAutoUpdate).mockRejectedValueOnce(new Error("denied"));
    } else if (failure === "timeout") f.advance(6 * 60_000);
    await f.manager.tick();
    expect(f.driver.reopen).toHaveBeenCalledOnce();
    expect(f.manager.status().phase).toBe("failed");
  },
);
it("does not reopen during its own installer, but recovers once that installer exits", async () => {
  const f = await fixture();
  await f.manager.check();
  f.advance(10);
  await f.manager.tick();
  vi.mocked(f.driver.installationStopped).mockResolvedValue(false);
  f.advance(6 * 60_000);
  await f.manager.tick();
  expect(f.driver.reopen).not.toHaveBeenCalled();
  vi.mocked(f.driver.installationStopped).mockResolvedValue(true);
  await f.manager.tick();
  expect(f.driver.reopen).toHaveBeenCalledOnce();
});
it("accepts numeric-equivalent installed version formatting", async () => {
  const f = await fixture();
  await f.manager.check();
  f.advance(10);
  await f.manager.tick();
  vi.mocked(f.driver.currentVersion).mockResolvedValue("26.1200.1");
  expect((await f.manager.tick()).phase).toBe("health-check");
  expect(f.driver.reopen).toHaveBeenCalledOnce();
});
it("normal quit is cancelled if the final idle check becomes unknown", async () => {
  const f = await fixture();
  await f.manager.check();
  f.advance(10);
  f.busy.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(null);
  await f.manager.tick();
  expect(f.driver.quit).not.toHaveBeenCalled();
  expect(f.preference.at(-1)).toBe(false);
});

it("background driver uses only documented preferences, with no menu or fake launch parameters", async () => {
  const f = await fixture();
  const exec = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === "read")
      return args[2] === "SUEnableAutomaticChecks" ? "0" : "2026-01-01 00:00:00 +0000";
    return "";
  });
  const driver = createMacCodexUpdateDriver({
    environment: f.environment,
    get: async () => response({}),
    currentVersion: f.driver.currentVersion,
    reopen: f.driver.reopen,
    healthy: f.driver.healthy,
    exec,
  });
  const original = await driver.readCheckPreferences();
  await driver.requestCheck();
  await driver.restoreCheckPreferences(original);
  expect(exec.mock.calls.every(([file]) => file === "/usr/bin/defaults")).toBe(true);
  expect(exec.mock.calls).toContainEqual([
    "/usr/bin/defaults",
    ["delete", "com.openai.codex", "SULastCheckTime"],
  ]);
  expect(exec.mock.calls).toContainEqual([
    "/usr/bin/defaults",
    ["write", "com.openai.codex", "SUEnableAutomaticChecks", "-bool", "true"],
  ]);
  expect(exec.mock.calls).toContainEqual([
    "/usr/bin/defaults",
    ["write", "com.openai.codex", "SUEnableAutomaticChecks", "-bool", "false"],
  ]);
  expect(exec.mock.calls).toContainEqual([
    "/usr/bin/defaults",
    ["write", "com.openai.codex", "SULastCheckTime", "-date", original.lastCheckTime],
  ]);
});
it.each([
  ["/Applications/Other.app/Contents/Frameworks/Sparkle.framework/Autoupdate", true],
  ["/Applications/Codex.app/Contents/Frameworks/Sparkle.framework/Autoupdate", false],
  [
    "/tmp/com.openai.codex/org.sparkle-project.Sparkle/Installation/a/Updater.app/Contents/MacOS/Updater",
    false,
  ],
  ["/Applications/Codex.app/Contents/MacOS/Codex", false],
])("scopes installer recovery to Codex processes: %s", async (processes, stopped) => {
  const f = await fixture();
  const exec = vi.fn(async () => processes);
  const driver = createMacCodexUpdateDriver({
    environment: f.environment,
    get: async () => response({}),
    currentVersion: f.driver.currentVersion,
    reopen: f.driver.reopen,
    healthy: f.driver.healthy,
    exec,
  });
  expect(await driver.installationStopped()).toBe(stopped);
  expect(exec).toHaveBeenCalledWith("/bin/ps", ["-axo", "args="]);
});
it("caches successful staging signatures, revalidates on quit, and invalidates changed identities", async () => {
  const f = await fixture();
  const app = path.join(
    f.root,
    "Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/Installation/synthetic/Codex.app",
  );
  await fs.mkdir(app, { recursive: true });
  const exec = vi.fn(async (file: string, args: string[]) =>
    file === "/usr/bin/plutil"
      ? args.includes("CFBundleIdentifier")
        ? "com.openai.codex"
        : "26.1200.1"
      : "",
  );
  const driver = createMacCodexUpdateDriver({
    environment: f.environment,
    get: async () => response({}),
    currentVersion: f.driver.currentVersion,
    reopen: f.driver.reopen,
    healthy: f.driver.healthy,
    exec,
  });
  expect(await driver.downloadReady("26.1200.1.0")).toBe(true);
  expect(await driver.downloadReady("26.1200.1.0")).toBe(true);
  expect(exec.mock.calls.filter(([file]) => file === "/usr/bin/codesign")).toHaveLength(1);
  expect(await driver.downloadReady("26.1200.1.0", true)).toBe(true);
  expect(exec.mock.calls.filter(([file]) => file === "/usr/bin/codesign")).toHaveLength(2);
  await fs.rm(app, { recursive: true });
  expect(await driver.downloadReady("26.1200.1.0", true)).toBe(false);
});
it("guard handoff yields only for a fresh lease with a live Hub; otherwise writes false", async () => {
  const { execFileSync } = await import("node:child_process");
  const patch = await fs.readFile(path.resolve(".pm/selfheal/codex-guard-handoff.patch"), "utf8");
  const body = patch
    .split("\n")
    .filter((line) => line.startsWith("+    "))
    .map((line) => line.slice(1))
    .join("\n");
  const f = await fixture();
  const program = `import json, os, time, subprocess\nfrom pathlib import Path\nfrom unittest.mock import patch\nroot = Path(${JSON.stringify(f.root)})\n(root / 'hub-desktop.json').write_text(json.dumps({'codexUpdates': {'enabled': True}}))\nos.environ['CODEXHOST_DATA_DIR'] = str(root)\ndef main():\n${body}\n    raise AssertionError('legacy guard must never execute while managed')\nfor lease, alive, expected in [({'pid':123,'at':100000},True,0), ({'pid':123,'at':100000},False,1), ({'pid':123,'at':1},True,1), ({'pid':123,'at':200000},True,1), ({'pid':True,'at':100000},True,1), ({'pid':123,'at':'bad'},True,1), ({},True,1)]:\n    (root / 'codex-update-armed.json').write_text(json.dumps(lease))\n    with patch('time.time', return_value=100), patch('os.kill', side_effect=None if alive else ProcessLookupError()), patch('subprocess.run') as run:\n        assert main() == 0\n        assert run.call_count == expected\n        if expected: assert run.call_args.args[0][-1] == 'false'\n`;
  expect(() =>
    execFileSync("/usr/bin/python3", ["-B", "-c", program], {
      env: f.environment,
      encoding: "utf8",
    }),
  ).not.toThrow();
});
it("accepts Sparkle's signed lower rollout choice only if offered and verified, without a five-minute restart loop", async () => {
  const f = await fixture();
  f.driver.availableVersions = vi.fn(async () => ["26.1200.1.0", "26.1200.0.9"]);
  vi.mocked(f.driver.downloadReady).mockImplementation(
    async (version) => version === "26.1200.0.9",
  );
  await f.manager.check();
  f.advance(10);
  await f.manager.tick();
  vi.mocked(f.driver.currentVersion).mockResolvedValue("26.1200.0.9.0");
  expect((await f.manager.tick()).phase).toBe("health-check");
  expect((await f.manager.tick()).phase).toBe("up-to-date");
  expect(f.manager.status().latestVersion).toBe("26.1200.1.0");
  expect(f.driver.reopen).toHaveBeenCalledOnce();
  f.advance(5 * 60_000);
  await f.manager.check();
  expect(f.driver.quit).toHaveBeenCalledOnce();
});
it.each([null, "broken", { defaulted: "bad", enabled: false, originalAutoUpdate: true }])(
  "damaged settings do not reacquire Hub's own preference as the original: %s",
  async (raw) => {
    const f = await fixture();
    const file = path.join(f.environment.CODEXHOST_DATA_DIR, "hub-desktop.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ codexUpdates: raw }));
    expect((await f.manager.check()).enabled).toBe(false);
    expect(f.driver.readAutoUpdate).not.toHaveBeenCalled();
  },
);

it("does not later reopen a Codex whose normal quit was cancelled or already relaunched", async () => {
  const f = await fixture();
  await f.manager.check();
  f.advance(10);
  await f.manager.tick();
  vi.mocked(f.driver.isRunning).mockResolvedValue(true);
  vi.mocked(f.driver.installationStopped).mockResolvedValue(false);
  f.advance(6 * 60_000);
  await f.manager.tick();
  vi.mocked(f.driver.isRunning).mockResolvedValue(false);
  vi.mocked(f.driver.installationStopped).mockResolvedValue(true);
  await f.manager.tick();
  expect(f.driver.reopen).not.toHaveBeenCalled();
});

it("persists lease and starts its independent watchdog before enabling automatic updates", async () => {
  const f = await fixture();
  const calls: string[] = [];
  vi.mocked(f.driver.watchLease).mockImplementation(async (file, id) => {
    const lease = JSON.parse(await fs.readFile(file, "utf8"));
    expect(lease).toMatchObject({ id, pid: process.pid });
    calls.push("watchdog-ready");
  });
  vi.mocked(f.driver.writeAutoUpdate).mockImplementation(async (value) => {
    if (value === true) calls.push("enabled");
  });
  await f.manager.check();
  f.advance(10);
  await f.manager.tick();
  expect(calls).toEqual(["watchdog-ready", "enabled"]);
});
it("does not enable updates or quit when the independent watchdog cannot start", async () => {
  const f = await fixture();
  vi.mocked(f.driver.watchLease).mockRejectedValue(new Error("unavailable"));
  await f.manager.check();
  f.advance(10);
  await f.manager.tick();
  expect(f.preference).not.toContain(true);
  expect(f.driver.quit).not.toHaveBeenCalled();
});
it("cancels when Sparkle's staged rollout choice disappears from the refreshed feed", async () => {
  const f = await fixture();
  const offered = vi.fn(async () => ["26.1200.1.0", "26.1200.0.9"]);
  f.driver.availableVersions = offered;
  vi.mocked(f.driver.downloadReady).mockImplementation(
    async (version) => version === "26.1200.0.9",
  );
  await f.manager.check();
  offered.mockResolvedValue(["26.1200.1.0"]);
  f.advance(10);
  expect((await f.manager.tick()).error).toBe("CODEX_UPDATE_TARGET_CHANGED");
  expect(f.driver.quit).not.toHaveBeenCalled();
});
it("the Mac watchdog process starter can be injected without spawning a process", async () => {
  const f = await fixture();
  const startWatchdog = vi.fn(async () => undefined);
  const driver = createMacCodexUpdateDriver({
    environment: f.environment,
    get: async () => response({}),
    currentVersion: f.driver.currentVersion,
    reopen: f.driver.reopen,
    healthy: f.driver.healthy,
    exec: vi.fn(async () => ""),
    startWatchdog,
  });
  await driver.watchLease("/synthetic/lease.json", "synthetic-id");
  expect(startWatchdog).toHaveBeenCalledWith("/synthetic/lease.json", "synthetic-id");
});
