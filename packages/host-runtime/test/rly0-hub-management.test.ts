import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Rly0CoreBridge } from "../src/rly0-core/index.js";
import { listRly0HubAgents } from "../src/rly0-hub-service/agents.js";
import { Rly0HubService, type Rly0HubServiceOptions } from "../src/rly0-hub-service/service.js";
import { checkHubUpdate } from "../src/rly0-hub-service/update-check.js";
import { rly0HubStatus } from "../src/rly0-appearance/hub-autostart.js";

let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(options: Pick<Rly0HubServiceOptions, "updates"> = {}) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-hub-management-"));
  const codexHome = path.join(root, "codex");
  await fs.mkdir(codexHome);
  const core = {
    status: async () => ({ available: false }),
    filters: async () => null,
    getProxySettings: () => ({ mode: "system" }),
    setProxySettings: async (settings: unknown) => ({ settings, coreRestarted: false }),
  } as unknown as Rly0CoreBridge;
  const service = new Rly0HubService({
    environment: {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: codexHome,
      CODEXHOST_DATA_DIR: path.join(root, "hub"),
    },
    installRoot: root,
    core,
    ...options,
  });
  return { service, codexHome };
}

describe("independent Hub management", () => {
  it("validates every route before invoking managers and fits the shell method allowlist", async () => {
    const { service } = await fixture();
    for (const method of service.methods) {
      expect(method).toMatch(/^[a-z]+(\.[a-zA-Z]+){1,2}$/u);
      await expect(service.handle(method, { unexpected: true })).rejects.toThrow("INVALID_PARAMS");
    }
    await expect(
      service.handle("threads.trash", { relPaths: ["../rollout-x.jsonl"] }),
    ).rejects.toThrow("INVALID_PARAMS");
    await expect(
      service.handle("maintenance.exportFeedback", { folder: "../x", errors: [] }),
    ).rejects.toThrow("INVALID_PARAMS");
    await expect(
      service.handle("maintenance.exportFeedback", {
        folder: "feedback-20261019-080910",
        errors: ["x".repeat(501)],
      }),
    ).rejects.toThrow("INVALID_PARAMS");
    await expect(
      service.handle("maintenance.openDiagnosticsFolder", { folder: "..\\..\\Windows" }),
    ).rejects.toThrow("INVALID_PARAMS");
    await expect(service.handle("skills.deactivate", { name: "../outside" })).rejects.toThrow(
      "INVALID_PARAMS",
    );
  });

  it("shares MCP and skills by default and toggles each kind for every agent", async () => {
    const { service } = await fixture();
    const initial = (await service.handle("resources.sharingGet", {})) as {
      mcp: boolean;
      skills: boolean;
      memory: boolean;
      agents: { id: string; support: Record<string, boolean>; note: string | null }[];
    };
    expect(initial).toMatchObject({ mcp: true, skills: true, memory: false, enabled: true });
    expect(initial.agents.find((agent) => agent.id === "antigravity")).toMatchObject({
      support: { mcp: false, skills: true, memory: true },
      note: "Antigravity 命令行接入无法挂载 MCP",
    });
    expect(initial.agents.find((agent) => agent.id === "pi")).toMatchObject({
      support: { mcp: false, skills: false, memory: false },
    });
    expect(await service.handle("resources.sharingSet", { memory: true })).toMatchObject({
      mcp: true,
      skills: true,
      memory: true,
    });
    expect(await service.handle("resources.sharingSet", { enabled: false })).toMatchObject({
      mcp: false,
      skills: false,
      memory: false,
      enabled: false,
    });
    await expect(service.handle("resources.sharingSet", { mcp: "yes" })).rejects.toThrow(
      "INVALID_PARAMS",
    );
  });

  it("adds, toggles and removes MCP without a running Codex and hides parser details", async () => {
    const { service, codexHome } = await fixture();
    await service.handle("mcp.add", {
      name: "docs",
      type: "http",
      url: "https://docs.example/mcp",
    });
    expect(await service.handle("mcp.list", {})).toMatchObject({ enabledCount: 1 });
    await service.handle("mcp.setEnabled", { name: "docs", enabled: false });
    expect(await service.handle("mcp.list", {})).toMatchObject({ enabledCount: 0 });
    await expect(
      service.handle("mcp.add", { name: "docs", type: "stdio", command: "demo" }),
    ).rejects.toThrow("MCP_SERVER_ALREADY_EXISTS");
    await service.handle("mcp.remove", { name: "docs" });
    expect(await service.handle("mcp.list", {})).toMatchObject({ totalCount: 0 });
    await fs.writeFile(path.join(codexHome, "config.toml"), "broken = [ fixture-content");
    expect(await service.handle("mcp.list", {})).toMatchObject({
      parseError: "MCP_CONFIG_INVALID",
    });
  });

  it("imports, deactivates and restores skills inside an isolated home", async () => {
    const { service } = await fixture();
    const sourcePath = path.join(root, "review");
    await fs.mkdir(sourcePath);
    await fs.writeFile(
      path.join(sourcePath, "SKILL.md"),
      "---\nname: Review\ndescription: Review code\n---\n",
    );
    await service.handle("skills.import", { sourcePath });
    expect(await service.handle("skills.list", {})).toMatchObject({ installedCount: 1 });
    const result = (await service.handle("skills.deactivate", { name: "review" })) as {
      backupId: string;
    };
    expect(await service.handle("skills.list", {})).toMatchObject({
      installedCount: 0,
      backups: [{ name: "review" }],
    });
    await service.handle("skills.restore", { backupId: result.backupId });
    expect(await service.handle("skills.list", {})).toMatchObject({
      installedCount: 1,
      backups: [],
    });
    await expect(
      service.handle("skills.import", { sourcePath: path.join(root, "missing") }),
    ).rejects.toThrow("SKILL_SOURCE_INVALID");
  });

  it("lists and reversibly moves session files and reports partial failure", async () => {
    const { service, codexHome } = await fixture();
    const sessions = path.join(codexHome, "sessions");
    await fs.mkdir(sessions);
    await fs.writeFile(
      path.join(sessions, "rollout-demo.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { cwd: "demo" } }) + "\n",
    );
    expect(await service.handle("threads.list", { limit: 1 })).toMatchObject({
      stats: { totalThreads: 1 },
      truncated: false,
    });
    // 首页 → Codex 概况: totals and the 12-week activity, as the former in-Codex 仪表盘 had.
    const overview = (await service.handle("dashboard.threadStats", {})) as {
      stats: { totalThreads: number };
      activity: { count: number }[];
    };
    expect(overview.stats.totalThreads).toBe(1);
    expect(overview.activity).toHaveLength(84);
    expect(overview.activity.reduce((sum, day) => sum + day.count, 0)).toBe(1);
    expect(
      await service.handle("threads.trash", {
        relPaths: ["rollout-demo.jsonl", "rollout-missing.jsonl"],
      }),
    ).toMatchObject({ movedCount: 1, failed: [{ code: "THREAD_NOT_FOUND" }] });
    expect(await service.handle("threads.listTrash", {})).toMatchObject({ totalCount: 1 });
    expect(
      await service.handle("threads.restore", { relPaths: ["rollout-demo.jsonl"] }),
    ).toMatchObject({ movedCount: 1 });
  });

  it("exports sanitized diagnostics and clears only the Hub cache", async () => {
    const { service, codexHome } = await fixture();
    await fs.writeFile(path.join(codexHome, "config.toml"), "model = 'demo'\n");
    const cache = path.join(root, "hub", "cache");
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, "demo"), "fixture");
    expect(await service.handle("maintenance.diagnostics", {})).toMatchObject({
      configTomlParses: true,
    });
    expect(await service.handle("maintenance.cacheInfo", {})).toMatchObject({ totalBytes: 7 });
    const result = (await service.handle("maintenance.exportDiagnostics", {})) as {
      filePath: string;
    };
    const payload = await fs.readFile(result.filePath, "utf8");
    expect(payload).not.toContain("model =");
    expect(await service.handle("maintenance.clearCache", {})).toMatchObject({ clearedBytes: 7 });
    expect(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")).toContain("model =");
    expect(await fs.stat(result.filePath)).toBeDefined();
    expect(await service.handle("maintenance.forceQuitCodex", {})).toEqual({ ok: false });
    expect(await service.handle("maintenance.restartCodex", {})).toEqual({ ok: false });
  });

  it("clears downloaded installers when idle and reports filters without a core", async () => {
    const { service } = await fixture();
    const updates = path.join(root, "hub", "updates");
    await fs.mkdir(updates, { recursive: true });
    await fs.writeFile(path.join(updates, "setup.exe"), "installer");
    expect(await service.handle("maintenance.clearCache", {})).toMatchObject({
      clearedEntries: ["updates"],
    });
    await expect(fs.stat(updates)).rejects.toThrow();
    expect(await service.handle("maintenance.filtersGet", {})).toEqual({ available: false });
    await expect(service.handle("maintenance.filtersSet", { imageTool: "on" })).rejects.toThrow();
  });

  it("routes proxy settings and update checks without leaking error details", async () => {
    const check = vi.fn(async () => ({
      currentVersion: "0.10.2",
      latestVersion: null,
      updateAvailable: false,
      installation: null,
      installationAvailable: false,
      releaseNotes: null,
      releaseNotesUrl: null,
      status: null,
      error: "private upstream error detail",
    }));
    const { service } = await fixture({ updates: { check } });
    expect(await service.handle("proxy.settingsGet", {})).toEqual({ settings: { mode: "system" } });
    expect(
      await service.handle("proxy.settingsSet", { settings: { mode: "direct" } }),
    ).toMatchObject({ settings: { mode: "direct" } });
    await expect(
      service.handle("proxy.settingsSet", { settings: { mode: "custom" } }),
    ).rejects.toThrow("INVALID_PARAMS");
    expect(await service.handle("updates.check", {})).toMatchObject({
      error: "UPDATE_CHECK_FAILED",
    });
    check.mockRejectedValueOnce(new Error("private filesystem detail"));
    await expect(service.handle("updates.check", {})).rejects.toThrow("UPDATE_CHECK_FAILED");
  });

  it("checks updates with metadata alone, without Launcher or auth environment", async () => {
    await fixture();
    await fs.mkdir(path.join(root, "app"));
    await fs.writeFile(
      path.join(root, "app", "codexhost-distribution.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "0.10.2",
        distribution: "installer",
        target: "windows-x64",
      }),
    );
    const fetchLatest = vi.fn(async () => ({
      version: "0.10.3",
      releaseNotes: "New",
      releaseNotesUrl: "https://github.com/RLY0/rly0-hub/releases/tag/v0.10.3",
      assets: [],
    }));
    expect(await checkHubUpdate(root, fetchLatest)).toMatchObject({
      currentVersion: "0.10.2",
      latestVersion: "0.10.3",
      updateAvailable: true,
      error: null,
    });
    expect(
      await checkHubUpdate(root, async () => {
        throw new Error("private detail");
      }),
    ).toMatchObject({ error: "UPDATE_CHECK_FAILED" });
  });

  it("detects an npm-installed agent from the npm folder", () => {
    const agents = listRly0HubAgents(
      { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
      "win32",
      (file) => file.toLowerCase().endsWith("\\npm\\opencode.cmd"),
    );
    expect(agents.find((a) => a.id === "opencode")).toMatchObject({
      installed: true,
      canOpenLogin: true,
    });
    expect(agents.find((a) => a.id === "grok")).toMatchObject({ installed: false });
    expect(rly0HubStatus("C:\\Hub", () => true, "win32")).toEqual({ available: true });
    expect(rly0HubStatus("C:\\Hub", () => false, "win32")).toEqual({ available: false });
  });
});
