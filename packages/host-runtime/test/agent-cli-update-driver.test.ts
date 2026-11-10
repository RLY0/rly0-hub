import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  agentCliUpdateIdSchema,
  AGENT_CLI_BUSY_METHOD,
  HARNESS_LAUNCH_SETTINGS_GET_METHOD,
} from "@codexhost/shared-contracts";
import { createAgentCliUpdateDriver } from "../src/rly0-hub-service/agent-cli-update-driver.js";
import type { HubHostRequest } from "../src/rly0-hub-service/host-console-routes.js";
import type { UpdateHttpGet } from "../src/rly0-hub-service/hub-update-net.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing synthetic fixture");
  return value;
}
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(
  platform: NodeJS.Platform = "darwin",
  config: { prefix?: string; packageName?: string; command?: string; version?: string } = {},
) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "synthetic-cli-driver-")));
  roots.push(root);
  const prefix = config.prefix ?? (platform === "win32" ? "C:\\Synthetic Space & Test\\npm" : root);
  const packageName = config.packageName ?? "@earendil-works/pi-coding-agent";
  const command = config.command ?? "pi";
  const cliVersion = config.version ?? "1.0.0";
  const p = platform === "win32" ? path.win32 : path.posix;
  const executable = p.join(prefix, platform === "win32" ? `${command}.cmd` : `bin/${command}`);
  const directory = p.join(
    prefix,
    ...(platform === "win32" ? [] : ["lib"]),
    "node_modules",
    ...packageName.split("/"),
  );
  const binary = p.join(directory, "dist/cli.js");
  const npm = p.join(prefix, platform === "win32" ? "npm.cmd" : "bin/npm");
  const files: Record<string, string> = {
    [p.join(directory, "package.json")]: JSON.stringify({
      name: packageName,
      version: cliVersion,
      bin: { [command]: "dist/cli.js" },
    }),
    [executable]: `"%dp0%/node_modules/${packageName}/dist/cli.js"`,
  };
  let selected = executable;
  let current = cliVersion;
  const run = vi.fn(
    async (
      _command: string,
      args: readonly string[],
      _env: NodeJS.ProcessEnv,
      _timeout?: number,
    ) => {
      void _env;
      void _timeout;
      if (args[0] === "view") return JSON.stringify("1.1.0");
      if (args[0] === "install") {
        current = args.at(-1)?.split("@").at(-1) ?? "unknown";
        return "synthetic install";
      }
      return current;
    },
  );
  const get: UpdateHttpGet = vi.fn(async () => ({
    status: 200,
    headers: {},
    body: (async function* () {
      yield Buffer.from(JSON.stringify({ version: "1.1.0", tag_name: "v1.1.0" }));
    })(),
    cancel: () => undefined,
  }));
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const host = vi.fn<HubHostRequest>(async (method) => {
    if (method === HARNESS_LAUNCH_SETTINGS_GET_METHOD)
      return {
        path: JSON.parse(
          await readFile(path.join(root, "harness-launch-settings", "pi.json"), "utf8"),
        ),
        restartRequired: false,
      };
    return method === AGENT_CLI_BUSY_METHOD ? { guarded: true, busy: false } : adapter.inspect();
  });
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CODEXHOST_DATA_DIR: root,
    RLY0_MEMORY_DIR: path.join(root, "memory"),
    RLY0_SKIP_LEGACY_IMPORT: "1",
    HTTPS_PROXY: "http://127.0.0.1:synthetic",
  };
  const writable = vi.fn(async () => undefined);
  const occupied = vi.fn(async () => false);
  const driver = createAgentCliUpdateDriver({
    platform,
    environment: async () => env,
    get: async () => get,
    hosts: async () => [host],
    installing: () => false,
    run,
    writable,
    occupied,
    discover: () => selected,
    npmOptions: {
      readText: async (file) => {
        if (file in files) return files[file] ?? "";
        throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
      },
      realpath: async (file) => (file === executable && platform !== "win32" ? binary : file),
      resolveNpm: () => npm,
    },
  });
  return {
    root,
    prefix,
    executable,
    npm,
    run,
    get,
    host,
    adapter,
    env,
    driver,
    files,
    writable,
    occupied,
    setExecutable: (v: string) => {
      selected = v;
    },
  };
}
describe("injected CLI update drivers", () => {
  it.each(["darwin", "win32"] as const)(
    "identifies %s npm at the actual prefix and pins both forward and rollback versions",
    async (platform) => {
      const f = await fixture(platform);
      const installation = await f.driver.inspect("pi");
      expect(installation).toMatchObject({
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        canUpdate: true,
        plan: { prefix: f.prefix, npm: f.npm },
      });
      await f.driver.install(required(installation).plan, "1.1.0");
      await f.driver.install(required(installation).plan, "1.0.0");
      expect(
        f.run.mock.calls.filter((call) => call[1][0] === "install").map((call) => call.slice(0, 2)),
      ).toEqual([
        [
          f.npm,
          ["install", "--global", "--prefix", f.prefix, "@earendil-works/pi-coding-agent@1.1.0"],
        ],
        [
          f.npm,
          ["install", "--global", "--prefix", f.prefix, "@earendil-works/pi-coding-agent@1.0.0"],
        ],
      ]);
      expect(f.run).toHaveBeenCalledWith(
        f.npm,
        [
          "view",
          "--prefix",
          f.prefix,
          "@earendil-works/pi-coding-agent@latest",
          "version",
          "--json",
        ],
        expect.any(Object),
      );
      expect(f.get).not.toHaveBeenCalled();
      expect(f.run.mock.calls[0]?.[2].HTTPS_PROXY).toBe(f.env.HTTPS_PROXY);
      expect(f.run.mock.calls.some((call) => call[1].includes("uninstall"))).toBe(false);
    },
  );
  it("uses cached registry latest for a deferred retry", async () => {
    const f = await fixture();
    expect((await f.driver.inspect("pi", "1.2.0"))?.latestVersion).toBe("1.2.0");
    expect(f.get).not.toHaveBeenCalled();
  });
  it("does not execute any command when no Host can verify the update", async () => {
    const run = vi.fn();
    const get = vi.fn();
    const driver = createAgentCliUpdateDriver({
      platform: "darwin",
      environment: async () => ({}),
      get,
      hosts: async () => [],
      installing: () => false,
      run,
    });
    await expect(driver.inspect("pi")).rejects.toThrow("HOST_UNAVAILABLE");
    expect(run).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  it("checks every local Host and rejects old or malformed busy protocols", async () => {
    const first = vi.fn<HubHostRequest>(async () => ({ guarded: true, busy: false }));
    const second = vi.fn<HubHostRequest>(async () => ({ guarded: true, busy: true }));
    const driver = createAgentCliUpdateDriver({
      platform: "win32",
      environment: async () => ({}),
      get: vi.fn(),
      hosts: async () => [first, second],
      installing: () => false,
      run: vi.fn(),
    });
    expect(await driver.busy("pi")).toBe(true);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    second.mockResolvedValue({ busy: false });
    await expect(driver.busy("pi")).rejects.toThrow();
  });
  it.each(["notInstalled", "unavailable", "error"])(
    "rejects a %s connection using the selector inspection",
    async (status) => {
      const f = await fixture();
      f.host.mockResolvedValue({
        status,
        error: { code: "unavailable", message: "synthetic", retryable: true },
      });
      // Invalid statuses also fail closed through the same runtime schema.
      await expect(f.driver.ready("pi").catch(() => false)).resolves.toBe(false);
      expect(f.host).toHaveBeenCalledWith(
        "codexhost/harness/inspect",
        {
          harnessId: "pi",
          refresh: true,
        },
        expect.any(AbortSignal),
      );
    },
  );
  it("accepts ready only through refreshed native inspection", async () => {
    const f = await fixture();
    expect(await f.driver.ready("pi")).toBe(true);
    expect(f.adapter.inspectionCalls).toBe(1);
  });
  it("keeps Claude, Codex and desktop applications out of the RPC agent enumeration", () => {
    for (const agent of ["codex", "claude-code", "zcode", "workbuddy", "../../npm"])
      expect(agentCliUpdateIdSchema.safeParse(agent).success).toBe(false);
  });
  it("checks script-installed Pi but does not invoke an updater without version-pinned rollback", async () => {
    const f = await fixture();
    f.setExecutable(path.join(f.root, "native-pi"));
    expect(await f.driver.inspect("pi")).toMatchObject({
      canUpdate: false,
      reason: "ROLLBACK_UNSUPPORTED",
      latestVersion: "1.1.0",
    });
    expect(f.run.mock.calls.every((call) => call[1][0] === "--version")).toBe(true);
  });
  it("uses official version-pinned OpenCode upgrade in its original native location", async () => {
    const f = await fixture();
    const executable = path.join(f.root, ".opencode", "bin", "opencode");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "synthetic never executed");
    f.setExecutable(executable);
    const installation = await f.driver.inspect("opencode");
    expect(installation?.canUpdate).toBe(true);
    await f.driver.install(required(installation).plan, "1.1.0");
    await f.driver.install(required(installation).plan, "1.0.0");
    expect(f.run).toHaveBeenCalledWith(
      executable,
      ["upgrade", "1.0.0", "--method", "curl"],
      expect.any(Object),
      300_000,
    );
  });
});

describe("review 1 driver regressions (synthetic)", () => {
  it("uses the saved Host launch entrypoint rather than another executable on PATH", async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, "harness-launch-settings"), { recursive: true });
    const selected = path.join(f.root, "custom", "pi.js");
    await mkdir(path.dirname(selected), { recursive: true });
    await writeFile(selected, "synthetic executable, never executed");
    await writeFile(
      path.join(f.root, "harness-launch-settings", "pi.json"),
      JSON.stringify(selected),
    );
    const installation = await f.driver.inspect("pi");
    expect(installation?.plan.executable).toBe(selected);
    expect(
      f.run.mock.calls.filter((c) => c[1][0] === "--version").every((c) => c[0] === selected),
    ).toBe(true);
  });
  it("does not substitute PATH for a saved directory whose adapter-specific entrypoint is unknown", async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, "harness-launch-settings"), { recursive: true });
    await writeFile(
      path.join(f.root, "harness-launch-settings", "pi.json"),
      JSON.stringify(f.root),
    );
    await expect(f.driver.inspect("pi")).rejects.toThrow("ORIGINAL_INSTALLER");
    expect(f.run).not.toHaveBeenCalled();
  });
  it("respects the DeepSeek recipe version pin without querying or installing latest", async () => {
    const f = await fixture("darwin", {
      packageName: "@deepseek-ai/dsh",
      command: "dsh",
      version: "0.1.5-rc.1",
    });
    expect(await f.driver.inspect("deepseek-harness")).toMatchObject({
      canUpdate: false,
      reason: "VERSION_PINNED",
    });
    expect(f.run.mock.calls.some((c) => c[1][0] === "view" || c[1][0] === "install")).toBe(false);
  });
  it("reports PERMISSION_DENIED before npm view/install and rechecks permission immediately before install", async () => {
    const f = await fixture();
    f.writable.mockRejectedValue(Object.assign(new Error("synthetic"), { code: "EACCES" }));
    expect(await f.driver.inspect("pi")).toMatchObject({
      canUpdate: false,
      reason: "PERMISSION_DENIED",
    });
    expect(f.run.mock.calls.some((c) => c[1][0] === "view" || c[1][0] === "install")).toBe(false);
    f.writable.mockResolvedValue(undefined);
    const installation = required(await f.driver.inspect("pi"));
    f.writable.mockRejectedValue(Object.assign(new Error("synthetic"), { code: "EPERM" }));
    await expect(f.driver.install(installation.plan, "1.1.0")).rejects.toThrow(
      "COMMAND_PERMISSION_DENIED",
    );
    expect(f.run.mock.calls.some((c) => c[1][0] === "install")).toBe(false);
  });
  it("treats idle native processes outside the Host as busy", async () => {
    const f = await fixture();
    const installation = required(await f.driver.inspect("pi"));
    f.occupied.mockResolvedValue(true);
    expect(await f.driver.busy("pi", installation.plan)).toBe(true);
  });
  it.each([-32077, -32090, "TimeoutError"])(
    "classifies Host loss/plugin-not-loaded/timeout %s as transient",
    async (code) => {
      const f = await fixture();
      f.host.mockRejectedValue(
        Object.assign(new Error("synthetic host failure"), { code, name: String(code) }),
      );
      await expect(f.driver.ready("pi")).rejects.toThrow("HOST_UNAVAILABLE");
    },
  );
});

describe("custom original npm prefixes (in-memory filesystem, injected npm)", () => {
  it("retains /Volumes/RLY0Dev/Dev/Cache/node-v24 instead of finding a different global prefix", async () => {
    const prefix = "/Volumes/RLY0Dev/Dev/Cache/node-v24";
    const f = await fixture("darwin", { prefix });
    const installation = required(await f.driver.inspect("pi"));
    expect(installation.plan.prefix).toBe(prefix);
    await f.driver.install(installation.plan, "1.1.0");
    expect(f.run).toHaveBeenCalledWith(
      `${prefix}/bin/npm`,
      ["install", "--global", "--prefix", prefix, "@earendil-works/pi-coding-agent@1.1.0"],
      expect.any(Object),
      300_000,
    );
  });
});

describe("Host launch settings readback", () => {
  it("refuses a saved entrypoint which the running Host has not loaded", async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, "harness-launch-settings"), { recursive: true });
    const selected = path.join(f.root, "custom-pi");
    await writeFile(selected, "synthetic");
    await writeFile(
      path.join(f.root, "harness-launch-settings", "pi.json"),
      JSON.stringify(selected),
    );
    f.host.mockImplementation(async (method) =>
      method === HARNESS_LAUNCH_SETTINGS_GET_METHOD
        ? { path: selected, restartRequired: true }
        : { guarded: true, busy: false },
    );
    await expect(f.driver.inspect("pi")).rejects.toThrow("ORIGINAL_INSTALLER");
    expect(f.run).not.toHaveBeenCalled();
  });
});

it("rechecks external occupancy immediately before an install, even after admission succeeded", async () => {
  const f = await fixture();
  const installation = required(await f.driver.inspect("pi"));
  f.occupied.mockResolvedValue(true);
  await expect(f.driver.install(installation.plan, "1.1.0")).rejects.toThrow("BUSY");
  expect(f.run.mock.calls.some((c) => c[1][0] === "install")).toBe(false);
});
