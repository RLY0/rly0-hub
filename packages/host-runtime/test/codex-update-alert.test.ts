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
    ["SUSkippedMajorVersion", "synthetic-user-major"],
    ["SUSkippedMajorSubreleaseVersion", "synthetic-user-subrelease"],
    ["CodexSparkleSeenUpdateVersions", '("25000", "26000")'],
  ]);
  if (original !== null) prefs.set("SUSkippedVersion", original);
  let failWrite: string | null = null;
  let loseWriteReply = false;
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/defaults") {
      const [action, domain, key = ""] = args;
      expect(domain).toBe("com.openai.codex");
      if (action !== "write" && !prefs.has(key))
        throw Object.assign(new Error("synthetic missing"), {
          stderr: `Error: Could not find key '${key}' in domain '${domain}'.`,
        });
      if (action === "read") return prefs.get(key) ?? "";
      if (action === "read-type") return "Type is string";
      if (key === failWrite) throw new Error("synthetic permission denied");
      if (action === "delete") prefs.delete(key);
      else if (action === "write")
        prefs.set(key, args[3] === "-bool" ? (args[4] === "true" ? "1" : "0") : (args[4] ?? ""));
      else throw new Error(`unexpected defaults operation ${action}`);
      if (key === "SUSkippedVersion" && loseWriteReply)
        throw new Error("synthetic lost write reply");
      return "";
    }
    if (file === "/usr/bin/sw_vers") return "27.2";
    if (file === "/usr/bin/env") return "Wed Nov 11 09:00:00 2026";
    if (file === "/usr/bin/lsappinfo") return '    bundle path="/Applications/ChatGPT.app"';
    if (file === "/usr/bin/osascript") return args[1]?.includes(" to quit") ? "" : "true";
    throw new Error(`unexpected system command ${file}`);
  });
  let xml = `<rss><channel>${item()}</channel></rss>`;
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
    get: async () => http(xml),
    currentVersion: async () => "26.1103.60933",
    reopen: async () => true,
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
  };
  const manager = new CodexUpdateManager(options);
  managers.push(manager);
  return {
    root,
    environment,
    prefs,
    exec,
    driver,
    manager,
    options,
    catalog,
    state,
    startWatchdog,
    advance: () => {
      now += 10;
    },
    allow: () => {
      verified.push({ family: "26.1106", minHub: "0.11.40" });
    },
    feed: (value: string) => {
      xml = value;
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
    await f.manager.check();
    f.advance();
    await f.manager.tick();
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

it("uses the greatest blocked build across candidates, independent of short-version sorting", async () => {
  const f = await fixture();
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

it("persists ownership before a write whose successful reply is lost, then recovers on next Hub", async () => {
  const f = await fixture("25000");
  const native = f.exec.getMockImplementation();
  if (!native) throw new Error("missing injected command driver");
  f.exec.mockImplementation(async (file, args) => {
    if (args[0] === "write" && args[2] === "SUSkippedVersion")
      expect(JSON.parse(await fs.readFile(journal(f), "utf8"))).toMatchObject({
        original: "25000",
        written: "30001",
      });
    return native(file, args);
  });
  f.loseReply(true);
  expect((await f.manager.check()).error).toBe("CODEX_PREFERENCES_FAILED");
  expect(f.prefs.get("SUSkippedVersion")).toBe("30001");
  await f.manager.stop();
  f.loseReply(false);
  const next = new CodexUpdateManager(f.options);
  managers.push(next);
  expect((await next.setEnabled(false)).phase).toBe("disabled");
  expect(f.prefs.get("SUSkippedVersion")).toBe("25000");
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
