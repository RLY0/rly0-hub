import {
  codexNativeUpdateControlAllowed,
  codexNativeUpdateControlBlocker,
  acquireCodexUpdateControl,
} from "../src/rly0-hub-service/codex-update-control.js";
import { restoreCodexCheckPreferences } from "../src/rly0-hub-service/codex-check-preferences.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexUpdateSettingsSchema,
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
import {
  parseLsappinfoBundlePath,
  readLauncherCodexBundle,
} from "../src/rly0-hub-service/codex-bundle-location.js";
import { createHubServiceShutdown } from "../src/rly0-hub-service/shutdown.js";
import { EventEmitter } from "node:events";
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
  // Like a real Desktop: running until a quit, running again once reopened.
  let running = true;
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
    quit: vi.fn(async () => {
      running = false;
    }),
    installationStopped: vi.fn(async () => true),
    isRunning: vi.fn(async () => running),
    reopen: vi.fn(async () => {
      running = true;
      return true;
    }),
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

/** Injected `ps -o lstart=` reader: no system command runs in tests. */
const probe = { processStart: async () => "Mon Nov  9 20:00:00 2026" };
/** Real `lsappinfo info -only bundlepath -app com.openai.codex` output shape (macOS 26, 2026-11-09). */
function lsappinfoOutput(bundle: string) {
  return [
    "[ NULL ]  ASN:0x0-0xd10d1: (in front) ",
    "    bundleID=[ NULL ] ",
    `    bundle path="${bundle}"`,
    "    executable path=[ NULL ] ",
    " !cgsConnection !signalled type=[ NULL ]  flavor=[ NULL ]  Version=[ NULL ]  Arch=!!none ",
    "",
  ].join("\n");
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
    // The quit went through (Codex is gone) but its reply was lost.
    if (failure === "lost quit reply")
      vi.mocked(f.driver.quit).mockImplementationOnce(async () => {
        vi.mocked(f.driver.isRunning).mockResolvedValue(false);
        throw new Error("lost reply");
      });
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
  const prefs = new Map<string, string>([
    ["SUEnableAutomaticChecks", "0"],
    ["SULastCheckTime", "2026-01-01 00:00:00 +0000"],
  ]);
  const exec = vi.fn(async (_file: string, args: string[]) => {
    const key = args[2] ?? "";
    if (args[0] === "read") {
      if (!prefs.has(key)) throw Object.assign(new Error("missing"), { stderr: "does not exist" });
      return prefs.get(key) ?? "";
    }
    if (args[0] === "delete") prefs.delete(key);
    if (args[0] === "write")
      prefs.set(key, args[4] === "true" ? "1" : args[4] === "false" ? "0" : (args[4] ?? ""));
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
  ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", false],
  ["/Applications/ChatGPT.app/Contents/Frameworks/Sparkle.framework/Autoupdate", false],
  ["/Applications/Codex Renamed.app/Contents/Frameworks/Sparkle.framework/Autoupdate", false],
  [
    "/Applications/ChatGPT.app/Contents/Frameworks/Sparkle.framework/Versions/B/Resources/Updater.app/Contents/MacOS/Updater",
    false,
  ],
])("scopes installer recovery to Codex processes: %s", async (processes, stopped) => {
  const f = await fixture();
  const bundle = processes.includes("/Codex Renamed.app/")
    ? "/Applications/Codex Renamed.app"
    : processes.includes("/Codex.app/")
      ? "/Applications/Codex.app"
      : "/Applications/ChatGPT.app";
  let quitSent = false;
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/lsappinfo") return quitSent ? "" : lsappinfoOutput(bundle);
    if (file === "/usr/bin/osascript") {
      if (args[1]?.includes(" to quit")) {
        quitSent = true;
        return "";
      }
      if (args[1]?.includes("is running"))
        return !quitSent ||
          /\/(?:Codex\.app\/Contents\/MacOS\/Codex|ChatGPT\.app\/Contents\/MacOS\/ChatGPT)$/u.test(
            processes,
          )
          ? "true"
          : "false";
    }
    return processes;
  });
  const driver = createMacCodexUpdateDriver({
    environment: f.environment,
    get: async () => response({}),
    currentVersion: f.driver.currentVersion,
    reopen: f.driver.reopen,
    healthy: f.driver.healthy,
    exec,
  });
  await driver.quit();
  expect(await driver.installationStopped()).toBe(stopped);
  expect(JSON.stringify(exec.mock.calls)).not.toContain("path to application");
  if (stopped) expect(exec).toHaveBeenCalledWith("/bin/ps", ["-axo", "args="]);
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

it("recognizes the installed bundle by id regardless of application filename", async () => {
  const f = await fixture();
  const exec = vi.fn(async () => "true");
  const driver = createMacCodexUpdateDriver({
    environment: f.environment,
    get: async () => response({}),
    currentVersion: f.driver.currentVersion,
    reopen: f.driver.reopen,
    healthy: f.driver.healthy,
    exec,
  });
  expect(await driver.isRunning()).toBe(true);
  expect(exec).toHaveBeenCalledWith("/usr/bin/osascript", [
    "-e",
    'application id "com.openai.codex" is running',
  ]);
  exec.mockResolvedValue("false");
  expect(await driver.isRunning()).toBe(false);
  exec.mockResolvedValue("unknown");
  await expect(driver.isRunning()).rejects.toThrow("CODEX_PROCESS_STATE_INVALID");
});
it.each([
  {},
  { RLY0_CODEX_UPDATE_CONTROL: "0" },
  { RLY0_HUB_MACOS_DEV_HOME: "1" },
  { CODEXHOST_DATA_DIR: "/synthetic/kit/data" },
  { HOME: "/synthetic/kit" },
  { NODE_ENV: "test" },
])("isolated native control is disabled: %j", async (overrides) => {
  const base = { HOME: "/synthetic/real", CODEXHOST_DATA_DIR: "/synthetic/real/.rly0-hub" };
  const env = Object.keys(overrides).length
    ? { ...base, ...overrides }
    : { HOME: "/synthetic/kit" };
  expect(codexNativeUpdateControlAllowed(env, "darwin", "/synthetic/real")).toBe(false);
});
it("allows production control only at the real default directory", () => {
  const env = { HOME: "/synthetic/real", CODEXHOST_DATA_DIR: "/synthetic/real/.rly0-hub" };
  expect(codexNativeUpdateControlAllowed(env, "darwin", "/synthetic/real")).toBe(true);
  expect(codexNativeUpdateControlAllowed(env, "win32", "/synthetic/real")).toBe(false);
});
it("reports why native control is unmounted, separating development/opt-out from production environment", async () => {
  const real = { HOME: "/synthetic/real", CODEXHOST_DATA_DIR: "/synthetic/real/.rly0-hub" };
  expect(codexNativeUpdateControlBlocker(real, "darwin", "/synthetic/real")).toBeNull();
  expect(codexNativeUpdateControlBlocker(real, "win32", "/synthetic/real")).toBe("platform");
  // The macOS shell's development mode injects RLY0_CODEX_UPDATE_CONTROL=0 with its own data dir.
  expect(
    codexNativeUpdateControlBlocker(
      {
        ...real,
        RLY0_CODEX_UPDATE_CONTROL: "0",
        CODEXHOST_DATA_DIR: "/synthetic/real/.rly0-hub-macos-dev/data",
      },
      "darwin",
      "/synthetic/real",
    ),
  ).toBe("control-disabled");
  expect(
    codexNativeUpdateControlBlocker({ ...real, NODE_ENV: "test" }, "darwin", "/synthetic/real"),
  ).toBe("control-disabled");
  // A production Hub whose data dir the person moved to an external volume.
  expect(
    codexNativeUpdateControlBlocker(
      { ...real, CODEXHOST_DATA_DIR: "/Volumes/RLY0Dev/.rly0-hub" },
      "darwin",
      "/synthetic/real",
    ),
  ).toBe("environment");
  const f = await fixture();
  const unmounted = new CodexUpdateManager({
    ...f.options,
    driver: null,
    unsupportedReason: "environment",
  });
  managers.push(unmounted);
  expect(await unmounted.check()).toMatchObject({
    supported: false,
    unsupportedReason: "environment",
  });
  expect(f.manager.status()).not.toHaveProperty("unsupportedReason");
  const mounted = new CodexUpdateManager({ ...f.options, unsupportedReason: "environment" });
  managers.push(mounted);
  expect(mounted.status()).not.toHaveProperty("unsupportedReason");
});
it("a damaged originalCheckPreferences preserves originalAutoUpdate and the selected management state", async () => {
  const f = await fixture();
  await f.state.update({
    codexUpdates: { defaulted: true, enabled: true, originalAutoUpdate: true },
  });
  const file = path.join(f.environment.CODEXHOST_DATA_DIR, "hub-desktop.json");
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  raw.codexUpdates.originalCheckPreferences = { automaticChecks: "broken", lastCheckTime: null };
  await fs.writeFile(file, JSON.stringify(raw));
  const saved = (await f.state.read()).codexUpdates;
  expect(saved).toMatchObject({ enabled: true, originalAutoUpdate: true });
  expect(codexUpdateSettingsSchema.parse(raw.codexUpdates).originalAutoUpdate).toBe(true);
  await f.manager.check();
  await f.manager.setEnabled(false);
  expect(f.preference.at(-1)).toBe(true);
  expect(f.driver.readAutoUpdate).not.toHaveBeenCalled();
});
it("a cancelled quit clears ownership within 30 seconds and cannot reopen a later user quit", async () => {
  const f = await fixture();
  await f.manager.check();
  f.advance(10);
  await f.manager.tick();
  vi.mocked(f.driver.isRunning).mockResolvedValue(true);
  vi.mocked(f.driver.installationStopped).mockResolvedValue(false);
  f.advance(30_000);
  expect((await f.manager.tick()).error).toBe("CODEX_INSTALL_TIMEOUT");
  vi.mocked(f.driver.isRunning).mockResolvedValue(false);
  vi.mocked(f.driver.installationStopped).mockResolvedValue(true);
  await f.manager.tick();
  expect(f.driver.reopen).not.toHaveBeenCalled();
  await expect(
    fs.stat(path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-session.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["old", "new-heartbeat"])("ignores unsafe crash recovery records: %s", async (reason) => {
  const f = await fixture();
  await fs.mkdir(f.environment.CODEXHOST_DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-session.json"),
    JSON.stringify({ target: "26.1200.1", at: 500, closedByHub: true }),
  );
  if (reason === "old") f.advance(6 * 60_000);
  else
    await fs.writeFile(
      path.join(f.environment.CODEXHOST_DATA_DIR, "codex-heartbeat.json"),
      JSON.stringify({ at: 900, pid: 123, busy: false }),
    );
  await f.manager.check();
  expect(f.driver.reopen).not.toHaveBeenCalled();
});
it("uses a replaceable idle driver for every quit check without changing the default idle definition", async () => {
  const f = await fixture();
  const idle = vi.fn(async () => false);
  const manager = new CodexUpdateManager({ ...f.options, idle });
  managers.push(manager);
  await manager.check();
  f.advance(30_000);
  await manager.tick();
  expect(f.busy).not.toHaveBeenCalled();
  expect(f.driver.quit).not.toHaveBeenCalled();
  idle.mockResolvedValue(true);
  await manager.tick();
  f.advance(10);
  await manager.tick();
  expect(f.driver.quit).toHaveBeenCalledOnce();
  expect(idle.mock.calls.length).toBeGreaterThanOrEqual(4);
});
it("the native control lock prevents two Hubs sharing a directory from taking ownership", async () => {
  const f = await fixture();
  const release = await acquireCodexUpdateControl(f.environment.CODEXHOST_DATA_DIR, probe);
  try {
    await expect(
      acquireCodexUpdateControl(f.environment.CODEXHOST_DATA_DIR, probe),
    ).rejects.toThrow("CODEX_UPDATE_OWNER_BUSY");
  } finally {
    await release();
  }
  await (
    await acquireCodexUpdateControl(f.environment.CODEXHOST_DATA_DIR, probe)
  )();
});
it("preserves Sparkle's newer check date, restoring only Hub-written values", async () => {
  const write = vi.fn(async () => undefined);
  await restoreCodexCheckPreferences(
    { automaticChecks: false, lastCheckTime: "old" },
    async (key) => (key === "SULastCheckTime" ? "newer-sparkle-date" : "1"),
    write,
  );
  expect(write.mock.calls).toEqual([["SUEnableAutomaticChecks", false]]);
});
it("unknown appcast enclosures fail closed, including build-only entries selected by Sparkle", () => {
  expect(() =>
    parseCodexAppcast(
      '<rss><item><sparkle:version>999999</sparkle:version><enclosure url="https://example.test/build"/></item></rss>',
    ),
  ).toThrow("CODEX_APPCAST_FAILED");
  expect(
    parseCodexAppcast(
      "<rss><item><sparkle:shortVersionString>26.1200.1</sparkle:shortVersionString><sparkle:minimumSystemVersion>99.0</sparkle:minimumSystemVersion><enclosure/></item></rss>",
      "15.0",
    ),
  ).toEqual([]);
});
it("watchdog exit resets arming so an active download gets a new worker", async () => {
  const f = await fixture();
  let exited: (() => void) | undefined;
  vi.mocked(f.driver.watchLease).mockImplementation(async (_file, _id, onExit) => {
    exited = onExit;
  });
  await backgroundRestart(f);
  expect(f.driver.watchLease).toHaveBeenCalledOnce();
  exited?.();
  await f.manager.tick();
  expect(f.driver.watchLease).toHaveBeenCalledTimes(2);
});
it("three download timeouts persist across restarts and suspend retries until the feed changes", async () => {
  const f = await fixture();
  let feed = "synthetic-feed-a";
  f.driver.feedIdentity = () => feed;
  for (let attempt = 0; attempt < 3; attempt++) {
    await backgroundRestart(f);
    f.advance(31 * 60_000);
    await f.manager.tick();
    f.advance(25 * 60 * 60_000);
  }
  const count = vi.mocked(f.driver.quit).mock.calls.length;
  const restarted = new CodexUpdateManager(f.options);
  managers.push(restarted);
  expect((await restarted.check()).error).toBe("CODEX_DOWNLOAD_TIMEOUT");
  f.advance(25 * 60 * 60_000);
  await restarted.check();
  expect(f.driver.quit).toHaveBeenCalledTimes(count);
  feed = "synthetic-feed-b";
  expect((await restarted.check()).phase).toBe("waiting-idle");
});
it("reenabling during backoff reports a terminal retry state instead of checking forever", async () => {
  const f = await fixture();
  await backgroundRestart(f);
  f.advance(31 * 60_000);
  await f.manager.tick();
  await f.manager.setEnabled(false);
  expect((await f.manager.setEnabled(true)).phase).toBe("failed");
});
it("renews the lease independently while compatibility refresh blocks the serialized queue", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let release: (() => void) | undefined;
  try {
    await backgroundRestart(f);
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.catalog, "refresh").mockImplementationOnce(async () => {
      entered?.();
      await blocked;
    });
    const check = f.manager.check();
    await started;
    f.advance(400_000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(async () => {
      const lease = JSON.parse(
        await fs.readFile(
          path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-armed.json"),
          "utf8",
        ),
      );
      expect(lease.at).toBe(401_010);
    });
    release?.();
    await check;
    await f.manager.stop();
  } finally {
    release?.();
    vi.useRealTimers();
  }
});
it("an OS-ineligible feed maximum remains visible without causing a restart", async () => {
  const f = await fixture();
  f.driver.installableVersions = () => ["26.1103.1.0"];
  expect((await f.manager.check()).phase).toBe("up-to-date");
  expect(f.manager.status().latestVersion).toBe("26.1200.1.0");
  expect(f.driver.quit).not.toHaveBeenCalled();
});
it("recognizes a successful Sparkle relaunch instead of treating it as a cancelled quit", async () => {
  const f = await fixture();
  await f.manager.check();
  f.advance(10);
  await f.manager.tick();
  f.install();
  vi.mocked(f.driver.isRunning).mockResolvedValue(true);
  vi.mocked(f.driver.installationStopped).mockResolvedValue(false);
  f.advance(30_000);
  expect((await f.manager.tick()).phase).toBe("health-check");
  expect(f.driver.reopen).not.toHaveBeenCalled();
});
it("short repeated idle races reuse a fresh forced signature verification", async () => {
  const f = await fixture();
  const app = path.join(
    f.root,
    "Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/Installation/synthetic/ChatGPT.app",
  );
  await fs.mkdir(app, { recursive: true });
  const exec = vi.fn(async (file: string, args: string[]) =>
    file === "/usr/bin/plutil"
      ? args.includes("CFBundleIdentifier")
        ? "com.openai.codex"
        : "26.1200.1.0"
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
  expect(await driver.downloadReady("26.1200.1.0", true)).toBe(true);
  expect(await driver.downloadReady("26.1200.1.0", true)).toBe(true);
  expect(exec.mock.calls.filter(([file]) => file === "/usr/bin/codesign")).toHaveLength(1);
});

it("reclaims an exited owner's native lock while admitting only one concurrent successor", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  const f = await fixture();
  await fs.mkdir(f.environment.CODEXHOST_DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-owner.json"),
    JSON.stringify({ id: "synthetic-dead", pid: child.pid }),
  );
  const results = await Promise.allSettled([
    acquireCodexUpdateControl(f.environment.CODEXHOST_DATA_DIR, probe),
    acquireCodexUpdateControl(f.environment.CODEXHOST_DATA_DIR, probe),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  for (const result of results) if (result.status === "fulfilled") await result.value();
});

describe("review #3 fixes (synthetic commands only)", () => {
  it("parses both lsappinfo bundle path forms and rejects non-bundle output", () => {
    expect(parseLsappinfoBundlePath(lsappinfoOutput("/Applications/ChatGPT.app"))).toBe(
      "/Applications/ChatGPT.app",
    );
    expect(parseLsappinfoBundlePath('"LSBundlePath"="/Applications/Codex Renamed.app"\n')).toBe(
      "/Applications/Codex Renamed.app",
    );
    expect(parseLsappinfoBundlePath("")).toBeNull();
    expect(parseLsappinfoBundlePath('bundle path="relative/ChatGPT.app"')).toBeNull();
    expect(parseLsappinfoBundlePath('bundle path="/Applications/ChatGPT"')).toBeNull();
  });

  it("falls back to the Launcher's newest recorded bundle, and refuses to quit without one", async () => {
    const f = await fixture();
    const exec = vi.fn(async (file: string, args: string[]): Promise<string> => {
      if (file === "/usr/bin/lsappinfo") return ""; // lsappinfo prints nothing for no match
      if (file === "/usr/bin/osascript") return args[1]?.includes(" to quit") ? "" : "false";
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
    await expect(driver.quit()).rejects.toThrow("CODEX_INSTALLATION_UNAVAILABLE");
    expect(exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
    await expect(driver.installationStopped()).rejects.toThrow("CODEX_INSTALLATION_UNAVAILABLE");
    const diagnostics = path.join(f.environment.CODEXHOST_DATA_DIR, "diagnostics");
    await fs.mkdir(diagnostics, { recursive: true });
    const record = (startedAtMs: number, installRoot: string, version: string) => ({
      id: `${startedAtMs}-4242`,
      pid: 4242,
      launcherVersion: "0.11.40",
      startedAtMs,
      finishedAtMs: startedAtMs + 900,
      outcome: "ready",
      error: null,
      stages: [{ name: "desktop-discovered", elapsedMs: 120 }],
      desktop: { version, build: "2120", installRoot },
    });
    await fs.writeFile(
      path.join(diagnostics, "launcher-startup-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [
          record(1762700000000, "/Applications/Codex Renamed.app", "26.1200.1"),
          record(1762600000000, "/Applications/ChatGPT.app", "26.1103.1"),
        ],
      }),
    );
    expect(await readLauncherCodexBundle(f.environment)).toBe("/Applications/Codex Renamed.app");
    exec.mockImplementation(async (file: string, args: string[]) => {
      if (file === "/usr/bin/osascript") return args[1]?.includes(" to quit") ? "" : "false";
      if (file === "/bin/ps")
        return "/Applications/Codex Renamed.app/Contents/Frameworks/Sparkle.framework/Autoupdate";
      return "";
    });
    expect(await driver.installationStopped()).toBe(false);
    expect(JSON.stringify(exec.mock.calls)).not.toContain("path to application");
  });

  it("treats an empty lsappinfo answer as not running; only a failing lsappinfo uses the Launcher record", async () => {
    const f = await fixture();
    const diagnostics = path.join(f.environment.CODEXHOST_DATA_DIR, "diagnostics");
    await fs.mkdir(diagnostics, { recursive: true });
    await fs.writeFile(
      path.join(diagnostics, "launcher-startup-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            id: "1762700000000-4242",
            pid: 4242,
            launcherVersion: "0.11.40",
            startedAtMs: 1762700000000,
            finishedAtMs: 1762700000900,
            outcome: "ready",
            error: null,
            stages: [],
            desktop: {
              version: "26.1103.1",
              build: "2120",
              installRoot: "/Applications/ChatGPT.app",
            },
          },
        ],
      }),
    );
    let lsappinfoFails = false;
    const exec = vi.fn(async (file: string, args: string[]): Promise<string> => {
      if (file === "/usr/bin/lsappinfo") {
        if (lsappinfoFails) throw new Error("lsappinfo unavailable");
        return "";
      }
      if (file === "/usr/bin/osascript") return args[1]?.includes(" to quit") ? "" : "true";
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
    await expect(driver.quit()).rejects.toThrow("CODEX_INSTALLATION_UNAVAILABLE");
    expect(exec.mock.calls.some(([, args]) => String(args).includes(" to quit"))).toBe(false);
    lsappinfoFails = true;
    await driver.quit();
    expect(exec.mock.calls.some(([, args]) => String(args).includes(" to quit"))).toBe(true);
  });

  it("a complete background-check + install cycle never issues a launching query", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, "Library/Application Support/com.openai.codex"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        f.root,
        "Library/Application Support/com.openai.codex/production-appcast-bootstrap.json",
      ),
      JSON.stringify({ installationId: "synthetic-installation" }),
    );
    const xml =
      '<rss><channel><item><title>26.1200.1</title><sparkle:version>2120</sparkle:version><sparkle:shortVersionString>26.1200.1</sparkle:shortVersionString><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><enclosure url="https://example.test/Codex-26.1200.1.zip" length="1" type="application/octet-stream"/></item></channel></rss>';
    const staged = path.join(
      f.root,
      "Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/Installation/synthetic/ChatGPT.app",
    );
    const prefs = new Map<string, string>([["SUAutomaticallyUpdate", "0"]]);
    let running = true;
    let installed = "26.1103.1.0";
    let reopens = 0;
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (file === "/usr/bin/defaults") {
        const key = args[2] ?? "";
        if (args[0] === "read") {
          if (!prefs.has(key))
            throw Object.assign(new Error("missing"), { stderr: "does not exist" });
          return prefs.get(key) ?? "";
        }
        if (args[0] === "delete") prefs.delete(key);
        if (args[0] === "write")
          prefs.set(key, args[4] === "true" ? "1" : args[4] === "false" ? "0" : (args[4] ?? ""));
        return "";
      }
      if (file === "/usr/bin/lsappinfo")
        return running ? lsappinfoOutput("/Applications/ChatGPT.app") : "";
      if (file === "/usr/bin/osascript") {
        if (args[1]?.includes(" to quit")) {
          running = false;
          // Sparkle installs a staged update when the app quits with automatic installs on.
          if (
            prefs.get("SUAutomaticallyUpdate") === "1" &&
            (await fs.stat(staged).catch(() => null))
          )
            installed = "26.1200.1.0";
          return "";
        }
        return running ? "true" : "false";
      }
      if (file === "/bin/ps") return args[0] === "-o" ? "Mon Nov  9 20:00:00 2026" : "";
      if (file === "/usr/bin/sw_vers") return "15.5";
      if (file === "/usr/bin/plutil")
        return args.includes("CFBundleIdentifier") ? "com.openai.codex" : "26.1200.1";
      if (file === "/usr/bin/codesign") return "";
      throw new Error(`unexpected command ${file}`);
    });
    const driver = createMacCodexUpdateDriver({
      environment: f.environment,
      get: async () => async () => ({
        status: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from(xml);
        })(),
        cancel() {},
      }),
      currentVersion: async () => installed,
      reopen: async () => {
        running = true;
        reopens += 1;
        // The first reopen runs Sparkle's scheduled background check, which stages the update.
        if (reopens === 1) await fs.mkdir(staged, { recursive: true });
        return true;
      },
      healthy: async () => true,
      exec,
      startWatchdog: async () => undefined,
    });
    const manager = new CodexUpdateManager({ ...f.options, driver });
    managers.push(manager);
    // The driver throttles failed staging probes by wall clock; advance it with the manager clock.
    let wall = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => wall);
    const phases: string[] = [];
    try {
      await manager.check();
      for (let step = 0; step < 40 && manager.status().phase !== "up-to-date"; step++) {
        f.advance(31_000);
        wall += 31_000;
        phases.push((await manager.tick()).phase);
      }
    } finally {
      clock.mockRestore();
    }
    expect(manager.status()).toMatchObject({ phase: "up-to-date", error: null });
    expect(installed).toBe("26.1200.1.0");
    expect(phases).toContain("downloading");
    expect(reopens).toBe(2);
    const commands = exec.mock.calls.map(([file, args]) => `${file} ${args.join(" ")}`);
    expect(commands.join("\n")).not.toContain("path to application");
    for (const command of commands.filter((line) => line.includes("tell application")))
      expect(command).toContain('if application id "com.openai.codex" is running then tell');
    expect(commands.filter((line) => line.startsWith("/usr/bin/lsappinfo")).length).toBe(2);
    expect(prefs.get("SUAutomaticallyUpdate")).toBe("0");
  });

  it("a late exit from an earlier lease's watchdog does not disarm the current lease", async () => {
    const f = await fixture();
    const exits: (() => void)[] = [];
    vi.mocked(f.driver.watchLease).mockImplementation(async (_file, _id, onExit) => {
      if (onExit) exits.push(onExit);
    });
    await backgroundRestart(f);
    exits[0]?.(); // current lease's watchdog exits: re-arm with a new lease
    await f.manager.tick();
    expect(f.driver.watchLease).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(f.driver.watchLease).mock.calls.map(([, id]) => id);
    expect(first).not.toBe(second);
    exits[0]?.(); // the old worker's duplicate/late exit
    await f.manager.tick();
    expect(f.driver.watchLease).toHaveBeenCalledTimes(2);
    exits[1]?.();
    await f.manager.tick();
    expect(f.driver.watchLease).toHaveBeenCalledTimes(3);
  });

  it("treats a reused owner PID (different start time), EPERM and this PID with a foreign id as stale", async () => {
    const f = await fixture();
    const directory = f.environment.CODEXHOST_DATA_DIR;
    const owner = path.join(directory, "codex-update-owner.json");
    await fs.mkdir(directory, { recursive: true });
    const write = (value: unknown) => fs.writeFile(owner, JSON.stringify(value));
    const started = new Map<number, string>([
      [4242, "Mon Nov  9 21:15:02 2026"],
      [process.pid, "Mon Nov  9 21:30:00 2026"],
    ]);
    const alive = {
      processStart: async (pid: number) => started.get(pid) ?? null,
      signal: () => undefined,
    };
    // Same PID, recorded start time differs: the PID was reused.
    await write({ id: "old-hub", pid: 4242, startedAt: "Mon Nov  9 08:00:00 2026" });
    await (
      await acquireCodexUpdateControl(directory, alive)
    )();
    // Same PID and same start time: still the owner.
    await write({ id: "live-hub", pid: 4242, startedAt: "Mon Nov  9 21:15:02 2026" });
    await expect(acquireCodexUpdateControl(directory, alive)).rejects.toThrow(
      "CODEX_UPDATE_OWNER_BUSY",
    );
    // Unreadable start time is not proof of reuse.
    await expect(
      acquireCodexUpdateControl(directory, { ...alive, processStart: async () => null }),
    ).rejects.toThrow("CODEX_UPDATE_OWNER_BUSY");
    // A root process now owns the PID: EPERM is stale, not a permanent failure.
    const eperm = {
      ...alive,
      signal: () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    };
    await (
      await acquireCodexUpdateControl(directory, eperm)
    )();
    // This process's own PID with an id it does not hold came from an earlier process.
    await write({ id: "previous-hub", pid: process.pid, startedAt: "Mon Nov  9 08:00:00 2026" });
    const release = await acquireCodexUpdateControl(directory, alive);
    expect(JSON.parse(await fs.readFile(owner, "utf8"))).toMatchObject({
      pid: process.pid,
      startedAt: "Mon Nov  9 21:30:00 2026",
    });
    // ...but an id this process holds is a live owner.
    await expect(acquireCodexUpdateControl(directory, alive)).rejects.toThrow(
      "CODEX_UPDATE_OWNER_BUSY",
    );
    await release();
    await expect(fs.stat(owner)).rejects.toMatchObject({ code: "ENOENT" });
    // Other probe failures still surface instead of evicting an owner.
    await write({ id: "live-hub", pid: 4242, startedAt: "Mon Nov  9 21:15:02 2026" });
    await expect(
      acquireCodexUpdateControl(directory, {
        ...alive,
        signal: () => {
          throw Object.assign(new Error("synthetic"), { code: "EINVAL" });
        },
      }),
    ).rejects.toThrow("synthetic");
  });

  it("SIGTERM disposes the service once, releasing the native control lock before exit", async () => {
    const f = await fixture();
    const directory = f.environment.CODEXHOST_DATA_DIR;
    const manager = new CodexUpdateManager({
      ...f.options,
      driver: { ...f.driver, acquireControl: () => acquireCodexUpdateControl(directory, probe) },
    });
    managers.push(manager);
    await manager.check();
    const owner = path.join(directory, "codex-update-owner.json");
    expect(JSON.parse(await fs.readFile(owner, "utf8"))).toMatchObject({ pid: process.pid });
    const signals = new EventEmitter();
    const dispose = vi.fn(() => manager.stop());
    const exited = new Promise<number>((resolve) => {
      const shutdown = createHubServiceShutdown({
        dispose,
        exit: resolve,
        signals: signals as unknown as Pick<NodeJS.Process, "once">,
      });
      signals.emit("SIGTERM");
      void shutdown(); // stdin EOF racing the signal shares the same disposal
    });
    expect(await exited).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    await expect(fs.stat(owner)).rejects.toMatchObject({ code: "ENOENT" });
    expect(signals.listenerCount("SIGINT")).toBe(1);
  });

  it("a stuck disposal still exits, with a failure code", async () => {
    const signals = new EventEmitter();
    const code = await new Promise<number>((resolve) => {
      createHubServiceShutdown({
        dispose: () => new Promise<void>(() => undefined),
        exit: resolve,
        signals: signals as unknown as Pick<NodeJS.Process, "once">,
        timeoutMs: 20,
      });
      signals.emit("SIGINT");
    });
    expect(code).toBe(1);
  });
});
