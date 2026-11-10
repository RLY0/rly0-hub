import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { runInstallationCommand } from "@codexhost/harness-discovery";
import {
  assertCliWritable,
  cliProcessBusy,
  cliUpdateProxyEnvironment,
} from "../src/rly0-hub-service/agent-cli-update-system.js";
import type { AgentCliPlan } from "../src/rly0-hub-service/agent-cli-update-driver.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(platform: NodeJS.Platform = "darwin") {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-cli-system-"));
  roots.push(root);
  const env = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CODEXHOST_DATA_DIR: root,
    RLY0_MEMORY_DIR: path.join(root, "memory"),
    RLY0_SKIP_LEGACY_IMPORT: "1",
  };
  const p = platform === "win32" ? path.win32 : path.posix;
  const prefix =
    platform === "win32"
      ? "C:\\Synthetic Node Space\\node-v24"
      : "/Volumes/RLY0Dev/Dev/Cache/node-v24";
  const plan: AgentCliPlan = {
    kind: "npm",
    prefix,
    packageName: "opencode-ai",
    npm: p.join(prefix, platform === "win32" ? "npm.cmd" : "bin/npm"),
    executable: p.join(prefix, platform === "win32" ? "opencode.cmd" : "bin/opencode"),
  };
  return { env, plan, p, prefix };
}
describe("CLI update OS preflights with injected commands and filesystem", () => {
  it.each(["darwin", "win32"] as const)(
    "checks writable original %s prefix and bin/package directories",
    async (platform) => {
      const f = await fixture(platform);
      const access = vi.fn(async () => undefined);
      await assertCliWritable(f.plan, platform, access);
      expect(access).toHaveBeenCalledWith(f.prefix, expect.any(Number));
      expect(access).toHaveBeenCalledWith(
        f.p.join(f.prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules"),
        expect.any(Number),
      );
      if (platform !== "win32")
        expect(access).toHaveBeenCalledWith(f.p.join(f.prefix, "bin"), expect.any(Number));
    },
  );
  it.each(["EACCES", "EPERM"])(
    "fails before install when a root-owned directory gives %s",
    async (code) => {
      const f = await fixture();
      const access = vi.fn(async () => {
        throw Object.assign(new Error("synthetic permission"), { code });
      });
      await expect(assertCliWritable(f.plan, "darwin", access)).rejects.toThrow(
        "COMMAND_PERMISSION_DENIED",
      );
    },
  );
  it.each(["darwin", "win32"] as const)(
    "finds an idle %s opencode serve or external terminal using the package",
    async (platform) => {
      const f = await fixture(platform);
      const entry = f.p.join(
        f.prefix,
        ...(platform === "win32" ? [] : ["lib"]),
        "node_modules",
        "opencode-ai",
        "bin",
        "opencode",
      );
      const text = `"${entry}" serve --port 8080`;
      const output =
        platform === "win32"
          ? JSON.stringify([
              { ProcessId: 424242, ExecutablePath: "C:\\Node\\node.exe", CommandLine: text },
            ])
          : `424242 /some/node ${text}`;
      const run = vi.fn<typeof runInstallationCommand>(async () => output);
      expect(await cliProcessBusy(f.plan, f.env, platform, run, async () => entry)).toBe(true);
      expect(run).toHaveBeenCalledWith(
        platform === "win32" ? "powershell.exe" : "/bin/ps",
        expect.any(Array),
        f.env,
        5_000,
      );
    },
  );
  it("finds a selected shim while ignoring similarly named packages and an unrelated Node under the same prefix", async () => {
    const f = await fixture();
    const run = vi.fn<typeof runInstallationCommand>(
      async () => `424242 ${f.plan.executable} auth login`,
    );
    expect(await cliProcessBusy(f.plan, f.env, "darwin", run, async (v) => v)).toBe(true);
    run.mockResolvedValue(
      `424242 ${f.prefix}/bin/node /else/hub-service.mjs\n424243 ${f.plan.executable}-other\n424244 ${f.prefix}/lib/node_modules/opencode-ai-other/bin/run`,
    );
    expect(await cliProcessBusy(f.plan, f.env, "darwin", run, async (v) => v)).toBe(false);
  });
  it("preserves npmrc proxy fallback when Hub has no explicit proxy", async () => {
    const f = await fixture();
    expect(cliUpdateProxyEnvironment(f.env, null)).toEqual(f.env);
    expect(
      cliUpdateProxyEnvironment({ ...f.env, npm_config_proxy: "http://synthetic-user-proxy" }, null)
        .npm_config_proxy,
    ).toBe("http://synthetic-user-proxy");
    expect(cliUpdateProxyEnvironment(f.env, "http://synthetic-hub-proxy")).toMatchObject({
      npm_config_proxy: "http://synthetic-hub-proxy",
      npm_config_https_proxy: "http://synthetic-hub-proxy",
    });
    expect(cliUpdateProxyEnvironment(f.env, null)).not.toHaveProperty("npm_config_proxy");
  });
});

it("defers a native process which rewrote its title to opencode serve", async () => {
  const f = await fixture();
  const run = vi.fn<typeof runInstallationCommand>(async () => "424242 opencode serve --port 8080");
  expect(await cliProcessBusy(f.plan, f.env, "darwin", run, async (v) => v)).toBe(true);
});
