"use strict";
// Browser preview only. The real bridge never calls this function.
window.hubManagementMock = (() => {
  let servers = [{ name: "docs", type: "http", url: "https://docs.example/mcp", enabled: true }];
  let installed = [{ name: "review", title: "代码审查", description: "检查改动中的问题" }];
  let backups = [
    { name: "writer", title: "写作助手", backupId: "writer-20261016", backedUpAt: "2026-10-16" },
  ];
  const sample = {
    relPath: "2026/10/16/rollout-preview.jsonl",
    fileName: "rollout-preview.jsonl",
    title: "修复 Hub 页面滚动",
    cwd: "F:/Projects/demo",
    sizeBytes: 24000,
    mtimeMs: Date.now(),
  };
  let threads = [sample];
  let trash = [];
  const filters = { imageTool: false, webSearchTool: false };
  const zoomSteps = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
  let zoom = 1.1;
  return ({ method, params: p }) => {
    switch (method) {
      case "window.zoomGet":
        return { zoom, steps: zoomSteps };
      case "window.zoomSet":
        zoom = p.zoom;
        return { zoom, steps: zoomSteps };
      case "proxy.settingsGet":
        return { settings: { mode: "system" } };
      case "proxy.settingsSet":
        return { settings: p.settings, coreRestarted: true };
      case "mcp.list":
        return {
          servers,
          totalCount: servers.length,
          enabledCount: servers.filter((s) => s.enabled).length,
        };
      case "mcp.add":
        servers.push({ ...p, enabled: true });
        return { ok: true };
      case "mcp.remove":
        servers = servers.filter((s) => s.name !== p.name);
        return { ok: true };
      case "mcp.setEnabled":
        servers.find((s) => s.name === p.name).enabled = p.enabled;
        return { ok: true };
      case "skills.list":
        return { installed, backups };
      case "skills.import":
        installed.push({ name: p.name || "imported", title: p.name || "导入的 Skill" });
        return { ok: true };
      case "skills.deactivate": {
        const skill = installed.find((s) => s.name === p.name);
        installed = installed.filter((s) => s.name !== p.name);
        backups.push({ ...skill, backupId: p.name + "-20261016" });
        return { ok: true };
      }
      case "skills.restore": {
        const skill = backups.find((s) => s.backupId === p.backupId);
        installed.push(skill);
        backups = backups.filter((s) => s !== skill);
        return { ok: true };
      }
      case "threads.list":
        return { threads, stats: { totalThreads: threads.length }, truncated: false };
      case "threads.listTrash":
        return { threads: trash, totalCount: trash.length, truncated: false };
      case "threads.trash":
      case "threads.restore": {
        const from = method === "threads.trash" ? threads : trash;
        const to = method === "threads.trash" ? trash : threads;
        const moved = from.filter((t) => p.relPaths.includes(t.relPath));
        to.push(...moved);
        if (method === "threads.trash") threads = from.filter((t) => !moved.includes(t));
        else trash = from.filter((t) => !moved.includes(t));
        return { movedCount: moved.length, failed: [] };
      }
      case "maintenance.diagnostics":
        return {
          advice: ["CONFIG_TOML_INVALID", "CODEX_ENDPOINT_DOWN"],
          codexEndpoint: {
            url: "http://127.0.0.1:17841/v1",
            source: "openai_base_url",
            providerId: "openai",
            local: true,
            reachable: false,
            failure: "REFUSED",
            app: { id: "codex-web-gpt", name: "Codex Web GPT" },
          },
          codexHome: "C:/Users/demo/.codex",
          codexHomeExists: true,
          authJsonExists: true,
          configTomlExists: true,
          configTomlParses: false,
          sessionsDirExists: true,
          core: { available: true, version: "0.1.0" },
        };
      case "maintenance.startEndpointApp":
        return { ok: true };
      case "maintenance.modelCheck":
        return {
          configModel: "gpt-6.1-sol",
          profileModel: false,
          rejection: {
            model: "gpt-6.1-sol",
            at: "2026-10-19T08:07:21.104Z",
            message:
              "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
          },
          choices: [
            { slug: "gpt-6-sol", name: "GPT-6-Sol" },
            { slug: "gpt-6-luna", name: "GPT-6-Luna" },
            { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
          ],
        };
      case "maintenance.setModel":
        return { ok: true, backupPath: "C:/Users/demo/.codex/config.toml.bak-rly0-model-preview" };
      case "maintenance.chatRepairScan":
        return {
          available: true,
          reason: "ok",
          broken: 2,
          deleted: 1,
          items: [
            {
              id: "2a6773ea-31cf-443c-bc30-18b009efef60",
              issue: "missing",
              title: "啥情况这是 而且更新也很慢",
              harnessId: "claude-code",
              updatedAt: "2026-10-18T15:09:48.280Z",
            },
            {
              id: "5b7c1d2e-0000-4000-8000-000000000001",
              issue: "outdated",
              title: "检查项目测试",
              harnessId: "claude-code",
              updatedAt: "2026-10-17T13:33:22.000Z",
            },
            {
              id: "5b7c1d2e-0000-4000-8000-000000000002",
              issue: "deleted",
              title: "测试任务",
              harnessId: "claude-code",
              updatedAt: "2026-10-15T16:40:08.000Z",
            },
          ],
        };
      case "maintenance.chatRepair":
        return {
          ok: true,
          repaired: p && p.includeDeleted ? 3 : 2,
          codexRestarted: true,
          reopenFailed: false,
        };
      case "maintenance.cacheInfo":
        return {
          totalBytes: 28311552,
          entries: [{ name: "updates", fileCount: 1, sizeBytes: 28311552 }],
        };
      case "maintenance.clearCache":
        return { clearedBytes: 28311552, clearedEntries: ["updates"] };
      case "maintenance.exportDiagnostics":
        return { filePath: "C:/Users/demo/.rly0-hub/diagnostics/rly0-diag-preview.json" };
      case "window.capture":
        return { folder: "feedback-20261019-120000" };
      case "maintenance.exportFeedback":
        return {
          folderPath: "C:/Users/demo/.rly0-hub/diagnostics/" + p.folder,
          files: ["screen.png", "diagnostics.json", "errors.json"],
        };
      case "maintenance.openDiagnosticsFolder":
        return { ok: true };
      case "maintenance.filtersGet":
        return {
          available: true,
          imageTool: filters.imageTool,
          webSearchTool: filters.webSearchTool,
        };
      case "maintenance.filtersSet":
        Object.assign(filters, p);
        return { available: true, ...filters };
      case "maintenance.forceQuitCodex":
        return { ok: true, killed: 4 };
      case "maintenance.restartCodex":
        return { ok: true };
      case "updates.check":
        return {
          currentVersion: "0.10.2",
          latestVersion: "0.10.2",
          updateAvailable: false,
          error: null,
          releaseNotes: "Hub 独立管理窗口",
        };
      case "agents.installStart":
      case "agents.installStatus":
        return p.agent === "grok"
          ? {
              state: "failed",
              automatic: true,
              error: "NODE_MISSING",
              requirementReason: "WINGET_UNAVAILABLE",
            }
          : { state: "idle", automatic: true };
      default:
        return null;
    }
  };
})();
