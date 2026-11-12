import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexCompatibilityCatalog } from "../src/rly0-hub-service/codex-compat.js";
import { CodexUpdateManager } from "../src/rly0-hub-service/codex-update-manager.js";
import { createMacCodexUpdateDriver } from "../src/rly0-hub-service/codex-sparkle.js";
import { Rly0HubStateStore } from "../src/rly0-hub-service/hub-state.js";
import {
  disarmCodexUpdateLease,
  runCodexUpdateWatchdog,
} from "../src/rly0-hub-service/codex-update-watchdog.js";
import type { UpdateHttpGet } from "../src/rly0-hub-service/hub-update-net.js";
import { codexPreferences } from "../src/rly0-hub-service/codex-check-preferences.js";

const roots: string[] = [];
const managers: CodexUpdateManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
// Synthetic build numbers; production appcast element/attribute shapes and macOS 27 errors.
const item = (version = "26.1106.51428", build = "30001") =>
  `<item><sparkle:version>${build}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><enclosure url="https://example.test/Codex.zip" length="1" type="application/octet-stream"/></item>`;
const http =
  (body: string): UpdateHttpGet =>
  async () => ({
    status: 200,
    headers: {},
    body: (async function* () {
      yield Buffer.from(body);
    })(),
    cancel() {},
  });
async function fixture(original: string | null = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-codex-alert-"));
  roots.push(root);
  const environment = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CODEXHOST_DATA_DIR: path.join(root, "hub"),
    RLY0_MEMORY_DIR: path.join(root, "memory"),
    RLY0_SKIP_LEGACY_IMPORT: "1",
    RLY0_CODEX_UPDATE_CONTROL: "0",
  };
  const bootstrap = path.join(root, "Library/Application Support/com.openai.codex");
  await fs.mkdir(bootstrap, { recursive: true });
  await fs.writeFile(
    path.join(bootstrap, "production-appcast-bootstrap.json"),
    JSON.stringify({ installationId: "synthetic-installation" }),
  );
  const prefs = new Map([
    ["SUAutomaticallyUpdate", "1"],
    ["SUEnableAutomaticChecks", "1"],
    ["SULastCheckTime", "2026-11-10 12:00:00 +0000"],
    ["CodexSparkleSeenUpdateVersions", '("25000", "26000")'],
  ]);
  const types = new Map([
    ["SUAutomaticallyUpdate", "boolean"],
    ["SUEnableAutomaticChecks", "boolean"],
    ["SULastCheckTime", "date"],
    ["CodexSparkleSeenUpdateVersions", "array"],
  ]);
  if (original !== null) prefs.set("SUSkippedVersion", original);
  let failWrite: string | null = null;
  let failRead: string | null = null;
  let loseWriteReply = false;
  let running = true;
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/defaults") {
      const [action, domain, key = ""] = args;
      expect(domain).toBe("com.openai.codex");
      if (action !== "write" && !prefs.has(key))
        throw Object.assign(new Error("synthetic missing"), {
          stderr: `Error: Could not find key '${key}' in domain '${domain}'.\n`,
        });
      if ((action === "read" || action === "read-type") && key === failRead)
        throw new Error("synthetic preferences unavailable");
      if (action === "read") return `${prefs.get(key) ?? ""}\n`;
      if (action === "read-type") return `Type is ${types.get(key) ?? "string"}\n`;
      if (key === failWrite) throw new Error("synthetic permission denied");
      if (action === "delete") {
        prefs.delete(key);
        types.delete(key);
      } else if (action === "write") {
        prefs.set(key, args[3] === "-bool" ? (args[4] === "true" ? "1" : "0") : (args[4] ?? ""));
        types.set(
          key,
          args[3] === "-bool"
            ? "boolean"
            : args[3] === "-int"
              ? "integer"
              : args[3] === "-date"
                ? "date"
                : "string",
        );
      } else throw new Error(`unexpected defaults operation ${action}`);
      if (key === "SUSkippedVersion" && loseWriteReply)
        throw new Error("synthetic lost write reply");
      return "";
    }
    if (file === "/usr/bin/sw_vers") return "27.2";
    if (file === "/usr/bin/env") return "Wed Nov 11 09:00:00 2026";
    if (file === "/usr/bin/lsappinfo") return '    bundle path="/Applications/ChatGPT.app"';
    if (file === "/usr/bin/osascript") {
      if (args[1]?.includes(" to quit")) {
        running = false;
        return "";
      }
      return running ? "true" : "false";
    }
    if (file === "/bin/ps") return "";
    if (file === "/usr/bin/plutil" && args.includes("CFBundleVersion")) return "25894";
    throw new Error(`unexpected system command ${file}`);
  });
  let xml = `<rss><channel>${item()}</channel></rss>`;
  let feedStatus = 200;
  const feedGet = vi.fn<UpdateHttpGet>(async (...args) => ({
    ...(await http(xml)(...args)),
    status: feedStatus,
  }));
  const verified: { family: string; minHub: string }[] = [];
  const state = new Rly0HubStateStore(environment);
  const catalog = new CodexCompatibilityCatalog({
    environment,
    installRoot: root,
    hubVersion: "0.11.40",
    get: async () =>
      http(
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: "2026-11-11T00:00:00Z",
          verified,
          disabled: [],
        }),
      ),
  });
  let now = 100_000;
  const startWatchdog = vi.fn(async () => undefined);
  const driver = createMacCodexUpdateDriver({
    environment,
    get: async () => feedGet,
    currentVersion: async () => "26.1103.60933",
    reopen: async () => {
      running = true;
      return true;
    },
    healthy: async () => true,
    exec,
    startWatchdog,
  });
  const options = {
    environment,
    state,
    catalog,
    driver,
    busy: async () => false,
    now: () => now,
    idleMs: 10,
    downloadTimeoutMs: 30 * 60_000,
  };
  const manager = new CodexUpdateManager(options);
  managers.push(manager);
  return {
    root,
    environment,
    prefs,
    types,
    exec,
    driver,
    manager,
    options,
    catalog,
    state,
    startWatchdog,
    feedGet,
    advance: (ms = 10) => {
      now += ms;
    },
    allow: () => {
      verified.push({ family: "26.1106", minHub: "0.11.40" });
    },
    feed: (value: string) => {
      xml = value;
    },
    feedStatus: (value: number) => {
      feedStatus = value;
    },
    denyRead: (key: string | null) => {
      failRead = key;
    },
    denyWrite: (key: string | null) => {
      failWrite = key;
    },
    loseReply: (value: boolean) => {
      loseWriteReply = value;
    },
  };
}

const journal = (f: Awaited<ReturnType<typeof fixture>>) =>
  path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-skipped-version.json");
const policy = async (f: Awaited<ReturnType<typeof fixture>>) =>
  JSON.parse(
    await fs.readFile(
      path.join(f.environment.CODEXHOST_DATA_DIR, "codex-renderer-policy.json"),
      "utf8",
    ),
  ) as { holdUpdates: boolean };

it("writes the feed build as a string while held, preserving the user's other skip/seen records", async () => {
  const f = await fixture("25000");
  expect((await f.manager.check()).phase).toBe("waiting-compatibility");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  expect(f.exec.mock.calls).toContainEqual([
    "/usr/bin/defaults",
    ["write", "com.openai.codex", "SUSkippedVersion", "-string", "30001"],
  ]);
  expect(f.exec.mock.calls.some(([, args]) => /Major|Seen/.test(args[2] ?? ""))).toBe(false);
  expect(f.prefs.get("SUAutomaticallyUpdate")).toBe("0");
  expect(f.startWatchdog).not.toHaveBeenCalled();
});

it.each([null, "25000"])(
  "restores the original skip %s when management is disabled",
  async (original) => {
    const f = await fixture(original);
    await f.manager.check();
    expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
    expect(await f.manager.setEnabled(false)).toMatchObject({
      enabled: false,
      phase: "disabled",
      error: null,
    });
    expect(f.prefs.get("SUSkippedVersion") ?? null).toBe(original);
    expect(f.prefs.get("SUAutomaticallyUpdate")).toBe("1");
  },
);

it("unskips only at idle release, before watchdog ready, renderer hold=false, downloads or normal quit", async () => {
  const f = await fixture("25000");
  await f.manager.check();
  f.allow();
  expect((await f.manager.check()).phase).toBe("waiting-idle");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  expect((await policy(f)).holdUpdates).toBe(true);
  f.startWatchdog.mockImplementation(async () => {
    expect(f.prefs.get("SUSkippedVersion")).toBe("25000");
    await expect(fs.stat(journal(f))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.prefs.get("SUAutomaticallyUpdate")).toBe("0");
    expect((await policy(f)).holdUpdates).toBe(true);
  });
  f.advance();
  expect((await f.manager.tick()).phase).toBe("installing");
  expect(f.startWatchdog).toHaveBeenCalledOnce();
  expect(f.prefs.get("SUAutomaticallyUpdate")).toBe("1");
  expect((await policy(f)).holdUpdates).toBe(false);
  expect(f.exec.mock.calls).toContainEqual([
    "/usr/bin/defaults",
    ["delete", "com.openai.codex", "SULastCheckTime"],
  ]);
  expect(
    f.exec.mock.calls.some(
      ([file, args]) => file === "/usr/bin/osascript" && args[1]?.includes(" to quit"),
    ),
  ).toBe(true);
});

it.each(["release", "disable"])(
  "a failed unskip keeps management held and retryable during %s",
  async (action) => {
    const f = await fixture();
    await f.manager.check();
    f.denyWrite("SUSkippedVersion");
    if (action === "release") {
      f.allow();
      await f.manager.check();
      f.advance();
    }
    const result =
      action === "release" ? await f.manager.tick() : await f.manager.setEnabled(false);
    expect(result).toMatchObject({
      phase: "failed",
      enabled: true,
      error: "CODEX_PREFERENCES_FAILED",
    });
    expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
    expect(f.prefs.get("SUAutomaticallyUpdate")).toBe("0");
    expect((await policy(f)).holdUpdates).toBe(true);
    expect(f.startWatchdog).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
    expect(JSON.parse(await fs.readFile(journal(f), "utf8"))).toMatchObject({
      original: null,
      written: "30001",
    });
    f.denyWrite(null);
    expect((await f.manager.setEnabled(false)).phase).toBe("disabled");
    expect(f.prefs.has("SUSkippedVersion")).toBe(false);
  },
);

it.each([null, "29999", "45000"])(
  "preserves a subsequent user skip/delete %s when disabled",
  async (changed) => {
    const f = await fixture("25000");
    await f.manager.check();
    if (changed === null) f.prefs.delete("SUSkippedVersion");
    else f.prefs.set("SUSkippedVersion", changed);
    f.exec.mockClear();
    await f.manager.setEnabled(false);
    expect(f.prefs.get("SUSkippedVersion") ?? null).toBe(changed);
    expect(
      f.exec.mock.calls.some(
        ([, args]) => ["write", "delete"].includes(args[0] ?? "") && args[2] === "SUSkippedVersion",
      ),
    ).toBe(false);
  },
);

it.each(["30001", "45000"])(
  "never claims or weakens a pre-existing user skip %s",
  async (original) => {
    const f = await fixture(original);
    expect((await f.manager.check()).phase).toBe("waiting-compatibility");
    await expect(fs.stat(journal(f))).rejects.toMatchObject({ code: "ENOENT" });
    f.allow();
    expect(await f.manager.check()).toMatchObject({
      phase: "user-skipped",
      userSkippedVersion: "26.1106.51428",
      error: null,
    });
    f.advance();
    expect((await f.manager.tick()).phase).toBe("user-skipped");
    expect(f.startWatchdog).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
    expect(f.prefs.get("SUSkippedVersion")).toBe(original);
    expect(
      f.exec.mock.calls.some(
        ([, args]) => ["write", "delete"].includes(args[0] ?? "") && args[2] === "SUSkippedVersion",
      ),
    ).toBe(false);
  },
);

it("updates the held build across feed changes without forgetting the first original", async () => {
  const f = await fixture("25000");
  await f.manager.check();
  f.feed(`<rss>${item("26.1106.60000", "30002")}</rss>`);
  await f.manager.check();
  expect(f.prefs.get("SUSkippedVersion")).toBe("30002");
  expect(JSON.parse(await fs.readFile(journal(f), "utf8"))).toEqual({
    schemaVersion: 1,
    original: "25000",
    written: "30002",
  });
  await f.manager.setEnabled(false);
  expect(f.prefs.get("SUSkippedVersion")).toBe("25000");
});

it("uses the greatest newer build across candidates, including an already verified candidate", async () => {
  const f = await fixture();
  f.allow();
  f.feed(`<rss>${item("26.1200.1", "31000")}${item("26.1106.1", "40000")}</rss>`);
  expect(await f.manager.check()).toMatchObject({
    phase: "waiting-compatibility",
    latestVersion: "26.1200.1",
  });
  expect(f.prefs.get("SUSkippedVersion")).toBe("40000");
});

it("refreshes suppression during update backoff without enabling downloads or quitting", async () => {
  const f = await fixture("25000");
  await fs.mkdir(f.environment.CODEXHOST_DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-attempt.json"),
    JSON.stringify({
      retryAt: 200_000,
      failures: 1,
      timeouts: 1,
      phase: "failed",
      error: "CODEX_DOWNLOAD_TIMEOUT",
    }),
  );
  expect(await f.manager.check()).toMatchObject({
    phase: "failed",
    error: "CODEX_DOWNLOAD_TIMEOUT",
  });
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  f.feed(`<rss>${item("26.1106.60000", "30002")}</rss>`);
  await f.manager.check();
  expect(f.prefs.get("SUSkippedVersion")).toBe("30002");
  expect(f.startWatchdog).not.toHaveBeenCalled();
  expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
});

it("refreshes suppression while waiting for a busy user and returns to compatibility wait for a new unknown version", async () => {
  const f = await fixture();
  await f.manager.check();
  f.allow();
  f.options.busy = async () => true;
  expect((await f.manager.check()).phase).toBe("waiting-idle");
  f.feed(`<rss>${item("26.1200.1", "30002")}${item()}</rss>`);
  expect(await f.manager.check()).toMatchObject({
    phase: "waiting-compatibility",
    latestVersion: "26.1200.1",
  });
  expect(f.prefs.get("SUSkippedVersion")).toBe("30002");
  expect(f.startWatchdog).not.toHaveBeenCalled();
  expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
});

it("parses enclosure build attributes rather than substituting the display version", async () => {
  const f = await fixture();
  f.feed(
    '<rss><item><enclosure sparkle:version="30009" sparkle:shortVersionString="26.1106.2" url="https://example.test/Codex.zip"/></item></rss>',
  );
  await f.manager.check();
  expect(f.prefs.get("SUSkippedVersion")).toBe("30009");
});

it.each(["", "bad-build"])(
  "fails closed when a blocked feed has unusable build %s",
  async (build) => {
    const f = await fixture("25000");
    f.feed(`<rss>${item("26.1106.1", build)}</rss>`);
    expect(await f.manager.check()).toMatchObject({
      phase: "failed",
      error: "CODEX_APPCAST_FAILED",
    });
    expect(f.prefs.get("SUSkippedVersion")).toBe("25000");
    expect(f.startWatchdog).not.toHaveBeenCalled();
  },
);

it("confirms a write by readback even when its successful reply is lost, then restores on next Hub", async () => {
  const f = await fixture("25000");
  const native = f.exec.getMockImplementation();
  if (!native) throw new Error("missing injected command driver");
  f.exec.mockImplementation(async (file, args) => {
    if (args[0] === "write" && args[2] === "SUSkippedVersion" && args[4] === "30001")
      expect(JSON.parse(await fs.readFile(journal(f), "utf8"))).toMatchObject({
        original: "25000",
        written: "30001",
        confirmed: false,
      });
    return native(file, args);
  });
  f.loseReply(true);
  expect((await f.manager.check()).error).toBe(null);
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  await f.manager.stop();
  f.loseReply(false);
  const next = new CodexUpdateManager(f.options);
  managers.push(next);
  expect((await next.setEnabled(false)).phase).toBe("disabled");
  expect(f.prefs.get("SUSkippedVersion")).toBe("25000");
});

it("holds a version first seen after compatibility approval until it is actually released", async () => {
  const f = await fixture();
  f.allow();
  f.options.busy = async () => true;
  expect((await f.manager.check()).phase).toBe("waiting-idle");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  expect((await policy(f)).holdUpdates).toBe(true);
});

it("reinstates the held build when idle is lost after arming and can release on the next check", async () => {
  const f = await fixture();
  f.allow();
  await f.manager.check();
  const request = vi.spyOn(f.driver, "requestCheck");
  request.mockImplementationOnce(async () => {
    f.options.busy = async () => true;
  });
  f.advance();
  expect((await f.manager.tick()).phase).toBe("waiting-idle");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  expect((await policy(f)).holdUpdates).toBe(true);
  expect(f.prefs.get("SUAutomaticallyUpdate")).toBe("0");
  f.options.busy = async () => false;
  await f.manager.check();
  f.advance();
  expect((await f.manager.tick()).phase).toBe("installing");
  expect(f.prefs.has("SUSkippedVersion")).toBe(false);
});

it.each(["CODEX_DOWNLOAD_TIMEOUT", "CODEX_HEALTH_FAILED", "CODEX_UPDATE_CHECK_FAILED"])(
  "holds an already verified version during persisted backoff for %s",
  async (error) => {
    const f = await fixture();
    f.allow();
    await fs.mkdir(f.environment.CODEXHOST_DATA_DIR, { recursive: true });
    await fs.writeFile(
      path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-attempt.json"),
      JSON.stringify({ retryAt: 200_000, failures: 1, phase: "failed", error }),
    );
    expect(await f.manager.check()).toMatchObject({ phase: "failed", error });
    expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
    expect((await policy(f)).holdUpdates).toBe(true);
    expect(f.startWatchdog).not.toHaveBeenCalled();
  },
);

it("holds a verified version while the same feed is suspended after three timeouts", async () => {
  const f = await fixture();
  f.allow();
  await f.driver.latestVersion("26.1103.60933");
  await fs.mkdir(f.environment.CODEXHOST_DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-attempt.json"),
    JSON.stringify({
      timeouts: 3,
      suspendedFeed: f.driver.feedIdentity?.(),
      feed: f.driver.feedIdentity?.(),
    }),
  );
  expect(await f.manager.check()).toMatchObject({
    phase: "failed",
    error: "CODEX_DOWNLOAD_TIMEOUT",
  });
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  expect(f.startWatchdog).not.toHaveBeenCalled();
});

it("keeps the skip when another live lease owner prevents release", async () => {
  const f = await fixture();
  f.allow();
  await f.manager.check();
  await fs.writeFile(
    path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-armed.json"),
    JSON.stringify({ id: "synthetic-other-owner", pid: process.pid }),
  );
  f.advance();
  expect((await f.manager.tick()).phase).toBe("failed");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  expect(f.startWatchdog).not.toHaveBeenCalled();
});

it.each(["feed", "defaults"])(
  "a temporary %s failure in the five-minute idle check does not add backoff",
  async (failure) => {
    const f = await fixture();
    f.allow();
    f.options.busy = async () => true;
    await f.manager.check();
    if (failure === "feed")
      vi.spyOn(f.driver, "latestVersion").mockRejectedValueOnce(new Error("synthetic offline"));
    else {
      f.feed(`<rss>${item("26.1106.51428", "30002")}</rss>`);
      f.denyWrite("SUSkippedVersion");
    }
    expect(await f.manager.check()).toMatchObject({ phase: "waiting-idle", error: null });
    expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
    await expect(
      fs.stat(path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-attempt.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    f.denyWrite(null);
    expect((await f.manager.check()).phase).toBe("waiting-idle");
    expect(f.prefs.get("SUSkippedVersion")).toBe(failure === "defaults" ? "30002" : "30001");
  },
);

it("a temporary feed failure at final idle revalidation defers the quit without backoff", async () => {
  const f = await fixture();
  f.allow();
  await f.manager.check();
  vi.spyOn(f.driver, "latestVersion").mockRejectedValueOnce(new Error("synthetic offline"));
  f.advance();
  expect(await f.manager.tick()).toMatchObject({ phase: "waiting-idle", error: null });
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  expect(f.startWatchdog).not.toHaveBeenCalled();
  expect((await f.manager.tick()).phase).toBe("waiting-idle");
  f.advance(5 * 60_000);
  expect((await f.manager.tick()).phase).toBe("waiting-idle");
  f.advance();
  expect((await f.manager.tick()).phase).toBe("installing");
});

it("keeps a released download running across a periodic feed failure, but holds a confirmed unknown version", async () => {
  const f = await fixture();
  f.allow();
  vi.spyOn(f.driver, "installationStopped").mockResolvedValue(true);
  await f.manager.check();
  f.advance();
  await f.manager.tick();
  expect((await f.manager.tick()).phase).toBe("downloading");
  const attempt = path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-attempt.json");
  const before = await fs.readFile(attempt, "utf8");
  vi.spyOn(f.driver, "latestVersion").mockRejectedValueOnce(new Error("synthetic offline"));
  expect(await f.manager.check()).toMatchObject({ phase: "downloading", error: null });
  expect(await fs.readFile(attempt, "utf8")).toBe(before);
  expect(f.prefs.has("SUSkippedVersion")).toBe(false);
  expect((await policy(f)).holdUpdates).toBe(false);
  f.feed(`<rss>${item("26.1200.1", "30002")}${item()}</rss>`);
  expect((await f.manager.check()).phase).toBe("waiting-compatibility");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30002");
  expect((await policy(f)).holdUpdates).toBe(true);
});

it("does not quit if the user skips the target during release preparation", async () => {
  const f = await fixture();
  f.allow();
  await f.manager.check();
  vi.spyOn(f.driver, "requestCheck").mockImplementation(async () => {
    f.prefs.set("SUSkippedVersion", "30001");
  });
  f.advance();
  expect(await f.manager.tick()).toMatchObject({ phase: "user-skipped", error: null });
  expect(
    f.exec.mock.calls.some(
      ([file, args]) => file === "/usr/bin/osascript" && args[1]?.includes(" to quit"),
    ),
  ).toBe(false);
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  expect((await policy(f)).holdUpdates).toBe(true);
});

it("resumes normal release after the user removes their own skip", async () => {
  const f = await fixture("30001");
  f.allow();
  expect((await f.manager.check()).phase).toBe("user-skipped");
  f.prefs.delete("SUSkippedVersion");
  expect((await f.manager.check()).phase).toBe("waiting-idle");
  f.advance();
  expect((await f.manager.tick()).phase).toBe("installing");
});

it("uses the recorded production appcast build 26605 for display version 26.1106.51428", async () => {
  const f = await fixture("25241");
  f.feed(
    '<rss><channel><item><sparkle:version>26605</sparkle:version><sparkle:shortVersionString>26.1106.51428</sparkle:shortVersionString><enclosure url="https://example.test/Codex.zip" length="1" type="application/octet-stream"/></item></channel></rss>',
  );
  await f.manager.check();
  expect(f.prefs.get("SUSkippedVersion")).toBe("26605");
  expect(f.prefs.get("SUSkippedVersion")).not.toBe("26.1106.51428");
});

it.each(["25000", "45000"])(
  "preserves the original integer type for user skip %s",
  async (original) => {
    const f = await fixture(original);
    f.types.set("SUSkippedVersion", "integer");
    expect((await f.manager.check()).error).toBe(null);
    expect(f.prefs.get("SUSkippedVersion")).toBe(original === "25000" ? "30001" : original);
    expect((await f.manager.setEnabled(false)).phase).toBe("disabled");
    expect(f.prefs.get("SUSkippedVersion")).toBe(original);
    expect(f.types.get("SUSkippedVersion")).toBe("integer");
  },
);

it.each(["boolean", "float", "array", "dictionary"])(
  "does not overwrite an unsupported %s skipped preference",
  async (type) => {
    const f = await fixture("1");
    f.types.set("SUSkippedVersion", type);
    expect((await f.manager.check()).error).toBe("CODEX_PREFERENCES_FAILED");
    expect(f.prefs.get("SUSkippedVersion")).toBe("1");
    expect(f.types.get("SUSkippedVersion")).toBe(type);
    expect(f.startWatchdog).not.toHaveBeenCalled();
  },
);

it.each([
  "Error: Could not find key 'SUSkippedVersion' in domain 'com.openai.codex'.\n",
  "Error: Domain 'com.openai.codex' not found.\n",
  "The domain/default pair of (com.openai.codex, SUSkippedVersion) does not exist\n",
])(
  "treats the captured missing-key/domain format as idempotent for read and delete: %s",
  async (stderr) => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("synthetic defaults missing"), { stderr });
    });
    const prefs = codexPreferences(exec);
    expect(await prefs.read("SUSkippedVersion")).toBe(null);
    await expect(prefs.write("SUSkippedVersion", null)).resolves.toBeUndefined();
    expect(exec.mock.calls).toHaveLength(2);
  },
);

it("does not treat a defaults delete permission error as an absent key", async () => {
  const prefs = codexPreferences(async () => {
    throw Object.assign(new Error("synthetic denied"), {
      stderr: "Could not write domain com.openai.codex; exiting\n",
    });
  });
  await expect(prefs.write("SUSkippedVersion", null)).rejects.toThrow("synthetic denied");
});

it("never claims a later user skip after a failed unconfirmed write to that same build", async () => {
  const f = await fixture("25000");
  f.denyWrite("SUSkippedVersion");
  expect((await f.manager.check()).error).toBe("CODEX_PREFERENCES_FAILED");
  expect(JSON.parse(await fs.readFile(journal(f), "utf8"))).toMatchObject({ confirmed: false });
  f.denyWrite(null);
  f.prefs.set("SUSkippedVersion", "30001");
  f.allow();
  // Skip the updater backoff to verify user ownership again, not only opt-out restoration.
  f.advance(24 * 60 * 60_000);
  expect((await f.manager.check()).phase).toBe("user-skipped");
  expect((await f.manager.setEnabled(false)).phase).toBe("disabled");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
});

it.each(["30001", "30002"])(
  "only restores the previously confirmed value of an interrupted pending write: %s",
  async (current) => {
    const f = await fixture(current);
    await f.state.update({
      codexUpdates: { defaulted: true, enabled: true, originalAutoUpdate: true },
    });
    await fs.writeFile(
      journal(f),
      JSON.stringify({
        schemaVersion: 1,
        original: "25000",
        written: "30002",
        previous: "30001",
        confirmed: false,
      }),
    );
    expect((await f.manager.setEnabled(false)).phase).toBe("disabled");
    expect(f.prefs.get("SUSkippedVersion")).toBe(current === "30001" ? "25000" : current);
  },
);

it("keeps an unconfirmed successful write when both its reply and readback were lost", async () => {
  const f = await fixture("25000");
  const native = f.exec.getMockImplementation();
  if (!native) throw new Error("missing injected command driver");
  let written = false;
  f.exec.mockImplementation(async (file, args) => {
    if (args[0] === "write" && args[2] === "SUSkippedVersion") written = true;
    if (written && args[0] === "read" && args[2] === "SUSkippedVersion")
      throw new Error("synthetic readback unavailable");
    return native(file, args);
  });
  f.loseReply(true);
  expect((await f.manager.check()).error).toBe("CODEX_PREFERENCES_FAILED");
  expect(JSON.parse(await fs.readFile(journal(f), "utf8"))).toMatchObject({ confirmed: false });
  f.exec.mockImplementation(native);
  f.loseReply(false);
  f.allow();
  f.advance(24 * 60 * 60_000);
  expect(await f.manager.check()).toMatchObject({
    phase: "user-skipped",
    skipOwnershipUnconfirmed: true,
  });
  expect((await f.manager.setEnabled(false)).phase).toBe("disabled");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
});

it("uses the actual lower signed target when the user's original skip is hidden by the Hub's larger hold", async () => {
  const f = await fixture("25000");
  f.allow();
  f.feed(`<rss>${item("26.1106.51428", "26605")}${item("26.1106.1", "24000")}</rss>`);
  vi.spyOn(f.driver, "downloadReady").mockImplementation(
    async (version) => version === "26.1106.1",
  );
  expect(await f.manager.check()).toMatchObject({
    phase: "user-skipped",
    userSkippedVersion: "26.1106.1",
    latestVersion: "26.1106.51428",
    error: null,
  });
  expect(f.prefs.get("SUSkippedVersion")).toBe("26605");
  expect(f.startWatchdog).not.toHaveBeenCalled();
  expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
});

it("does not confuse a lower user skip with a higher build of the same display version", async () => {
  const f = await fixture("26605");
  f.allow();
  f.feed(`<rss>${item("26.1106.51428", "26605")}${item("26.1106.51428", "26606")}</rss>`);
  expect((await f.manager.check()).phase).toBe("waiting-idle");
  expect(f.prefs.get("SUSkippedVersion")).toBe("26606");
  f.advance();
  expect((await f.manager.tick()).phase).toBe("installing");
  expect(f.prefs.get("SUSkippedVersion")).toBe("26605");
});

it("does not add failure backoff for a temporary user-skip read failure during a released download", async () => {
  const f = await fixture();
  f.allow();
  vi.spyOn(f.driver, "installationStopped").mockResolvedValue(true);
  await f.manager.check();
  f.advance();
  await f.manager.tick();
  expect((await f.manager.tick()).phase).toBe("downloading");
  const attempt = path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-attempt.json");
  const before = await fs.readFile(attempt, "utf8");
  vi.spyOn(f.driver, "isVersionSkipped").mockRejectedValueOnce(
    new Error("synthetic defaults unavailable"),
  );
  expect(await f.manager.check()).toMatchObject({ phase: "downloading", error: null });
  expect(await fs.readFile(attempt, "utf8")).toBe(before);
  expect(f.prefs.get("SUAutomaticallyUpdate")).toBe("1");
  expect((await policy(f)).holdUpdates).toBe(false);
});

it("reinstates the hold without quitting or counting failure when the last user-skip read fails", async () => {
  const f = await fixture();
  f.allow();
  await f.manager.check();
  vi.spyOn(f.driver, "requestCheck").mockImplementation(async () => {
    vi.spyOn(f.driver, "isVersionSkipped").mockRejectedValueOnce(
      new Error("synthetic defaults unavailable"),
    );
  });
  f.advance();
  expect(await f.manager.tick()).toMatchObject({ phase: "waiting-idle", error: null });
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  expect((await policy(f)).holdUpdates).toBe(true);
  expect(
    f.exec.mock.calls.some(
      ([file, args]) => file === "/usr/bin/osascript" && args[1]?.includes(" to quit"),
    ),
  ).toBe(false);
  const attempt = JSON.parse(
    await fs.readFile(
      path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-attempt.json"),
      "utf8",
    ),
  );
  expect(attempt.failures).toBe(0);
});

it.each(["25000", "30001", "30002", "45000"])(
  "recovers an interrupted replacement with native current=%s",
  async (current) => {
    const f = await fixture("25000");
    await f.state.update({
      codexUpdates: { defaulted: true, enabled: true, originalAutoUpdate: true },
    });
    await fs.writeFile(
      journal(f),
      JSON.stringify({ schemaVersion: 1, original: "25000", previous: "30001", written: "30002" }),
    );
    f.prefs.set("SUSkippedVersion", current);
    expect((await f.manager.setEnabled(false)).phase).toBe("disabled");
    expect(f.prefs.get("SUSkippedVersion")).toBe(current === "45000" ? "45000" : "25000");
    await expect(fs.stat(journal(f))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("keeps a managed hold across Hub stop/start and an unavailable feed", async () => {
  const f = await fixture("25000");
  await f.manager.check();
  await f.manager.stop();
  f.feed("<rss/>");
  const next = new CodexUpdateManager(f.options);
  managers.push(next);
  expect((await next.check()).error).toBe("CODEX_APPCAST_FAILED");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  await next.setEnabled(false);
  expect(f.prefs.get("SUSkippedVersion")).toBe("25000");
});

it("does not overwrite a user change between journal persistence and the native hold write", async () => {
  const f = await fixture("25000");
  const native = f.exec.getMockImplementation();
  if (!native) throw new Error("missing injected command driver");
  let reads = 0;
  f.exec.mockImplementation(async (file, args) => {
    if (args[0] === "read" && args[2] === "SUSkippedVersion" && ++reads === 2)
      f.prefs.set("SUSkippedVersion", "45000");
    return native(file, args);
  });
  expect((await f.manager.check()).error).toBe("CODEX_PREFERENCES_FAILED");
  await f.manager.setEnabled(false);
  expect(f.prefs.get("SUSkippedVersion")).toBe("45000");
});

it("a corrupt ownership journal prevents release and is preserved for diagnosis", async () => {
  const f = await fixture();
  await f.manager.check();
  await fs.writeFile(journal(f), '{"schemaVersion":1,"original":false,"written":"30001"}');
  f.allow();
  await f.manager.check();
  f.advance();
  expect((await f.manager.tick()).error).toBe("CODEX_PREFERENCES_FAILED");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  expect(f.prefs.get("SUAutomaticallyUpdate")).toBe("0");
  expect(f.startWatchdog).not.toHaveBeenCalled();
  expect(await fs.readFile(journal(f), "utf8")).toContain('"original":false');
});

const skipReads = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.exec.mock.calls.filter(
    ([file, args]) =>
      file === "/usr/bin/defaults" &&
      (args[0] === "read" || args[0] === "read-type") &&
      args[2]?.startsWith("SUSkipped"),
  ).length;

it.each([429, 503, "write-failure"] as const)(
  "bounds a failed final revalidation (%s) to one feed request over 60 seconds",
  async (failure) => {
    const f = await fixture("25000");
    f.allow();
    f.options.idleMs = 15_000;
    await f.manager.check();
    if (typeof failure === "number") f.feedStatus(failure);
    else {
      f.feed(`<rss>${item("26.1106.51428", "30002")}</rss>`);
      f.denyWrite("SUSkippedVersion");
    }
    f.feedGet.mockClear();
    f.exec.mockClear();
    for (let step = 0; step < 30; step++) {
      f.advance(2000);
      expect((await f.manager.tick()).phase).toBe("waiting-idle");
    }
    expect(f.feedGet).toHaveBeenCalledTimes(1);
    expect(skipReads(f)).toBeLessThanOrEqual(6);
    expect(f.startWatchdog).not.toHaveBeenCalled();
    expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
    await expect(
      fs.stat(path.join(f.environment.CODEXHOST_DATA_DIR, "codex-update-attempt.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    f.feedStatus(200);
    f.denyWrite(null);
    f.advance(5 * 60_000);
    expect((await f.manager.tick()).phase).toBe("waiting-idle");
    f.advance(15_000);
    expect((await f.manager.tick()).phase).toBe("installing");
  },
);

it("does not fetch feed or read skip preferences in 30 busy ticks spanning 60 seconds", async () => {
  const f = await fixture();
  f.allow();
  f.options.busy = async () => true;
  await f.manager.check();
  f.feedGet.mockClear();
  f.exec.mockClear();
  for (let step = 0; step < 30; step++) {
    f.advance(2000);
    expect((await f.manager.tick()).phase).toBe("waiting-idle");
  }
  expect(f.feedGet).not.toHaveBeenCalled();
  expect(skipReads(f)).toBe(0);
});

it("reports consecutive periodic preference failures, clears on recovery and still times out downloads", async () => {
  const f = await fixture("10000");
  f.allow();
  await f.manager.check();
  f.advance();
  expect((await f.manager.tick()).phase).toBe("installing");
  expect((await f.manager.tick()).phase).toBe("downloading");
  f.denyRead("SUSkippedVersion");
  for (let check = 0; check < 3; check++) {
    f.advance(5 * 60_000);
    expect(await f.manager.check()).toMatchObject({
      phase: "downloading",
      error: check === 2 ? "CODEX_PREFERENCES_FAILED" : null,
    });
  }
  f.denyRead(null);
  expect(await f.manager.check()).toMatchObject({ phase: "downloading", error: null });
  f.denyRead("SUSkippedVersion");
  f.feedGet.mockClear();
  f.exec.mockClear();
  for (let step = 0; step < 30; step++) {
    f.advance(2000);
    expect((await f.manager.tick()).phase).toBe("downloading");
  }
  expect(f.feedGet).not.toHaveBeenCalled();
  expect(skipReads(f)).toBe(0);
  f.advance(30 * 60_000);
  expect(await f.manager.tick()).toMatchObject({
    phase: "failed",
    error: "CODEX_DOWNLOAD_TIMEOUT",
  });
});

it("reports three failed held-preference refreshes without leaving the idle wait", async () => {
  const f = await fixture();
  f.allow();
  f.options.busy = async () => true;
  await f.manager.check();
  f.denyRead("SUSkippedVersion");
  for (let check = 0; check < 3; check++) {
    f.advance(5 * 60_000);
    expect(await f.manager.check()).toMatchObject({
      phase: "waiting-idle",
      error: check === 2 ? "CODEX_PREFERENCES_FAILED" : null,
    });
  }
  f.denyRead(null);
  expect(await f.manager.check()).toMatchObject({ phase: "waiting-idle", error: null });
});

it.each(["recheck", "disable", "restart-disable"])(
  "confirms a successful write after failed readback on %s and restores the first original",
  async (action) => {
    const f = await fixture("25000");
    const native = f.exec.getMockImplementation();
    if (!native) throw new Error("missing injected commands");
    let written = false;
    f.exec.mockImplementation(async (file, args) => {
      if (written && args[0] === "read" && args[2] === "SUSkippedVersion")
        throw new Error("synthetic readback unavailable");
      const result = await native(file, args);
      if (args[0] === "write" && args[2] === "SUSkippedVersion") written = true;
      return result;
    });
    expect((await f.manager.check()).error).toBe("CODEX_PREFERENCES_FAILED");
    expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
    expect(JSON.parse(await fs.readFile(journal(f), "utf8"))).toMatchObject({
      confirmed: false,
      writeSucceeded: true,
    });
    f.exec.mockImplementation(native);
    let manager = f.manager;
    if (action === "recheck") {
      f.allow();
      f.advance(24 * 60 * 60_000);
      expect((await manager.check()).phase).toBe("waiting-idle");
      expect(JSON.parse(await fs.readFile(journal(f), "utf8"))).not.toHaveProperty("confirmed");
    } else if (action === "restart-disable") {
      await manager.stop();
      manager = new CodexUpdateManager(f.options);
      managers.push(manager);
    }
    expect((await manager.setEnabled(false)).phase).toBe("disabled");
    expect(f.prefs.get("SUSkippedVersion")).toBe("25000");
    await expect(fs.stat(journal(f))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("uses only OS-installable builds when deciding whether the user skipped a display version", async () => {
  const f = await fixture("30001");
  f.allow();
  f.feed(
    `<rss>${item()}${item("26.1106.51428", "40000").replace("<enclosure", "<sparkle:minimumSystemVersion>99.0</sparkle:minimumSystemVersion><enclosure")}</rss>`,
  );
  expect(await f.manager.check()).toMatchObject({ phase: "user-skipped", error: null });
  expect(f.prefs.get("SUSkippedVersion")).toBe("40000");
  expect(f.startWatchdog).not.toHaveBeenCalled();
});

it("checks the newest installable display version when the feed's latest needs a newer OS", async () => {
  const f = await fixture("30001");
  f.allow();
  f.feed(
    `<rss>${item()}${item("26.1106.60000", "40000").replace("<enclosure", "<sparkle:minimumSystemVersion>99.0</sparkle:minimumSystemVersion><enclosure")}</rss>`,
  );
  expect(await f.manager.check()).toMatchObject({
    phase: "user-skipped",
    userSkippedVersion: "26.1106.51428",
    latestVersion: "26.1106.60000",
    error: null,
  });
  expect(f.startWatchdog).not.toHaveBeenCalled();
});

it.each([
  ["27000", null, null, true],
  ["27000", "30001", "30001", true],
  ["27000", "30001", "30002", false],
  ["27000", null, "30001", false],
  ["25000", "30001", null, false],
] as const)(
  "respects major skip %s, subrelease %s and ignore threshold %s (blocked=%s)",
  async (major, subrelease, ignore, blocked) => {
    const f = await fixture();
    f.allow();
    f.prefs.set("SUSkippedMajorVersion", major);
    if (subrelease) f.prefs.set("SUSkippedMajorSubreleaseVersion", subrelease);
    const metadata = `<sparkle:minimumAutoupdateVersion>27000</sparkle:minimumAutoupdateVersion>${ignore ? `<sparkle:ignoreSkippedUpgradesBelowVersion>${ignore}</sparkle:ignoreSkippedUpgradesBelowVersion>` : ""}`;
    f.feed(`<rss>${item().replace("<enclosure", `${metadata}<enclosure`)}</rss>`);
    expect((await f.manager.check()).phase).toBe(blocked ? "user-skipped" : "waiting-idle");
    expect(f.prefs.get("SUSkippedMajorVersion")).toBe(major);
    expect(f.prefs.get("SUSkippedMajorSubreleaseVersion") ?? null).toBe(subrelease);
    expect(
      f.exec.mock.calls.some(
        ([, args]) => (args[0] === "write" || args[0] === "delete") && /Major/.test(args[2] ?? ""),
      ),
    ).toBe(false);
    expect(f.startWatchdog).not.toHaveBeenCalled();
  },
);

it(
  "samples actual two-second timers for 60 seconds with injected native commands",
  { timeout: 70_000 },
  async () => {
    const rateLimited = await fixture("25000");
    rateLimited.allow();
    rateLimited.options.now = Date.now;
    await rateLimited.manager.start();
    rateLimited.feedStatus(429);

    const busy = await fixture();
    busy.allow();
    busy.options.now = Date.now;
    busy.options.busy = async () => true;
    await busy.manager.start();

    const downloading = await fixture("10000");
    downloading.allow();
    await downloading.manager.check();
    downloading.advance();
    await downloading.manager.tick();
    expect((await downloading.manager.tick()).phase).toBe("downloading");
    const downloadClockStart = Date.now();
    downloading.options.now = () => 100_010 + Date.now() - downloadClockStart;
    downloading.denyRead("SUSkippedVersion");
    await downloading.manager.start();

    const cases = [rateLimited, busy, downloading];
    const ticks = cases.map((f) => vi.spyOn(f.manager, "tick"));
    for (const f of cases) {
      f.feedGet.mockClear();
      f.exec.mockClear();
    }
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 60_050));
    const metrics = [];
    for (const [index, f] of cases.entries()) {
      const timerTicks = ticks[index]?.mock.calls.length ?? 0;
      await f.manager.tick(); // Drain the serialized timer work before reading counts.
      expect(timerTicks).toBeGreaterThanOrEqual(29);
      expect(timerTicks).toBeLessThanOrEqual(31);
      metrics.push({
        scenario: ["429-before-release", "busy-wait", "download-read-unavailable"][index],
        timerTicks,
        feedRequests: f.feedGet.mock.calls.length,
        skipReads: skipReads(f),
        phase: f.manager.status().phase,
      });
    }
    expect(metrics.map((m) => m.feedRequests)).toEqual([1, 0, 0]);
    expect(metrics.map((m) => m.skipReads)).toEqual([0, 0, 0]);
    expect(metrics.map((m) => m.phase)).toEqual(["waiting-idle", "waiting-idle", "downloading"]);
    process.stdout.write(
      `CODEX_UPDATE_ALERT_CADENCE ${JSON.stringify({ elapsedMs: Math.round(performance.now() - started), metrics })}\n`,
    );
  },
);

it("the real watchdog runner restores scheduled checks but never rewrites skip or seen values", async () => {
  const f = await fixture("25000");
  await f.manager.check();
  const before = await fs.readFile(journal(f), "utf8");
  f.prefs.delete("SULastCheckTime");
  f.prefs.set("SUSkippedVersion", "45000");
  const leaseFile = path.join(f.environment.CODEXHOST_DATA_DIR, "synthetic-watchdog-lease.json");
  await fs.writeFile(
    leaseFile,
    JSON.stringify({
      id: "synthetic-dead-hub",
      pid: 123,
      at: Date.now(),
      checkPreferences: { automaticChecks: false, lastCheckTime: "2026-11-10 12:00:00 +0000" },
      skippedVersion: { written: "30001", original: "25000" },
    }),
  );
  f.exec.mockClear();
  await runCodexUpdateWatchdog(leaseFile, "synthetic-dead-hub", {
    alive: () => false,
    wait: async () => undefined,
    disarm: (lease) => disarmCodexUpdateLease(lease, f.exec),
    ready: () => undefined,
  });
  expect(f.prefs.get("SUAutomaticallyUpdate")).toBe("0");
  expect(f.prefs.get("SUEnableAutomaticChecks")).toBe("0");
  expect(f.prefs.get("SULastCheckTime")).toBe("2026-11-10 12:00:00 +0000");
  expect(f.prefs.get("SUSkippedVersion")).toBe("45000");
  expect(await fs.readFile(journal(f), "utf8")).toBe(before);
  expect(
    f.exec.mock.calls.every(
      ([file, args]) => file === "/usr/bin/defaults" && !/Skipped|Seen/.test(args[2] ?? ""),
    ),
  ).toBe(true);
});
