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
  const sharing = { mcp: true, skills: true, memory: true };
  const ACP = ["native", "context", "native"];
  const NONE3 = ["none", "none", "none"];
  const sharingAgents = [
    ["claude-code", "Claude Code", true, ACP, "开启 Claude 隔离模式时不共享"],
    [
      "antigravity",
      "Antigravity",
      false,
      ["global", "context", "context"],
      "agy 只读取全局 ~/.gemini/config/mcp_config.json，需在打通设置里单独开启",
    ],
    ["grok", "Grok", false, ACP, null],
    ["opencode", "OpenCode", true, ACP, null],
    ["pi", "Pi", true, ["native", "native", "native"], null],
    [
      "hermes",
      "Hermes",
      true,
      ["global", "native", "context"],
      "Hermes 只从全局 ~/.hermes/config.yaml 读取 MCP，需在打通设置里单独开启",
    ],
    ["cursor-cli", "Cursor", false, ACP, null],
    ["kiro-cli", "Kiro", false, ACP, null],
    ["kimi-code", "Kimi Code", false, ACP, null],
    ["deepseek-harness", "DeepSeek", false, NONE3, "DeepSeek 接入没有 MCP 或附加上下文的入口"],
  ];
  const sharingState = () => ({
    ...sharing,
    enabled: sharing.mcp || sharing.skills || sharing.memory,
    defaults: { mcp: true, skills: true, memory: true },
    agents: sharingAgents.map(([id, name, installed, [mcp, skills, memory], note]) => ({
      id,
      name,
      installed,
      support: { mcp: mcp === "native", skills: skills !== "none", memory: memory !== "none" },
      modes: { mcp, skills, memory },
      blocked: null,
      note,
    })),
  });
  const globals = [
    {
      agent: "antigravity",
      enabled: false,
      file: "C:\\Users\\me\\.gemini\\config\\mcp_config.json",
      servers: [],
      skipped: [],
    },
    {
      agent: "hermes",
      enabled: false,
      file: "C:\\Users\\me\\.hermes\\config.yaml",
      servers: [],
      skipped: [],
    },
  ];
  let memories = [
    {
      id: "m1",
      text: "提交前先跑 npm run typecheck，再跑 sync-workspace-copies。",
      tags: ["workflow"],
      agent: "claude-code",
      scope: "project",
      project: "f:/dev/projects/rly0-hub",
      time: Date.now() - 3600e3,
      source: null,
    },
    {
      id: "m2",
      text: "回复用中文，结论先说。",
      tags: [],
      agent: "codex",
      scope: "global",
      project: null,
      time: Date.now() - 86400e3,
      source: "import",
    },
    {
      id: "m3",
      text: "部署脚本在 scripts/release 下，发布前不要推送。",
      tags: ["release"],
      agent: "pi",
      scope: "project",
      project: "f:/dev/projects/rly0-hub",
      time: Date.now() - 7200e3,
      source: null,
    },
  ];
  let trash = [];
  const launchPaths = {};
  // 设置 → 通用 → Codex 里: soft wrap on, the rest as Codex's defaults.
  let codexPrefs = { updatedAt: 1, reasoningSoftWrap: true };
  let recoveredHistory = false;
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
    {
      id: "abcdefabcdef",
      alias: "工作号",
      email: "work@example.com",
      plan: "pro",
      current: false,
      lastUsage: usage(15, 33, 12000, 350000),
    },
    // Signed out elsewhere: rly0-core cannot renew its token any more.
    { id: "fedcba987654", alias: "旧号", email: "old@example.com", plan: "pro", current: false },
  ];
  const claudeUsage = (account) =>
    account.id === "fedcba987654"
      ? { id: account.id, error: "ACCOUNT_REFRESH_REJECTED" }
      : { id: account.id, usage: account.lastUsage };
  // 网页登录 (add a Claude account without signing out): waiting → code pasted → saved.
  let claudeAdd = { phase: "idle" };
  function claudeKey(variant) {
    const base = { kind: "subscription", last4: "QwAA", profileHidden: true };
    if (variant === "network")
      return { ...base, valid: true, usageHidden: true, usageError: "USAGE_NETWORK" };
    if (variant === "rateLimited")
      return { ...base, valid: true, usageError: "USAGE_RATE_LIMITED", usageStatus: 429 };
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
  // Grok (测试版): a weekly and a monthly account, plus one whose saved login has expired
  // (the Hub never renews Grok tokens; switching lets the Grok CLI do it).
  const credits = (kind, used, reset) => ({
    windows: [
      {
        kind,
        usedPercent: used,
        resetsAt: at(reset),
        ...(kind === "weekly" ? { windowSeconds: 604800 } : {}),
      },
    ],
    fetchedAt: at(0),
    source: "live",
  });
  const grokAccounts = [
    {
      id: "6a6b6c6d6e6f",
      alias: "me@example.com",
      email: "me@example.com",
      current: true,
      loginExpired: false,
      lastUsage: credits("weekly", 27, 300000),
    },
    {
      id: "7a7b7c7d7e7f",
      alias: "SuperGrok 号",
      email: "super@example.com",
      current: false,
      loginExpired: false,
      lastUsage: credits("monthly", 64, 1500000),
    },
    {
      id: "8a8b8c8d8e8f",
      alias: "旧号",
      email: "old@example.com",
      current: false,
      loginExpired: true,
    },
  ];
  const grokUsage = (account) =>
    account.loginExpired && !account.current
      ? { id: account.id, error: "USAGE_TOKEN_EXPIRED" }
      : { id: account.id, usage: account.lastUsage };
  let grokAdd = { phase: "idle" };
  let grokAddPolls = 0;
  // Gemini (Antigravity): only the current login's /usage. `?agy=missing` previews it not installed.
  const agyInstalled = new URLSearchParams(location.search).get("agy") !== "missing";
  let agyCalls = 0;
  const agyUsage = () => ({
    windows: [
      { kind: "primary", label: "Gemini Models · 5 小时额度", usedPercent: 0, resetsAt: at(16000) },
      {
        kind: "secondary",
        label: "Gemini Models · 每周额度",
        usedPercent: 2.6,
        resetsAt: at(45000),
      },
      {
        kind: "secondary",
        label: "Claude and GPT models · 每周额度",
        usedPercent: 40,
        resetsAt: at(500000),
      },
    ],
    fetchedAt: at(0),
  });
  let agyState = { installed: agyInstalled };
  if (new URLSearchParams(location.search).get("agyCache") === "1") {
    agyState = {
      ...agyState,
      usage: { ...agyUsage(), fetchedAt: Math.floor(Date.now() / 1000) - 600 },
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
  const claudeUsesKey = new URLSearchParams(location.search).get("claudeUses") === "key";
  // SYNTHETIC browser-only multi-credential state, never used by the real bridge.
  let selectedClaudeKey = claudeUsesKey ? "cccccccccccc" : null;
  let keySequence = 0;
  let keyRevisionSequence = 1000;
  const claudeKeys = new Map([
    [
      "cccccccccccc",
      {
        ...officialKeys.anthropic,
        id: "cccccccccccc",
        name: "Claude 订阅令牌",
        keyRevision: "c".repeat(64),
      },
    ],
    [
      "dddddddddddd",
      {
        ...claudeKey(null),
        id: "dddddddddddd",
        name: "Claude 订阅令牌",
        last4: "cd34",
        keyRevision: "d".repeat(64),
      },
    ],
  ]);
  // Browser-only fixture. These operations never install Docker or access a real project.
  let isolation = null;
  let isolationLogin = { phase: "idle" };
  const isolatedLogins = new Set();
  // Synthetic reset protocol for this browser-only preview. Never reached by the real bridge.
  const resetRequests = new Set();
  // Claude / Grok auto-switch (agent-auto-switch.ts): off and unconfirmed until turned on.
  const agentAutoSwitch = {
    claude: { enabled: false, remain5h: 15, remainWeekly: 10, mode: "ask", riskAccepted: false },
    grok: { enabled: false, remain5h: 15, remainWeekly: 10, mode: "ask", riskAccepted: false },
  };
  // Synthetic no-account switch (pages/no-account.js); nothing is written anywhere.
  const noAccount = { enabled: false, model: null };
  const unified = { enabled: true };
  const noAccountModels = ["gpt-6-astra", "gpt-5.5"];
  const codexConfigPath = "C:\\Users\\demo\\.codex\\config.toml";
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
      case "agents.launchPathGet":
        return { path: launchPaths[p.agent] || null, restartRequired: false };
      case "agents.launchPathSet":
        launchPaths[p.agent] = p.path;
        return { path: p.path, restartRequired: true };
      case "prefs.codexGet":
        return { preferences: codexPrefs };
      case "prefs.codexSet":
        codexPrefs = { ...(codexPrefs || {}), ...p, updatedAt: Date.now() };
        return { preferences: codexPrefs };
      case "dashboard.threadStats": {
        // 84 days, busier on weekdays, so the heat map shows every level.
        const activity = Array.from({ length: 84 }, (_, index) => {
          const date = new Date(Date.now() - (83 - index) * 86400000);
          const count = index % 7 >= 5 ? index % 3 : (index * 7) % 11;
          return { date: date.toISOString().slice(0, 10), count };
        });
        // 105 weeks for the Hub 首页 grid, quieter further back.
        const history = Array.from({ length: 735 }, (_, index) => {
          const date = new Date(Date.now() - (734 - index) * 86400000);
          const count = index < 560 ? ((index * 5) % 9 === 0 ? 2 : 0) : (index * 7) % 11;
          return { date: date.toISOString().slice(0, 10), count };
        });
        const total = activity.reduce((sum, day) => sum + day.count, 0);
        const active = activity.filter((day) => day.count > 0).length;
        return {
          sessionsRoot: "C:\\Users\\me\\.codex\\sessions",
          rootExists: true,
          history,
          stats: {
            totalThreads: total + 212,
            totalBytes: 486539264,
            activeDays: active,
            averagePerActiveDay: total / active,
          },
          activity,
        };
      }
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
      case "maintenance.chatRepairScan": {
        // `?chats=clean`: every chat opens.
        if (new URLSearchParams(location.search).get("chats") === "clean")
          return {
            available: true,
            reason: "ok",
            broken: 0,
            deleted: 0,
            items: [],
            checked: { agent: 73, codex: 437, legacy: 49 },
            groups: [],
          };
        const chat = (title, harnessId, updatedAt, archived) => ({
          id: `${title}-${updatedAt}`,
          title,
          harnessId,
          updatedAt,
          ...(archived ? { archived: true } : {}),
        });
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
          checked: { agent: 73, codex: 437, legacy: 49 },
          groups: [
            {
              kind: "legacy-missing",
              count: 1,
              archived: 0,
              repairable: true,
              items: [chat("啥情况这是 而且更新也很慢", "claude-code", "2026-10-18T15:09:48.280Z")],
            },
            {
              kind: "legacy-outdated",
              count: 1,
              archived: 0,
              repairable: true,
              items: [chat("检查项目测试", "claude-code", "2026-10-17T13:33:22.000Z")],
            },
            {
              kind: "legacy-deleted",
              count: 1,
              archived: 0,
              repairable: true,
              items: [chat("测试任务", "claude-code", "2026-10-15T16:40:08.000Z")],
            },
            {
              kind: "session-missing",
              count: 3,
              archived: 1,
              repairable: false,
              items: [
                chat("整理发布说明", "claude-code", "2026-10-12T09:00:00.000Z"),
                chat("看一下这个报错", "claude-code", "2026-10-10T09:00:00.000Z", true),
                chat("", "claude-code", "2026-10-09T09:00:00.000Z"),
              ],
            },
            {
              kind: "codex-provider-missing",
              count: 2,
              archived: 1,
              repairable: false,
              items: [chat("旧服务商上的聊天", "codex", "2026-09-30T09:00:00.000Z")],
            },
          ],
        };
      }
      case "maintenance.chatRecoverReadable":
        recoveredHistory = true;
        return {
          phase: "running",
          total: 3,
          processed: 0,
          recovered: 0,
          partial: 0,
          unavailable: 2,
          failed: 0,
        };
      case "maintenance.chatRecoverStatus":
        return recoveredHistory
          ? {
              phase: "completed",
              total: 3,
              processed: 3,
              recovered: 2,
              partial: 1,
              unavailable: 2,
              failed: 1,
              folder: "recovery-demo12",
            }
          : {
              phase: "idle",
              total: 0,
              processed: 0,
              recovered: 0,
              partial: 0,
              unavailable: 0,
              failed: 0,
            };
      case "maintenance.openRecoveredHistory":
        return { ok: true };
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
      // A reply on the current Codex account just carried its numbers (live-quota.ts).
      case "quota.live":
        return {
          updates: [
            {
              provider: "codex",
              id: "0123456789ab",
              usage: { ...codexAccounts[0].lastUsage, source: "live" },
              observedAt: Date.now(),
              source: "conversation",
            },
          ],
        };
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
      case "relay.unifiedStatus":
        return { enabled: unified.enabled };
      case "relay.unifiedSet":
        unified.enabled = p.enabled === true;
        return { enabled: unified.enabled };
      case "relay.noAccountStatus":
        return {
          enabled: noAccount.enabled,
          ...(noAccount.enabled ? { model: noAccount.model } : {}),
          configPath: codexConfigPath,
          models: noAccountModels,
        };
      case "relay.noAccountPreview":
        return {
          configPath: codexConfigPath,
          changes: [
            `model = "${p.model}"`,
            'model_provider = "rly0"',
            "[model_providers.rly0] requires_openai_auth = false",
          ],
        };
      case "relay.noAccountEnable":
        Object.assign(noAccount, { enabled: true, model: p.model });
        return { ok: true, noAccount: true };
      case "relay.noAccountDisable":
        Object.assign(noAccount, { enabled: false, model: null });
        return { ok: true };
      case "codex.status":
        return { running: true, canOpen: true, restartPending: false };
      case "codex.applySettings":
        return {
          outcome: p.restartNow ? "restarting" : p.scope === "backend" ? "reloaded" : "restarting",
        };
      case "codex.applyCancel":
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
      case "accounts.resetPrepare": {
        const account = codexAccounts.find((a) => a.id === p.id);
        const count = account && account.lastUsage ? account.lastUsage.resetCredits || 0 : 0;
        return {
          availableCount: count,
          creditId: count ? `synthetic-card-${p.id}` : null,
          revision: "a".repeat(64),
          expiresAt: null,
        };
      }
      case "accounts.resetAcknowledge":
        return { ok: true };
      case "accounts.resetConsume": {
        if (resetRequests.has(p.requestId)) return { outcome: "alreadyRedeemed" };
        const account = codexAccounts.find((a) => a.id === p.id);
        if (!account || !account.lastUsage || !account.lastUsage.resetCredits)
          return { outcome: "noCredit" };
        resetRequests.add(p.requestId);
        account.lastUsage = usage(0, 0, 18000, 604800, account.lastUsage.resetCredits - 1);
        return { outcome: "reset" };
      }
      case "accounts.usage": {
        const account = codexAccounts.find((a) => a.id === p.id);
        return account
          ? { available: true, usage: account.lastUsage }
          : { __error: "ACCOUNT_NOT_FOUND" };
      }
      case "accounts.rename": {
        const account = codexAccounts.find((entry) => entry.id === p.id);
        if (!account) return { __error: "ACCOUNT_NOT_FOUND" };
        account.alias = p.alias;
        return { available: true, ok: true };
      }
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
              results: claudeAccounts.map(claudeUsage),
            };
      case "agents.claudeAccounts.usage": {
        const account = claudeAccounts.find((a) => a.id === p.id);
        // A fresh read (rly0-core keeps it as the account's last usage).
        if (account && account.lastUsage)
          account.lastUsage = { ...account.lastUsage, fetchedAt: Math.floor(Date.now() / 1000) };
        const result = account ? claudeUsage(account) : { error: "ACCOUNT_NOT_FOUND" };
        return result.error
          ? { __error: result.error, __delay: 400 }
          : { ...result.usage, __delay: 400 };
      }
      case "agents.claudeAccounts.switch":
        for (const account of claudeAccounts) account.current = account.id === p.id;
        return { switched: true };
      case "agents.claudeAccounts.rename": {
        const account = claudeAccounts.find((a) => a.id === p.id);
        if (account) account.alias = p.alias;
        return { ok: true };
      }
      case "agents.claudeAccounts.remove": {
        const index = claudeAccounts.findIndex((a) => a.id === p.id);
        if (index >= 0) claudeAccounts.splice(index, 1);
        return { ok: true };
      }
      case "agents.claudeAccounts.addLoginStart":
        if (!["starting", "waitingForCode", "authorizing"].includes(claudeAdd.phase))
          claudeAdd = {
            phase: "waitingForCode",
            id: "00000000-0000-4000-8000-0000000000c1",
            scope: "",
          };
        return { ...claudeAdd, __delay: 300 };
      case "agents.claudeAccounts.addLoginStatus":
        if (claudeAdd.phase === "authorizing") {
          claudeAdd = {
            phase: "succeeded",
            id: claudeAdd.id,
            result: { id: "0f0e0d0c0b0a", email: "new@example.com", plan: "max" },
          };
          claudeAccounts.push({
            id: "0f0e0d0c0b0a",
            alias: "new@example.com",
            email: "new@example.com",
            plan: "max",
            current: false,
            lastUsage: usage(3, 9, 17000, 590000),
          });
        }
        return claudeAdd;
      case "agents.claudeAccounts.addLoginSubmit":
        if (!/#/u.test(p.code)) return { __error: "CLAUDE_ADD_LOGIN_CODE_INVALID" };
        claudeAdd = { ...claudeAdd, phase: "authorizing" };
        return claudeAdd;
      case "agents.claudeAccounts.addLoginOpen":
        return { ...claudeAdd, browserOpened: true };
      case "agents.claudeAccounts.addLoginCancel":
        claudeAdd = { phase: "cancelled", id: claudeAdd.id, scope: "" };
        return claudeAdd;
      case "agents.claudeAccounts.importFile":
        if (!p.content.includes("claudeAiOauth")) return { __error: "CLAUDE_FILE_NO_LOGIN" };
        if (!claudeAccounts.some((a) => a.id === "1a2b3c4d5e6f"))
          claudeAccounts.push({
            id: "1a2b3c4d5e6f",
            alias: "file@example.com",
            email: "file@example.com",
            plan: "max",
            current: false,
            lastUsage: usage(51, 20, 6000, 200000),
          });
        return {
          ok: true,
          id: "1a2b3c4d5e6f",
          email: "file@example.com",
          plan: "max",
          __delay: 500,
        };
      case "agents.grokAccounts.list":
        return { accounts: grokAccounts, liveLoggedIn: true, liveUnsaved: false };
      case "agents.grokAccounts.usageAll":
        return { __delay: 300, results: grokAccounts.map(grokUsage) };
      case "agents.grokAccounts.usage": {
        const account = grokAccounts.find((a) => a.id === p.id);
        const result = account ? grokUsage(account) : { error: "ACCOUNT_NOT_FOUND" };
        return result.error
          ? { __error: result.error, __delay: 400 }
          : { ...result.usage, __delay: 400 };
      }
      case "agents.grokAccounts.switch": {
        const target = grokAccounts.find((a) => a.id === p.id);
        for (const account of grokAccounts) account.current = account.id === p.id;
        return {
          switched: true,
          alias: target && target.alias,
          expired: Boolean(target && target.loginExpired),
        };
      }
      case "agents.grokAccounts.rename": {
        const account = grokAccounts.find((a) => a.id === p.id);
        if (account) account.alias = p.alias;
        return { ok: true };
      }
      case "agents.grokAccounts.remove": {
        const index = grokAccounts.findIndex((a) => a.id === p.id);
        if (index >= 0) grokAccounts.splice(index, 1);
        return { ok: true };
      }
      case "agents.grokAccounts.importCurrent":
        return { id: "6a6b6c6d6e6f", email: "me@example.com", expired: false };
      case "agents.grokAccounts.addLoginStart":
        if (!["starting", "waitingForCode", "authorizing"].includes(grokAdd.phase)) {
          grokAdd = {
            phase: "waitingForCode",
            id: "00000000-0000-4000-8000-0000000000a1",
            scope: "",
          };
          grokAddPolls = 0;
        }
        return { ...grokAdd, __delay: 300 };
      case "agents.grokAccounts.addLoginStatus":
        // The browser callback finishes the login on its own after a few seconds.
        grokAddPolls += 1;
        if (grokAdd.phase === "waitingForCode" && grokAddPolls >= 3) {
          grokAdd = {
            phase: "succeeded",
            id: grokAdd.id,
            result: { id: "9a9b9c9d9e9f", email: "new@example.com" },
          };
          if (!grokAccounts.some((a) => a.id === "9a9b9c9d9e9f"))
            grokAccounts.push({
              id: "9a9b9c9d9e9f",
              alias: "new@example.com",
              email: "new@example.com",
              current: false,
              loginExpired: false,
              lastUsage: credits("weekly", 5, 590000),
            });
        }
        return grokAdd;
      case "agents.grokAccounts.addLoginOpen":
        return { ...grokAdd, browserOpened: true };
      case "agents.grokAccounts.addLoginCancel":
        grokAdd = { phase: "cancelled", id: grokAdd.id, scope: "" };
        return grokAdd;
      case "agents.grokAccounts.importFile":
        if (p.content.includes("auth.x.ai")) {
          if (!grokAccounts.some((a) => a.id === "5a5b5c5d5e5f"))
            grokAccounts.push({
              id: "5a5b5c5d5e5f",
              alias: "file@example.com",
              email: "file@example.com",
              current: false,
              loginExpired: true,
            });
          return {
            ok: true,
            id: "5a5b5c5d5e5f",
            email: "file@example.com",
            expired: true,
            __delay: 400,
          };
        }
        if (p.content.includes("xai-")) return { ok: true, key: true };
        return { __error: "GROK_FILE_NO_LOGIN" };
      case "agents.antigravity.status":
        return { ...agyState, ...(agyState.usage ? { observationOnly: true } : {}) };
      case "agents.antigravity.cached":
        return agyState.usage ? { usage: agyState.usage, observationOnly: true } : {};
      case "agents.antigravity.usage":
        // First read succeeds; later ones time out and keep the last numbers.
        agyCalls += 1;
        if (!agyInstalled) return { installed: false };
        agyState =
          agyCalls === 1
            ? { installed: true, usage: agyUsage(), checkedAt: at(0) }
            : { ...agyState, error: "TIMEOUT", checkedAt: at(0) };
        return { ...agyState, __delay: 600 };
      case "agents.autoSwitch.get":
        return agentAutoSwitch[p.agent]
          ? { ...agentAutoSwitch[p.agent] }
          : { __error: "INVALID_PARAMS" };
      case "agents.autoSwitch.set": {
        const before = agentAutoSwitch[p.agent];
        if (!before) return { __error: "INVALID_PARAMS" };
        const riskAccepted = before.riskAccepted || p.acceptRisk === true;
        if (p.enabled && !riskAccepted) return { __error: "AUTO_SWITCH_RISK_NOT_ACCEPTED" };
        agentAutoSwitch[p.agent] = {
          enabled: p.enabled,
          remain5h: p.remain5h,
          remainWeekly: p.remainWeekly,
          mode: p.mode,
          riskAccepted,
        };
        return { ...agentAutoSwitch[p.agent] };
      }
      case "agents.autoSwitch.apply":
        return { switched: true, deferred: false };
      // `?claudeUses=key`: Claude Code bound to the saved setup-token (AI 助手 → 使用).
      case "agents.relays.get":
        return { claudeCode: selectedClaudeKey, agents: {} };
      case "agents.officialKeys.list":
        return {
          keys: [...claudeKeys.values()].map((key) => ({
            vendor: "anthropic",
            id: key.id,
            name: key.name,
            keyMask: `****${key.last4 || "ab12"}`,
            keyRevision: key.keyRevision,
            lastUsage: new URLSearchParams(location.search).has("noQuotaCache")
              ? undefined
              : key.usage && { ...key.usage, source: "snapshot" },
            models: [],
          })),
        };
      case "agents.officialKeys.info":
        // `?liveOnly`: the real service's behavior — a timed or page-open read of a Claude token
        // never reaches Anthropic (numbers come with Claude Code's replies).
        if (
          p.vendor === "anthropic" &&
          p.auto &&
          new URLSearchParams(location.search).has("liveOnly")
        )
          return { info: null, skipped: true };
        if (p.vendor === "anthropic")
          return { info: claudeKeys.get(p.id || selectedClaudeKey || "cccccccccccc") || null };
        return { info: officialKeys[p.vendor] || null };
      case "agents.officialKeys.set":
        if (p.vendor === "anthropic") {
          const id = p.id || (++keySequence).toString(16).padStart(12, "0");
          if (p.id && !claudeKeys.has(p.id)) return { __error: "OFFICIAL_KEY_NOT_FOUND" };
          claudeKeys.set(id, {
            ...claudeKey(null),
            id,
            name: "Claude 订阅令牌",
            keyRevision: (++keyRevisionSequence).toString(16).padStart(64, "0"),
            last4: p.apiKey.slice(-4),
          });
          return { ok: true, id, valid: true, modelCount: 3 };
        }
        officialKeys[p.vendor] = {
          kind: "apiKey",
          keyMask: "****new1",
          valid: true,
          modelCount: 3,
        };
        return { ok: true, valid: true, modelCount: 3 };
      case "agents.officialKeys.rename": {
        const entry = p.vendor === "anthropic" ? claudeKeys.get(p.id) : officialKeys[p.vendor];
        if (!entry) return { __error: "OFFICIAL_KEY_NOT_FOUND" };
        entry.name = p.name;
        return { ok: true, id: p.id, name: p.name };
      }
      case "agents.officialKeys.remove":
        if (p.vendor === "anthropic") {
          if (p.id === selectedClaudeKey) return { __error: "OFFICIAL_KEY_IN_USE" };
          claudeKeys.delete(p.id);
          return { ok: true };
        }
        officialKeys[p.vendor] = null;
        return { ok: true };
      case "agents.officialKeys.select":
        if (!claudeKeys.has(p.id)) return { __error: "OFFICIAL_KEY_NOT_FOUND" };
        selectedClaudeKey = p.id;
        return { ok: true, id: p.id };
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
      case "resources.sharingGet":
        return sharingState();
      case "resources.sharingSet":
        for (const key of ["mcp", "skills", "memory"])
          if (typeof p[key] === "boolean") sharing[key] = p[key];
        return {
          ...sharingState(),
          codexMemory:
            typeof p.memory === "boolean" ? (p.memory ? "added" : "removed") : "unchanged",
        };
      case "bridge.status":
        return { memoryServer: { available: true }, globals: globals.map((g) => ({ ...g })) };
      case "bridge.globalSet": {
        const g = globals.find((x) => x.agent === p.agent);
        g.enabled = p.enabled;
        g.servers = p.enabled ? ["rly0-memory", "rly0-docs"] : [];
        g.skipped = p.enabled ? ["github"] : [];
        return { ...g };
      }
      case "memory.list": {
        const q = (p.query || "").toLowerCase();
        const records = memories
          .filter((m) =>
            p.scope === "global"
              ? m.scope === "global"
              : p.scope === "project"
                ? m.scope === "project"
                : true,
          )
          .filter(
            (m) => !q || m.text.toLowerCase().includes(q) || m.tags.some((t) => t.includes(q)),
          )
          .sort((a, b) => b.time - a.time);
        return {
          records,
          total: memories.length,
          projects: new Set(memories.filter((m) => m.project).map((m) => m.project)).size,
          agents: [...new Set(memories.map((m) => m.agent))].sort(),
          directory: "C:\\Users\\me\\.rly0-hub\\memory",
          limits: { text: 4000, records: 5000 },
        };
      }
      case "memory.add": {
        const record = {
          id: `m${Date.now()}`,
          text: p.text,
          tags: p.tags || [],
          agent: "hub",
          scope: p.scope,
          project: p.project || null,
          time: Date.now(),
          source: null,
        };
        memories = [record, ...memories];
        return record;
      }
      case "memory.forget":
        memories = memories.filter((m) => m.id !== p.id);
        return { forgotten: true };
      case "memory.export":
        return {
          file: "C:\\Users\\me\\.rly0-hub\\memory\\exports\\memory-20261025T120000.json",
          count: memories.length,
        };
      case "memory.openFolder":
      case "skills.openFolder":
        return { ok: true };
      case "mcp.update": {
        const server = servers.find((s) => s.name === p.name);
        Object.assign(server, p);
        return { ok: true };
      }
      default:
        return null;
    }
  };
})();
