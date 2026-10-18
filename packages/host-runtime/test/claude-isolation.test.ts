import type * as SandboxRuntime from "@codexhost/sandbox-runtime";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxSettings } from "@codexhost/shared-contracts";

const fake = vi.hoisted(() => ({
  installed: true,
  boxes: [] as Array<{
    name: string;
    id: string;
    agent: string;
    status: string;
    workspaces: string[];
  }>,
  run: vi.fn(),
  proxy: vi.fn(),
  install: vi.fn(),
}));
vi.mock("@codexhost/sandbox-runtime", async (original) => ({
  ...(await original<typeof SandboxRuntime>()),
  resolveSandboxCommand: () => {
    if (!fake.installed) throw new Error("missing");
    return "sbx.exe";
  },
  runSandboxCommand: (...args: unknown[]) => fake.run(...args),
  verifySandboxProxy: (...args: unknown[]) => fake.proxy(...args),
  listDockerSandboxes: async () => fake.boxes,
}));
vi.mock("../src/rly0-agents/agent-installer.js", () => ({
  processRunner: {
    run: (...args: unknown[]) => fake.install(...args),
    openTerminal: vi.fn(async () => true),
  },
}));
import { readSandboxSettings, writeSandboxSettings } from "@codexhost/sandbox-runtime";
import { ClaudeIsolation } from "../src/rly0-hub-service/claude-isolation.js";

const roots: string[] = [];
beforeEach(() => {
  fake.installed = true;
  fake.boxes = [];
  fake.run.mockReset().mockResolvedValue('{"loggedIn":false}');
  fake.proxy.mockReset().mockResolvedValue(undefined);
  fake.install.mockReset().mockResolvedValue({ code: 0 });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-isolation-service-"));
  roots.push(root);
  const project = path.join(root, "project");
  await mkdir(project);
  const environment = {
    CODEXHOST_DATA_DIR: path.join(root, "data"),
    USERPROFILE: path.join(root, "home"),
    PATH: "",
  };
  const settings: SandboxSettings = {
    version: 1,
    enabled: false,
    runtimeRoot: path.join(root, "runtime"),
    proxy: "http://127.0.0.1:12345",
    projects: [],
  };
  await writeSandboxSettings(environment, settings);
  return { environment, settings, project, service: new ClaudeIsolation(environment, "win32") };
}

describe("Hub Claude isolation lifecycle", () => {
  it("detects Docker and sandbox availability independently of host Claude installation", async () => {
    const { environment, settings, project, service } = await fixture();
    let status = await service.status();
    expect(status).toMatchObject({ dockerInstalled: true, localClaudeInstalled: false });
    fake.installed = false;
    expect(await service.status()).toMatchObject({ dockerInstalled: false });
    fake.installed = true;
    await writeSandboxSettings(environment, {
      ...settings,
      enabled: true,
      projects: [{ project, name: "existing-claude", id: "1" }],
    });
    fake.boxes = [
      {
        name: "existing-claude",
        id: "1",
        agent: "claude",
        status: "running",
        workspaces: [project],
      },
    ];
    status = await service.status();
    expect(status).toMatchObject({
      localClaudeInstalled: false,
      projects: [{ loggedIn: false, error: null }],
    });
  });
  it("does not start a stopped VM just to paint the status page", async () => {
    const { environment, settings, project, service } = await fixture();
    await writeSandboxSettings(environment, {
      ...settings,
      projects: [{ project, name: "existing-claude", id: "1" }],
    });
    fake.boxes = [
      {
        name: "existing-claude",
        id: "1",
        agent: "claude",
        status: "stopped",
        workspaces: [project],
      },
    ];
    expect(await service.status()).toMatchObject({ projects: [{ loggedIn: null }] });
    expect(fake.run).not.toHaveBeenCalled();
  });
  it("adopts only the exact workspace and applies the guest guard before granting access", async () => {
    if (process.platform !== "win32") return;
    const { environment, project, service } = await fixture();
    fake.boxes = [
      {
        name: "existing-claude",
        id: "1",
        agent: "claude",
        status: "running",
        workspaces: [project],
      },
    ];
    service.prepare({ project, name: "existing-claude" });
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({ job: { phase: "succeeded" } }),
    );
    expect(readSandboxSettings(environment)?.projects).toEqual([
      { project, name: "existing-claude", id: "1" },
    ]);
    expect(fake.run.mock.calls.some(([, , args]) => args.includes("python3"))).toBe(true);
    expect(fake.run.mock.calls.some(([, , args]) => args.includes("create"))).toBe(false);
  });
  it("rejects extra mounts and proxy failures without enabling local execution", async () => {
    if (process.platform !== "win32") return;
    const { environment, project, service } = await fixture();
    fake.boxes = [
      {
        name: "existing-claude",
        id: "1",
        agent: "claude",
        status: "running",
        workspaces: [project, path.dirname(project)],
      },
    ];
    service.prepare({ project, name: "existing-claude" });
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        job: { phase: "failed", error: "ISOLATION_WORKSPACE_MISMATCH" },
      }),
    );
    expect(readSandboxSettings(environment)?.projects).toEqual([]);
    fake.proxy.mockRejectedValue(new Error("ISOLATION_PROXY_UNAVAILABLE"));
    await expect(
      service.configure({
        enabled: true,
        runtimeRoot: "C:\\runtime",
        proxy: "http://127.0.0.1:12345",
      }),
    ).rejects.toThrow();
    expect(readSandboxSettings(environment)?.enabled).toBe(false);
  });
  it("cancels authorization without pretending the Docker image pull was cancelled", async () => {
    if (process.platform !== "win32") return;
    const { environment, project, service } = await fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fake.run.mockImplementation(async (_env, _settings, args: string[]) => {
      if (args[0] === "create") await pending;
      return "";
    });
    service.prepare({ project });
    await vi.waitFor(() => expect(fake.run).toHaveBeenCalled());
    expect(service.cancel()).toEqual({ ok: true, dockerMayStillBePreparing: true });
    finish();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({ job: { phase: "cancelled" } }),
    );
    expect(readSandboxSettings(environment)?.projects).toEqual([]);
  });
  it("rediscovers the executable after installation even when winget returns success", async () => {
    const { service } = await fixture();
    fake.installed = false;
    service.install();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        job: { phase: "failed", error: "ISOLATION_DOCKER_MISSING" },
      }),
    );
  });
});
