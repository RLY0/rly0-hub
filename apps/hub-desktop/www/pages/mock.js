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
  // Browser-only fixture. These operations never install Docker or access a real project.
  let isolation = null;
  const isolationRoot = "C:\\Users\\demo\\.rly0-hub\\sandbox-runtime";
  return ({ method, params: p }) => {
    switch (method) {
      case "agents.isolation.status":
        return {
          supported: true,
          dockerInstalled: true,
          localClaudeInstalled: true,
          settings: isolation,
          defaultRuntimeRoot: isolationRoot,
          suggestedProxy: "http://127.0.0.1:18888",
          job: { phase: "idle" },
          sandboxes: [],
          projects: isolation?.projects.map((p) => ({ ...p, loggedIn: false, error: null })) || [],
        };
      case "agents.isolation.configure":
        isolation = { version: 1, ...p, projects: isolation?.projects || [] };
        return { ok: true, reloadRequired: true };
      case "agents.isolation.prepare":
        isolation.projects.push({ project: p.project, name: "preview-claude", id: "preview-only" });
        return { started: true };
      case "agents.isolation.forget":
        isolation.projects = isolation.projects.filter((entry) => entry.project !== p.project);
        return { ok: true };
      case "agents.isolation.disable":
        isolation.enabled = false;
        return { ok: true };
      case "agents.isolation.login":
      case "agents.isolation.dockerLogin":
        return { opened: true };
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
        return { advice: [], codexHome: "C:/Users/demo/.codex" };
      case "maintenance.cacheInfo":
        return { totalBytes: 2048, entries: [{ name: "cache", fileCount: 2, sizeBytes: 2048 }] };
      case "maintenance.clearCache":
        return { clearedBytes: 2048 };
      case "maintenance.exportDiagnostics":
        return { filePath: "C:/Users/demo/.rly0-hub/diagnostics/preview.json" };
      case "maintenance.forceQuitCodex":
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
