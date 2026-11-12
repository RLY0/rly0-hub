import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureHostService } from "@codexhost/desktop-control";
import { defaultControllerStatusPath } from "../../packages/desktop-control/src/controller-status.js";
import {
  readLauncherCodexVersion,
  readCodexRendererPolicy,
} from "../../packages/desktop-control/src/codex-renderer-policy.js";
import { dataDirectory as consoleDataDirectory } from "../../packages/console-server/src/paths.js";
import { defaultWebDataDirectory } from "../../packages/web-server/src/data-paths.js";
import {
  defaultExternalClientsPath,
  codexhostDataDirectory,
} from "../../packages/host-runtime/src/external-clients.js";
import { defaultDelegationWatchDirectory } from "../../packages/host-runtime/src/delegation-watch-store.js";
import { consoleHostDescriptorDirectory } from "../../packages/host-runtime/src/console-control-server.js";
import { defaultModelPriceDirectory } from "../../packages/host-runtime/src/model-prices.js";
import { runtimeLogPath } from "../../packages/host-runtime/src/runtime-log.js";
import { HarnessDisplaySettingsStore } from "../../packages/host-runtime/src/harness-display-settings.js";
import {
  runLocalDesktopBridge,
  sharedHostDataDirectory,
} from "../../packages/host-runtime/src/local-shared-host.js";
import { readLauncherCodexBundle } from "../../packages/host-runtime/src/rly0-hub-service/codex-bundle-location.js";

vi.mock(import("@codexhost/desktop-control"), async (original) => ({
  ...(await original()),
  ensureHostService: vi.fn(async () => {
    throw new Error("synthetic launch capture");
  }),
}));

let home: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (home) await rm(home, { recursive: true, force: true });
});

it("uses only Hub data with CODEXHOST_DATA_DIR absent, including the packaged Desktop bridge", async () => {
  home = await mkdtemp(path.join(tmpdir(), "rly0-default-data-synthetic-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("CODEXHOST_DATA_DIR", undefined);
  const environment = { HOME: home, USERPROFILE: home };
  const data = path.join(home, ".rly0-hub");
  expect(codexhostDataDirectory(environment)).toBe(data);
  expect(sharedHostDataDirectory(environment)).toBe(data);
  expect(defaultModelPriceDirectory(environment)).toBe(data);
  expect(consoleDataDirectory(environment)).toBe(data);
  expect(defaultWebDataDirectory()).toBe(path.join(data, "web"));
  for (const file of [
    defaultExternalClientsPath(environment),
    defaultDelegationWatchDirectory(environment),
    consoleHostDescriptorDirectory(environment),
    defaultControllerStatusPath(environment),
    runtimeLogPath(environment, 123),
  ])
    expect(file.startsWith(data + path.sep)).toBe(true);

  const settings = new HarnessDisplaySettingsStore(environment);
  await settings.set({ entries: [] });
  expect(
    JSON.parse(await readFile(path.join(data, "harness-display-settings-v1.json"), "utf8")),
  ).toEqual([]);
  settings.close();
  await mkdir(path.join(data, "diagnostics"), { recursive: true });
  await writeFile(
    path.join(data, "diagnostics/launcher-startup-v1.json"),
    JSON.stringify({
      schemaVersion: 1,
      records: [
        { pid: 123, desktop: { version: "26.1106.1", installRoot: "/synthetic/Codex.app" } },
      ],
    }),
  );
  expect(await readLauncherCodexVersion(environment, 123)).toBe("26.1106.1");
  expect(await readLauncherCodexBundle(environment)).toBe("/synthetic/Codex.app");
  for (const holdUpdates of [true, false]) {
    await writeFile(
      path.join(data, "codex-renderer-policy.json"),
      JSON.stringify({
        desktopVersion: "26.1106.1",
        policy: { schemaVersion: 1, mode: "full", disabled: [] },
        holdUpdates,
      }),
    );
    expect(await readCodexRendererPolicy(environment, async () => "26.1106.1")).toMatchObject({
      mode: "full",
      holdUpdates,
    });
  }

  await expect(
    runLocalDesktopBridge(
      { ...environment, CODEXHOST_LAUNCHER_EXECUTABLE: path.join(home, "launcher") },
      "/synthetic/host-runtime.mjs",
      "/synthetic/codex",
      ["app-server"],
    ),
  ).rejects.toThrow("synthetic launch capture");
  expect(ensureHostService).toHaveBeenCalledWith(expect.objectContaining({ dataDirectory: data }));
  await expect(readFile(path.join(home, ".codexhost/external-clients.json"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
});

it("keeps an explicitly isolated data directory for Desktop, Web and stores", async () => {
  const data = path.resolve(tmpdir(), "synthetic-custom-hub-data");
  const environment = {
    CODEXHOST_DATA_DIR: data,
    CODEXHOST_LAUNCHER_EXECUTABLE: path.join(data, "launcher"),
  };
  expect(codexhostDataDirectory(environment)).toBe(data);
  expect(defaultModelPriceDirectory(environment)).toBe(data);
  expect(defaultWebDataDirectory(data)).toBe(path.join(data, "web"));
  await expect(
    runLocalDesktopBridge(environment, "/synthetic/host-runtime.mjs", "/synthetic/codex", []),
  ).rejects.toThrow("synthetic launch capture");
  expect(ensureHostService).toHaveBeenCalledWith(expect.objectContaining({ dataDirectory: data }));
});
