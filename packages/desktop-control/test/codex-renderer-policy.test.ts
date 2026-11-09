import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readCodexRendererPolicy } from "../src/codex-renderer-policy.js";
import { coreRendererBootstrap } from "../src/core-renderer-session.js";
import { readCoreUsageSnapshot } from "../src/core-usage-snapshot.js";
import { runInNewContext } from "node:vm";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-renderer-policy-"));
  roots.push(root);
  return {
    root,
    environment: {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, "codex"),
      CODEXHOST_DATA_DIR: root,
      RLY0_MEMORY_DIR: path.join(root, "memory"),
      RLY0_SKIP_LEGACY_IMPORT: "1",
      CODEXHOST_CODEX_VERSION: "26.1103.1",
      CODEXHOST_RENDERER_POLICY: JSON.stringify({ schemaVersion: 1, mode: "full", disabled: [] }),
    },
  };
}
it("requires version-bound policy and fails closed for corruption or stale versions", async () => {
  const f = await fixture();
  const file = path.join(f.root, "codex-renderer-policy.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      desktopVersion: "26.1103.1",
      policy: { schemaVersion: 1, mode: "full", disabled: ["settings"] },
    }),
  );
  expect(await readCodexRendererPolicy(f.environment)).toMatchObject({
    mode: "full",
    disabled: ["settings"],
  });
  f.environment.CODEXHOST_CODEX_VERSION = "26.1200.1";
  expect((await readCodexRendererPolicy(f.environment)).mode).toBe("core");
  await fs.writeFile(file, "broken");
  expect((await readCodexRendererPolicy(f.environment)).mode).toBe("core");
});
it("publishes only passive data without reading DOM/native RPC or installing patches", () => {
  const events: string[] = [];
  const context = {
    dispatchEvent: (event: { type: string }) => events.push(event.type),
    CustomEvent: class {
      constructor(readonly type: string) {}
    },
  };
  expect(
    runInNewContext(
      coreRendererBootstrap({ schemaVersion: 1, mode: "core", disabled: [] }),
      context,
    ),
  ).toBe(true);
  expect(events).toEqual(["codexhost:core-usage"]);
  expect(context).not.toHaveProperty("__codexhostHostRoutingV1");
  expect(context).toHaveProperty("__codexhostCoreUsageV1.available", false);
});
it("bounds, validates and expires passive quota/balance snapshots", async () => {
  const f = await fixture();
  const file = path.join(f.root, "codex-core-usage.json");
  const value = {
    checkedAt: 1000,
    quota: { usedPercent: 25 },
    balance: { amount: 10, unit: "USD" },
    syntheticSecret: "must be stripped",
  };
  await fs.writeFile(file, JSON.stringify(value));
  expect(await readCoreUsageSnapshot(f.environment, 2000)).toEqual({
    available: true,
    checkedAt: 1000,
    quota: { usedPercent: 25 },
    balance: { amount: 10, unit: "USD" },
  });
  expect(await readCoreUsageSnapshot(f.environment, 700000)).toMatchObject({ available: false });
  await fs.writeFile(file, JSON.stringify({ ...value, quota: { usedPercent: "fake" } }));
  expect(await readCoreUsageSnapshot(f.environment, 2000)).toMatchObject({ available: false });
});

it("uses this Launcher's inspected Desktop identity when Hub did not open Codex", async () => {
  const { readLauncherCodexVersion } = await import("../src/codex-renderer-policy.js");
  const f = await fixture();
  await fs.mkdir(path.join(f.root, "diagnostics"), { recursive: true });
  await fs.writeFile(
    path.join(f.root, "diagnostics", "launcher-startup-v1.json"),
    JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          id: "synthetic-100",
          pid: 100,
          launcherVersion: "0.11.39",
          startedAtMs: 1000,
          finishedAtMs: 1100,
          outcome: "success",
          error: null,
          stages: [],
          desktop: {
            version: "26.1200.1",
            build: "123456",
            installRoot: "/Applications/ChatGPT.app",
          },
        },
        { pid: 200, desktop: { version: "26.1103.1" } },
      ],
    }),
  );
  expect(await readLauncherCodexVersion(f.environment, 100)).toBe("26.1200.1");
  expect(await readLauncherCodexVersion(f.environment, 300)).toBeNull();
  await fs.writeFile(
    path.join(f.root, "codex-renderer-policy.json"),
    JSON.stringify({
      desktopVersion: "26.1200.1.0",
      policy: { schemaVersion: 1, mode: "full", disabled: [] },
    }),
  );
  delete (f.environment as NodeJS.ProcessEnv).CODEXHOST_CODEX_VERSION;
  expect(
    (
      await readCodexRendererPolicy(f.environment, () =>
        readLauncherCodexVersion(f.environment, 100),
      )
    ).mode,
  ).toBe("full");
});
it("retains running policy on transient I/O errors, defaults core only at startup", async () => {
  const { createCodexRendererPolicyReader } = await import("../src/codex-renderer-policy.js");
  let fail = true;
  const read = createCodexRendererPolicyReader(async () => {
    if (fail) throw Object.assign(new Error("synthetic IO"), { code: "EACCES" });
    return { schemaVersion: 1, mode: "full", disabled: [] };
  });
  expect((await read()).mode).toBe("core");
  fail = false;
  expect((await read()).mode).toBe("full");
  fail = true;
  expect((await read()).mode).toBe("full");
});
it("the policy filesystem reader exposes non-ENOENT failures instead of publishing core", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.root, "codex-renderer-policy.json"));
  await expect(readCodexRendererPolicy(f.environment)).rejects.toThrow();
});

it("matches the Launcher's default ~/.codexhost/diagnostics location, ignoring the old wrong location", async () => {
  const { readLauncherCodexVersion } = await import("../src/codex-renderer-policy.js");
  const f = await fixture();
  const environment = { HOME: f.root };
  const file = path.join(f.root, ".codexhost", "diagnostics", "launcher-startup-v1.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          pid: 321,
          desktop: {
            version: "26.1200.1",
            build: "123456",
            installRoot: "/Applications/ChatGPT.app",
          },
        },
      ],
    }),
  );
  expect(await readLauncherCodexVersion(environment, 321)).toBe("26.1200.1");
  expect(
    await readLauncherCodexVersion(
      { ...environment, CODEXHOST_DATA_DIR: "relative-ignored-by-launcher" },
      321,
    ),
  ).toBe("26.1200.1");
});

it("resolves a reused Launcher PID to the newest record (the Launcher inserts newest first)", async () => {
  const { readLauncherCodexVersion } = await import("../src/codex-renderer-policy.js");
  const f = await fixture();
  const record = (id: string, startedAtMs: number, version: string, build: string) => ({
    id,
    pid: 4242,
    launcherVersion: "0.11.40",
    startedAtMs,
    finishedAtMs: startedAtMs + 900,
    outcome: "ready",
    error: null,
    stages: [{ name: "desktop-discovered", elapsedMs: 120 }],
    desktop: { version, build, installRoot: "/Applications/ChatGPT.app" },
  });
  await fs.mkdir(path.join(f.root, "diagnostics"), { recursive: true });
  await fs.writeFile(
    path.join(f.root, "diagnostics", "launcher-startup-v1.json"),
    JSON.stringify({
      schemaVersion: 1,
      records: [
        record("1762700000000-4242", 1762700000000, "26.1200.1", "2120"),
        record("1762600000000-4242", 1762600000000, "26.1103.1", "2010"),
      ],
    }),
  );
  expect(await readLauncherCodexVersion(f.environment, 4242)).toBe("26.1200.1");
});
