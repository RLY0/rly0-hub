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
  // 账号 page. The first quota lookup (on opening a tab) succeeds; a manual refresh after that
  // also succeeds on the Codex tab, with one account failing, and fails outright on the Claude
  // tab, so both outcomes show without a real backend.
  const at = (seconds) => Math.floor(Date.now() / 1000) + seconds;
  const usage = (used5h, usedWeekly, reset5h, resetWeekly, resetCredits) => ({
    windows: [
      { kind: "primary", usedPercent: used5h, ...(reset5h ? { resetsAt: at(reset5h) } : {}) },
      {
        kind: "secondary",
        usedPercent: usedWeekly,
        ...(resetWeekly ? { resetsAt: at(resetWeekly) } : {}),
      },
    ],
    ...(resetCredits === undefined ? {} : { resetCredits }),
    fetchedAt: at(0),
    source: "snapshot",
  });
  const codexAccounts = [
    {
      id: "0123456789ab",
      email: "me@example.com",
      plan: "plus",
      current: true,
      lastUsage: usage(36, 12, 0, 0, 2),
    },
    {
      id: "1123456789ab",
      email: "team@example.com",
      alias: "团队号",
      plan: "team",
      current: false,
      lastUsage: usage(8, 41, 3000, 260000, 0),
    },
    {
      id: "2123456789ab",
      email: "pro@example.com",
      alias: "Pro 号",
      plan: "pro",
      current: false,
      lastUsage: usage(92, 67, 1500, 120000, 1),
    },
    // An API-key login: no quota to read.
    { id: "3123456789ab", alias: "OpenAI Key 号", current: false },
  ];
  const claudeAccounts = [
    {
      id: "0a1b2c3d4e5f",
      alias: "me@example.com",
      email: "me@example.com",
      plan: "max",
      current: true,
      lastUsage: usage(42, 88, 9000, 400000),
    },
    { id: "abcdefabcdef", alias: "工作号", email: "work@example.com", plan: "pro", current: false },
  ];
  function claudeKey(variant) {
    const base = { kind: "subscription", last4: "QwAA", profileHidden: true };
    if (variant === "network")
      return { ...base, valid: true, usageHidden: true, usageError: "USAGE_NETWORK" };
    if (variant === "invalid")
      return {
        ...base,
        valid: false,
        error: "USAGE_TOKEN_EXPIRED",
        usageHidden: true,
        usageError: "USAGE_TOKEN_EXPIRED",
      };
    return {
      ...base,
      valid: true,
      usage: { ...usage(39, 18, 7200, 300000), source: "live", status: "allowed" },
      usageVia: "headers",
    };
  }
  let codexUsageCalls = 0;
  let claudeUsageCalls = 0;
  const officialKeys = {
    openai: { kind: "apiKey", keyMask: "****Ab12", valid: true, modelCount: 48 },
    // A claude setup-token: no account profile; rly0-core reads its quota off a model
    // response. `?claudeKey=network` / `?claudeKey=invalid` preview the probe failing.
    anthropic: claudeKey(new URLSearchParams(location.search).get("claudeKey")),
    google: null,
    xai: { kind: "apiKey", keyMask: "****xY9z", valid: false, modelCount: 0 },
  };
  // Browser-only fixture. These operations never install Docker or access a real project.
  let isolation = null;
  let isolationLogin = { phase: "idle" };
  const isolatedLogins = new Set();
  const isolationRoot = "C:\\Users\\demo\\.rly0-hub\\sandbox-runtime";
  return ({ method, params: p }) => {
    switch (method) {
      case "window.zoomGet":
        return { zoom, steps: zoomSteps };
      case "window.zoomSet":
        zoom = p.zoom;
        return { zoom, steps: zoomSteps };
      case "agents.isolation.status":
        return {
          supported: true,
          dockerInstalled: true,
          localClaudeInstalled: true,
          settings: isolation,
          defaultRuntimeRoot: isolationRoot,
          suggestedProxy: "http://127.0.0.1:18888",
          job: { phase: "idle" },
          login: isolationLogin,
          sandboxes: [],
          projects:
            isolation?.projects.map((p) => ({
              ...p,
              loggedIn: isolatedLogins.has(p.project),
              error: null,
            })) || [],
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
        isolationLogin = {
          phase: "waitingForCode",
          project: p.project,
          id: "00000000-0000-4000-8000-000000000001",
          browserOpened: true,
        };
        return isolationLogin;
      case "agents.isolation.loginSubmit": {
        const project = isolationLogin.project;
        isolationLogin = { ...isolationLogin, phase: "authorizing" };
        setTimeout(() => {
          isolationLogin = { ...isolationLogin, phase: "succeeded" };
          isolatedLogins.add(project);
        }, 800);
        return isolationLogin;
      }
      case "agents.isolation.loginCancel":
        isolationLogin = { ...isolationLogin, phase: "cancelled" };
        return isolationLogin;
      case "agents.isolation.loginOpen":
        return isolationLogin;
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
      case "accounts.list":
        return { available: true, accounts: codexAccounts };
      case "accounts.usageAll": {
        codexUsageCalls += 1;
        const later = codexUsageCalls > 1;
        if (later) codexAccounts[0].lastUsage = usage(39, 13, 0, 0, 2);
        return {
          __delay: later ? 900 : 300,
          available: true,
          results: codexAccounts.map((a) =>
            a.id === "3123456789ab"
              ? { id: a.id, error: "ACCOUNT_TOKEN_MISSING" }
              : later && a.id === "2123456789ab"
                ? { id: a.id, error: "USAGE_NETWORK" }
                : { id: a.id, usage: a.lastUsage },
          ),
        };
      }
      case "agents.claudeAccounts.list":
        return { accounts: claudeAccounts, liveLoggedIn: true, liveUnsaved: false };
      case "agents.claudeAccounts.usageAll":
        claudeUsageCalls += 1;
        return claudeUsageCalls > 1
          ? { __error: "USAGE_NETWORK", __delay: 900 }
          : {
              __delay: 300,
              results: [
                { id: claudeAccounts[0].id, usage: claudeAccounts[0].lastUsage },
                { id: claudeAccounts[1].id, error: "USAGE_TOKEN_EXPIRED" },
              ],
            };
      case "agents.claudeAccounts.switch":
        return { switched: true };
      case "agents.officialKeys.info":
        return { info: officialKeys[p.vendor] || null };
      case "agents.officialKeys.set":
        officialKeys[p.vendor] = {
          kind: "apiKey",
          keyMask: "****new1",
          valid: true,
          modelCount: 3,
        };
        return { ok: true, valid: true, modelCount: 3 };
      case "agents.officialKeys.remove":
        officialKeys[p.vendor] = null;
        return { ok: true };
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
