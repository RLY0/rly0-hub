import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  agentCliUpdateIdSchema,
  AGENT_CLI_BUSY_METHOD,
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
async function fixture(platform: NodeJS.Platform = "darwin") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "synthetic-cli-driver-")));
  roots.push(root);
  const prefix = platform === "win32" ? "C:\\Synthetic Space & Test\\npm" : root;
  const p = platform === "win32" ? path.win32 : path.posix;
  const executable = p.join(prefix, platform === "win32" ? "pi.cmd" : "bin/pi");
  const directory = p.join(
    prefix,
    ...(platform === "win32" ? [] : ["lib"]),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const binary = p.join(directory, "dist/cli.js");
  const npm = p.join(prefix, platform === "win32" ? "npm.cmd" : "bin/npm");
  const files: Record<string, string> = {
    [p.join(directory, "package.json")]: JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.0.0",
      bin: { pi: "dist/cli.js" },
    }),
    [executable]: '"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js"',
  };
  let selected = executable;
  let current = "1.0.0";
  const run = vi.fn(
    async (
      _command: string,
      args: readonly string[],
      _env: NodeJS.ProcessEnv,
      _timeout?: number,
    ) => {
      void _env;
      void _timeout;
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
  const host = vi.fn<HubHostRequest>(async (method) =>
    method === AGENT_CLI_BUSY_METHOD ? { guarded: true, busy: false } : adapter.inspect(),
  );
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CODEXHOST_DATA_DIR: root,
    RLY0_MEMORY_DIR: path.join(root, "memory"),
    RLY0_SKIP_LEGACY_IMPORT: "1",
    HTTPS_PROXY: "http://127.0.0.1:synthetic",
  };
  const driver = createAgentCliUpdateDriver({
    platform,
    environment: async () => env,
    get: async () => get,
    hosts: async () => [host],
    installing: () => false,
    run,
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
      expect(f.get).toHaveBeenCalledWith(
        "https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent/latest",
        expect.any(Object),
      );
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
      expect(f.host).toHaveBeenCalledWith("codexhost/harness/inspect", {
        harnessId: "pi",
        refresh: true,
      });
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
