import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DESKTOP_CONTROL_REQUEST_FILE,
  createLauncherProcessControl,
} from "../../src/rly0-maintenance/launcher-process-control.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function launcherEnvironment(): Promise<NodeJS.ProcessEnv> {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-launcher-control-"));
  return {
    CODEXHOST_LAUNCHER_PID: "4242",
    CODEXHOST_RUNTIME_DESCRIPTOR_PATH: path.join(directory, "runtime.json"),
    CODEXHOST_CONTROL_NONCE: "nonce-from-launcher",
  };
}

describe("launcher process control", () => {
  it("is unavailable off Windows or without a Launcher that owns this Desktop", async () => {
    const environment = await launcherEnvironment();
    expect(createLauncherProcessControl({ environment, platform: "darwin" })).toBeUndefined();
    for (const key of Object.keys(environment)) {
      const partial = { ...environment, [key]: undefined };
      expect(createLauncherProcessControl({ environment: partial, platform: "win32" })).toBe(
        undefined,
      );
    }
    expect(
      createLauncherProcessControl({
        environment: { ...environment, CODEXHOST_LAUNCHER_PID: "12; rm" },
        platform: "win32",
      }),
    ).toBeUndefined();
    expect(
      createLauncherProcessControl({
        environment: { ...environment, CODEXHOST_RUNTIME_DESCRIPTOR_PATH: "relative/runtime.json" },
        platform: "win32",
      }),
    ).toBeUndefined();
  });

  it("writes exactly the request the Launcher accepts, next to its descriptor", async () => {
    const environment = await launcherEnvironment();
    const control = createLauncherProcessControl({
      environment,
      platform: "win32",
      requestDelayMs: 0,
    });
    if (!control || !directory) throw new Error("expected launcher control");
    expect(await control.restart()).toBe(true);
    const requestPath = path.join(directory, DESKTOP_CONTROL_REQUEST_FILE);
    expect(JSON.parse(await fs.readFile(requestPath, "utf8"))).toEqual({
      schemaVersion: 1,
      launcherPid: 4242,
      nonce: "nonce-from-launcher",
      action: "restart",
    });
    expect(await control.forceQuit()).toBe(true);
    expect(JSON.parse(await fs.readFile(requestPath, "utf8"))).toMatchObject({ action: "quit" });
    expect((await fs.readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("defers the request so the reply can reach the page first", async () => {
    const environment = await launcherEnvironment();
    const control = createLauncherProcessControl({
      environment,
      platform: "win32",
      requestDelayMs: 50,
    });
    if (!control || !directory) throw new Error("expected launcher control");
    const requestPath = path.join(directory, DESKTOP_CONTROL_REQUEST_FILE);
    expect(await control.forceQuit()).toBe(true);
    await expect(fs.access(requestPath)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(fs.access(requestPath)).resolves.toBeUndefined();
  });

  it("reports failure when the Launcher state directory is gone", async () => {
    const environment = await launcherEnvironment();
    const control = createLauncherProcessControl({
      environment,
      platform: "win32",
      requestDelayMs: 0,
    });
    if (!control || !directory) throw new Error("expected launcher control");
    await fs.rm(directory, { recursive: true, force: true });
    expect(await control.restart()).toBe(false);
  });
});
