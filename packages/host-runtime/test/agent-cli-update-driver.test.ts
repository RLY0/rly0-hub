import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  agentCliUpdateIdSchema,
  AGENT_CLI_BUSY_METHOD,
  AGENT_CLI_RELEASE_METHOD,
  AGENT_CLI_INSPECT_METHOD,
  HARNESS_LAUNCH_SETTINGS_GET_METHOD,
} from "@codexhost/shared-contracts";
import {
  agentCliPlanExact,
  createAgentCliUpdateDriver,
  type AgentCliPlan,
} from "../src/rly0-hub-service/agent-cli-update-driver.js";
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
  config: {
    prefix?: string;
    packageName?: string;
    command?: string;
    version?: string;
    hosts?: readonly HubHostRequest[];
  } = {},
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
    return [AGENT_CLI_BUSY_METHOD, AGENT_CLI_RELEASE_METHOD].includes(method)
      ? { guarded: true, busy: false, hostPid: 424242 }
      : adapter.inspect();
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
  const writable = vi.fn(async (_file: PathLike, _mode?: number) => {
    void _file;
    void _mode;
  });
  const occupied = vi.fn<NonNullable<Parameters<typeof createAgentCliUpdateDriver>[0]["occupied"]>>(
    async () => false,
  );
  let now = 0;
  const driver = createAgentCliUpdateDriver({
    platform,
    environment: async () => env,
    get: async () => get,
    hosts: async () => [host, ...(config.hosts ?? [])],
    now: () => now,
    installing: () => false,
    run,
    writable,
    occupied,
    discover: () => selected,
    claudeManagedSettings: path.join(root, "managed-settings.json"),
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
    advance: (ms: number) => {
      now += ms;
    },
    setExecutable: (v: string) => {
      selected = v;
    },
  };
}
describe("injected CLI update drivers", () => {
  it("reports Windows EPERM separately from a prefix permission failure", async () => {
    const f = await fixture("win32");
    f.writable.mockRejectedValue(
      Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }),
    );
    expect(await f.driver.inspect("pi")).toMatchObject({
      canUpdate: false,
      reason: "INSTALL_FILE_BUSY",
      // Read-only registry lookup still says whether a newer release exists.
      latestVersion: "1.1.0",
    });
    expect(f.run.mock.calls.some((call) => call[1][0] === "install")).toBe(false);
  });
  it("scans external occupancy before releasing idle Hosts, then scans again without exclusions", async () => {
    const f = await fixture();
    const installation = required(await f.driver.inspect("pi"));
    f.host.mockClear();
    f.occupied.mockImplementation(async (_plan, _env, hostPids) => {
      const releases = f.host.mock.calls.filter(([method]) => method === AGENT_CLI_RELEASE_METHOD);
      expect(releases).toHaveLength(hostPids?.length ? 0 : 1);
      return false;
    });
    expect(await f.driver.busy("pi", installation.plan, true)).toBe(false);
    expect(f.occupied.mock.calls.map((call) => call[2])).toEqual([[424242], []]);
    f.host.mockResolvedValue({ guarded: true, busy: true });
    f.occupied.mockClear();
    expect(await f.driver.busy("pi", installation.plan, true)).toBe(true);
    expect(f.occupied).not.toHaveBeenCalled();
  });
  it("never releases idle sessions while an external process remains busy over six retries", async () => {
    const f = await fixture();
    const installation = required(await f.driver.inspect("pi"));
    f.host.mockClear();
    f.occupied.mockResolvedValue(true);
    for (let minute = 0; minute < 6; minute++) {
      expect(await f.driver.busy("pi", installation.plan, true, "1.1.0")).toBe(true);
      f.advance(60_000);
    }
    expect(f.occupied).toHaveBeenCalledTimes(6);
    expect(f.host.mock.calls.some(([method]) => method === AGENT_CLI_RELEASE_METHOD)).toBe(false);
    f.occupied.mockResolvedValue(false);
    expect(await f.driver.busy("pi", installation.plan, true, "1.1.0")).toBe(false);
    expect(
      f.host.mock.calls.filter(([method]) => method === AGENT_CLI_RELEASE_METHOD),
    ).toHaveLength(1);
  });
  it("does not release one idle Host when another Host is busy or unavailable", async () => {
    const other = vi.fn<HubHostRequest>(async () => ({
      guarded: true,
      busy: true,
      hostPid: 424243,
    }));
    const f = await fixture("darwin", { hosts: [other] });
    const plan: AgentCliPlan = {
      kind: "npm",
      executable: f.executable,
      prefix: f.prefix,
      npm: f.npm,
      packageName: "@earendil-works/pi-coding-agent",
    };
    expect(await f.driver.busy("pi", plan, true, "1.1.0")).toBe(true);
    other.mockRejectedValueOnce(new Error("synthetic Host disconnected"));
    await expect(f.driver.busy("pi", plan, true, "1.1.0")).rejects.toThrow("HOST_UNAVAILABLE");
    expect(f.host.mock.calls.some(([method]) => method === AGENT_CLI_RELEASE_METHOD)).toBe(false);
    expect(f.occupied).not.toHaveBeenCalled();
  });
  it("limits release attempts for the same target and retries after cooldown, including failed closes", async () => {
    const f = await fixture();
    const installation = required(await f.driver.inspect("pi"));
    f.host.mockImplementation(async (method) => ({
      guarded: true,
      busy: method === AGENT_CLI_RELEASE_METHOD,
      hostPid: 424242,
    }));
    f.host.mockClear();
    expect(await f.driver.busy("pi", installation.plan, true, "1.1.0")).toBe(true);
    for (let minute = 0; minute < 5; minute++) {
      f.advance(60_000);
      expect(await f.driver.busy("pi", installation.plan, true, "1.1.0")).toBe(true);
    }
    expect(
      f.host.mock.calls.filter(([method]) => method === AGENT_CLI_RELEASE_METHOD),
    ).toHaveLength(1);
    f.advance(10 * 60_000);
    expect(await f.driver.busy("pi", installation.plan, true, "1.1.0")).toBe(true);
    expect(
      f.host.mock.calls.filter(([method]) => method === AGENT_CLI_RELEASE_METHOD),
    ).toHaveLength(2);
    expect(await f.driver.busy("pi", installation.plan, true, "1.2.0")).toBe(true);
    expect(
      f.host.mock.calls.filter(([method]) => method === AGENT_CLI_RELEASE_METHOD),
    ).toHaveLength(3);
  });
  it("detects an external process appearing during release and refuses to install", async () => {
    const f = await fixture();
    const installation = required(await f.driver.inspect("pi"));
    f.occupied.mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await f.driver.busy("pi", installation.plan, true, "1.1.0")).toBe(true);
    expect(f.run.mock.calls.some((call) => call[1][0] === "install")).toBe(false);
  });
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
        ...(await f.adapter.inspect()),
        status,
        error: { code: "unavailable", message: "synthetic", retryable: true },
      });
      // Invalid statuses also fail closed through the same runtime schema.
      await expect(f.driver.ready("pi").catch(() => false)).resolves.toBe(false);
      expect(f.host).toHaveBeenCalledWith(
        AGENT_CLI_INSPECT_METHOD,
        { agent: "pi" },
        expect.any(AbortSignal),
      );
    },
  );
  it("accepts ready only through refreshed native inspection", async () => {
    const f = await fixture();
    expect(await f.driver.ready("pi")).toBe(true);
    expect(f.adapter.inspectionCalls).toBe(1);
  });
  it("includes Claude Code but keeps Codex and desktop applications out of the RPC agent enumeration", () => {
    expect(agentCliUpdateIdSchema.safeParse("claude-code").success).toBe(true);
    for (const agent of ["codex", "zcode", "workbuddy", "../../npm"])
      expect(agentCliUpdateIdSchema.safeParse(agent).success).toBe(false);
  });
  it("updates Pi in its official installer location with its latest-only updater and refuses a rollback", async () => {
    const f = await fixture();
    const native = path.join(f.root, ".local", "bin", "pi");
    f.setExecutable(native);
    const installation = required(await f.driver.inspect("pi"));
    expect(installation).toMatchObject({
      canUpdate: true,
      reason: null,
      latestVersion: "1.1.0",
      plan: { kind: "native", updater: "update" },
    });
    expect(agentCliPlanExact(installation.plan)).toBe(false);
    await f.driver.install(installation.plan, "1.1.0");
    expect(f.run).toHaveBeenLastCalledWith(
      native,
      ["update"],
      expect.objectContaining({
        PATH: expect.stringMatching(new RegExp(`^${path.dirname(native)}:`)),
      }),
      300_000,
    );
    f.run.mockClear();
    await expect(f.driver.install(installation.plan, "1.0.0", true)).rejects.toThrow(
      "ROLLBACK_UNSUPPORTED",
    );
    expect(f.run).not.toHaveBeenCalled();
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
    expect(f.run).toHaveBeenLastCalledWith(
      executable,
      ["upgrade", "1.1.0", "--method", "curl"],
      expect.any(Object),
      300_000,
    );
    // The rollback runs the copy of the old binary saved before the update, not the new one.
    await f.driver.install(required(installation).plan, "1.0.0", true);
    const rollback = f.run.mock.calls.at(-1);
    expect(rollback?.[0]).not.toBe(executable);
    expect(rollback?.[0].startsWith(path.join(f.root, "agent-cli-backups"))).toBe(true);
    expect(rollback?.[1]).toEqual(["upgrade", "1.0.0", "--method", "curl"]);
    await required(f.driver.settle)(required(installation).plan);
    await expect(readFile(required(rollback?.[0]))).rejects.toThrow();
  });
  it("leaves tools outside their official installer location to the original installer", async () => {
    const f = await fixture();
    f.setExecutable(path.join(f.root, "custom", "pi"));
    expect(await f.driver.inspect("pi")).toMatchObject({
      canUpdate: false,
      reason: "ORIGINAL_INSTALLER",
      latestVersion: "1.1.0",
    });
    const opencode = path.join(f.root, ".local", "bin", "opencode");
    f.setExecutable(opencode);
    expect(await f.driver.inspect("opencode")).toMatchObject({
      canUpdate: false,
      reason: "ORIGINAL_INSTALLER",
    });
  });
  it("updates Grok only when its own check names the native installer", async () => {
    const f = await fixture();
    f.setExecutable(path.join(f.root, ".grok", "bin", "grok"));
    let installer = "npm";
    f.run.mockImplementation(async (_command, args) =>
      args[0] === "update"
        ? JSON.stringify({ latestVersion: "1.1.0", updateAvailable: true, installer })
        : "1.0.0",
    );
    expect(await f.driver.inspect("grok")).toMatchObject({
      canUpdate: false,
      reason: "ORIGINAL_INSTALLER",
    });
    // The official install script reports "internal".
    for (const name of ["internal", "native"]) {
      installer = name;
      expect(await f.driver.inspect("grok")).toMatchObject({
        canUpdate: true,
        plan: { kind: "native", updater: "update" },
      });
    }
    installer = "internal";
    f.setExecutable(path.join(f.root, "elsewhere", "grok"));
    expect(await f.driver.inspect("grok")).toMatchObject({
      canUpdate: false,
      reason: "ORIGINAL_INSTALLER",
    });
  });
  it("treats Cursor without an update status as not updatable, like its adapter", async () => {
    const f = await fixture();
    f.setExecutable(path.join(f.root, ".local", "bin", "cursor-agent"));
    f.run.mockImplementation(async (_command, args) =>
      args[0] === "about" ? JSON.stringify({ latestVersion: "1.1.0" }) : "1.0.0",
    );
    expect(await f.driver.inspect("cursor-cli")).toMatchObject({ canUpdate: false });
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
      latestVersion: "1.1.0",
    });
    expect(f.run.mock.calls.some((c) => c[1][0] === "install")).toBe(false);
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

describe("Claude Code native installation (synthetic HOME, injected commands)", () => {
  async function claude(settings?: unknown) {
    const f = await fixture();
    const versions = path.join(f.root, ".local", "share", "claude", "versions");
    await mkdir(versions, { recursive: true });
    await writeFile(path.join(versions, "1.0.0"), "synthetic never executed");
    const launcher = path.join(f.root, ".local", "bin", "claude");
    await mkdir(path.dirname(launcher), { recursive: true });
    await symlink(path.join(versions, "1.0.0"), launcher);
    if (settings !== undefined) {
      await mkdir(path.join(f.root, ".claude"), { recursive: true });
      await writeFile(path.join(f.root, ".claude", "settings.json"), JSON.stringify(settings));
    }
    f.setExecutable(launcher);
    vi.mocked(f.get).mockImplementation(async (url) => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from(url.endsWith("/stable") ? "1.0.5\n" : "1.1.0\n");
      })(),
      cancel: () => undefined,
    }));
    return { ...f, launcher };
  }
  it("checks its release channel and installs exact versions for update and rollback", async () => {
    const f = await claude();
    const installation = required(await f.driver.inspect("claude-code"));
    expect(installation).toMatchObject({
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      canUpdate: true,
      reason: null,
      plan: { kind: "native", updater: "claude", executable: f.launcher },
    });
    expect(agentCliPlanExact(installation.plan)).toBe(true);
    expect(vi.mocked(f.get).mock.calls[0]?.[0]).toBe(
      "https://downloads.claude.ai/claude-code-releases/latest",
    );
    // Asking the version must never trigger Claude Code's own background updater.
    const versionCall = f.run.mock.calls.find((call) => call[1][0] === "--version");
    expect(versionCall?.[2]).toMatchObject({ DISABLE_AUTOUPDATER: "1" });
    await f.driver.install(installation.plan, "1.1.0");
    await f.driver.install(installation.plan, "1.0.0", true);
    const installs = f.run.mock.calls.filter((call) => call[1][0] === "install");
    expect(installs.map((call) => call[1])).toEqual([
      ["install", "1.1.0", "--force"],
      ["install", "1.0.0", "--force"],
    ]);
    // .local/bin first, so Claude's installer never warns about a missing PATH entry.
    expect(installs[0]?.[2].PATH?.startsWith(path.dirname(f.launcher))).toBe(true);
    // A new versions/<v> file never disturbs running sessions on POSIX: no process scan.
    expect(f.occupied).not.toHaveBeenCalled();
  });
  it("waits for running turns but never closes idle Claude sessions before updating", async () => {
    const f = await claude();
    const installation = required(await f.driver.inspect("claude-code"));
    f.host.mockClear();
    expect(await f.driver.busy("claude-code", installation.plan, true, "1.1.0")).toBe(false);
    expect(f.host.mock.calls.some(([method]) => method === AGENT_CLI_RELEASE_METHOD)).toBe(false);
    expect(f.occupied).not.toHaveBeenCalled();
    f.host.mockResolvedValue({ guarded: true, busy: true });
    expect(await f.driver.busy("claude-code", installation.plan, true, "1.1.0")).toBe(true);
  });
  it("follows Claude's own update policy: channel, user choice, version bounds, managed settings", async () => {
    const stable = await claude({ autoUpdatesChannel: "stable" });
    expect(await stable.driver.inspect("claude-code")).toMatchObject({ latestVersion: "1.0.5" });
    for (const env of [{ DISABLE_UPDATES: "1" }, { DISABLE_AUTOUPDATER: "1" }]) {
      const off = await claude({ env });
      expect(await off.driver.inspect("claude-code")).toMatchObject({
        canUpdate: false,
        reason: "DISABLED_BY_TOOL_SETTINGS",
        latestVersion: "1.1.0",
      });
    }
    for (const bound of [{ minimumVersion: "2.0.0" }, { requiredMaximumVersion: "1.0.9" }]) {
      const pinned = await claude(bound);
      expect(await pinned.driver.inspect("claude-code")).toMatchObject({
        canUpdate: false,
        reason: "VERSION_RANGE_BY_POLICY",
      });
    }
    // A non-string env value is ignored, not a reason to fail the whole check.
    const odd = await claude({ env: { SOMETHING: 1, DISABLE_UPDATES: "0" } });
    expect(await odd.driver.inspect("claude-code")).toMatchObject({ canUpdate: true });
    await expect(
      (await claude({ autoUpdatesChannel: "nightly" })).driver.inspect("claude-code"),
    ).rejects.toThrow("CHECK_FAILED");
    const managed = await claude({ autoUpdatesChannel: "latest" });
    await writeFile(
      path.join(managed.root, "managed-settings.json"),
      JSON.stringify({ env: { DISABLE_UPDATES: "1" } }),
    );
    expect(await managed.driver.inspect("claude-code")).toMatchObject({
      reason: "DISABLED_BY_TOOL_SETTINGS",
    });
  });
  it("rolls back with the retained old binary and checks the versions directory is writable", async () => {
    const f = await claude();
    const installation = required(await f.driver.inspect("claude-code"));
    const versions = path.join(f.root, ".local", "share", "claude", "versions");
    expect(f.writable.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([versions, path.dirname(f.launcher)]),
    );
    await f.driver.install(installation.plan, "1.0.0", true);
    expect(f.run.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      path.join(versions, "1.0.0"),
      ["install", "1.0.0", "--force"],
    ]);
    // A version no longer retained falls back to the launcher.
    await f.driver.install(installation.plan, "0.9.0", true);
    expect(f.run.mock.calls.at(-1)?.[0]).toBe(f.launcher);
    expect(f.driver.fenceDuringInstall?.(installation.plan)).toBe(false);
  });
  it("leaves a Claude Code outside the native launcher to its original installer", async () => {
    const f = await claude();
    const other = path.join(f.root, "elsewhere", "claude");
    await mkdir(path.dirname(other), { recursive: true });
    await writeFile(other, "synthetic never executed");
    f.setExecutable(other);
    expect(await f.driver.inspect("claude-code")).toMatchObject({
      canUpdate: false,
      reason: "ORIGINAL_INSTALLER",
      latestVersion: "1.1.0",
      currentVersion: "1.0.0",
    });
  });
});
