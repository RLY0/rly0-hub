"use strict";
window.registerHubSystem = ({
  pages,
  h,
  call,
  toast,
  failed,
  button,
  confirmButton,
  go,
  recentErrors,
  applyToCodex,
  consoleFeatures,
}) => {
  const bytes = (n) => `${((n || 0) / 1024 / 1024).toFixed(1)} MB`;
  pages.network = (root, alive) => {
    const mode = h(
      "select",
      { class: "input", "aria-label": "代理模式" },
      h("option", { value: "system" }, "跟随系统"),
      h("option", { value: "direct" }, "直连"),
      h("option", { value: "custom" }, "自定义代理"),
    );
    const url = h("input", {
      class: "input",
      "aria-label": "代理地址",
      placeholder: "http://127.0.0.1:7890",
    });
    root.append(
      h(
        "section",
        { class: "m" },
        h("h2", null, "网络代理"),
        h(
          "p",
          { class: "sub" },
          "用于 Hub 核心服务、AI 助手下载和软件更新。保存后核心服务重新连接。",
        ),
        mode,
        url,
        h(
          "div",
          { class: "row" },
          button("保存", async () => {
            await call("proxy.settingsSet", {
              settings: {
                mode: mode.value,
                ...(mode.value === "custom" ? { url: url.value.trim() } : {}),
              },
            });
            toast("已保存");
          }),
        ),
      ),
    );
    call("proxy.settingsGet").then((result) => {
      if (alive()) {
        mode.value = result.settings.mode;
        url.value = result.settings.url || "";
      }
    }, failed);
  };
  pages.threads = (root, alive) => {
    let trash = false;
    let entries = [];
    const selected = new Set();
    const list = h("div", { class: "grid compact" });
    const info = h("p", { class: "sub page-note" });
    const selectAll = h("input", {
      type: "checkbox",
      "aria-label": "全选当前列表",
      onchange: () => {
        for (const entry of entries) {
          if (selectAll.checked) selected.add(entry.relPath);
          else selected.delete(entry.relPath);
        }
        draw();
      },
    });
    const moveArea = h("div", { class: "row" });
    const drawMove = () =>
      moveArea.replaceChildren(
        confirmButton(trash ? "恢复所选线程" : "移入回收站", async () => {
          if (!selected.size) {
            toast("先选择线程");
            return;
          }
          const result = await call(trash ? "threads.restore" : "threads.trash", {
            relPaths: [...selected],
          });
          toast(
            `已${trash ? "恢复" : "移入回收站"} ${result.movedCount} 个${result.failed.length ? `，${result.failed.length} 个未完成` : ""}`,
          );
          await load();
        }),
      );
    const tabs = h(
      "div",
      { class: "row section-title" },
      button("本机线程", () => {
        trash = false;
        return load();
      }),
      button("回收站", () => {
        trash = true;
        return load();
      }),
      button("刷新", load),
    );
    root.append(
      tabs,
      info,
      h(
        "div",
        { class: "row page-note" },
        h("label", { class: "row" }, selectAll, "全选当前列表"),
        moveArea,
      ),
      list,
    );
    function draw() {
      list.replaceChildren(
        ...entries.map((entry) =>
          h(
            "section",
            { class: "m agent span-6" },
            h("input", {
              type: "checkbox",
              checked: selected.has(entry.relPath),
              "aria-label": `选择 ${entry.title}`,
              onchange: (event) => {
                if (event.currentTarget.checked) selected.add(entry.relPath);
                else selected.delete(entry.relPath);
                selectAll.checked = entries.length > 0 && selected.size === entries.length;
              },
            }),
            h(
              "div",
              { class: "who" },
              h("b", null, entry.title),
              h("span", null, entry.cwd || entry.fileName),
            ),
            h("span", { class: "tag" }, bytes(entry.sizeBytes)),
          ),
        ),
      );
      if (!entries.length)
        list.append(h("p", { class: "empty span-6" }, trash ? "回收站是空的" : "还没有线程"));
    }
    async function load() {
      try {
        const mode = trash;
        const result = await call(mode ? "threads.listTrash" : "threads.list");
        if (!alive() || mode !== trash) return;
        entries = result.threads;
        selected.clear();
        selectAll.checked = false;
        drawMove();
        info.textContent = `${mode ? "回收站" : "本机线程"} · 共 ${mode ? result.totalCount : result.stats.totalThreads} 个${result.truncated ? "，当前显示最新 500 个" : ""}。移入回收站后可恢复。操作前请结束相关会话。`;
        draw();
      } catch (error) {
        if (alive()) failed(error);
      }
    }
    void load();
  };

  /* ---------- 维护工具: its own rail page, one row per tool ---------- */
  const ICONS = {
    diagnose:
      '<path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v2a5 5 0 0 0 10 0v-3"/><circle cx="20" cy="10" r="2"/>',
    log: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/>',
    clean: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/><path d="M10.5 11v5M13.5 11v5"/>',
    quit: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
    image:
      '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9.5" cy="9.5" r="1.6"/><path d="M5 18l5-5 3 3 2-2 4 4"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
    restart: '<path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M5 4v4h4"/>',
    chats: '<path d="M4 5h12v9H8l-4 3z"/><path d="M9 9.5l2 2 3.5-3.5"/><path d="M19 9v9l-3-2h-5"/>',
    import: '<path d="M12 4v10M8 10l4 4 4-4"/><path d="M5 15v4h14v-4"/>',
  };
  const icon = (name) => {
    const el = h("span", { class: "tool-icon", "aria-hidden": "true" });
    el.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
    return el;
  };
  const CHECK_TEXT = {
    CODEX_HOME_MISSING: "还没有 Codex 配置目录：先打开一次 Codex",
    AUTH_JSON_MISSING: "Codex 还没有登录：到“账号”页登录或导入",
    CONFIG_TOML_MISSING: "还没有 Codex 配置文件：打开一次 Codex 会自动生成",
    CONFIG_TOML_INVALID: "Codex 配置文件格式有误",
    SESSIONS_DIR_MISSING: "还没有会话记录（新装的 Codex 属正常）",
    CORE_UNAVAILABLE: "零号核心没有运行：多账号、中转和过滤暂不可用，重开 Hub 试试",
  };
  // Where Codex sends model requests: host:port is enough to recognize it.
  const endpointHost = (url) => {
    try {
      const u = new URL(url);
      return u.hostname === "chatgpt.com" ? "ChatGPT 官方" : u.host;
    } catch {
      return "地址无效";
    }
  };
  const endpointAdvice = (e) => {
    const where = endpointHost(e.url);
    if (e.failure === "BAD_URL") return `Codex 配置里的服务地址写错了（${e.url || "空"}）`;
    if (e.app)
      return `Codex 的请求发往 ${where}，那是 ${e.app.name} 的端口，但它没有运行：所以 Codex 一直“正在重新连接”`;
    if (e.local)
      return `Codex 的请求发往本机 ${where}，但那里没有程序在运行：打开对应的工具，或到“账号”“中转站”页重新选 Codex 的使用方式`;
    return `连不上 ${where}${e.failure === "TIMEOUT" ? "（超时）" : ""}：检查网络或代理；如果平时要开代理/VPN 才能用，先打开它`;
  };

  pages.maintenance = (root, alive) => {
    // `brief` is the one visible line; the full `text` is behind its ⓘ (HubUI brief text).
    const tool = ({ name, title, text, brief, meta, action, detail }) =>
      h(
        "div",
        { class: "tool" },
        icon(name),
        h(
          "div",
          { class: "tool-text" },
          h("h3", null, title),
          h("p", { "data-brief": brief || null }, text),
          meta || null,
        ),
        h("div", { class: "tool-action" }, action),
        detail || null,
      );
    const put = (element, ...items) =>
      element.replaceChildren(...items.filter((item) => item !== null && item !== undefined));

    /* 系统诊断 */
    const diagDetail = h("div", { class: "tool-detail", hidden: true });
    async function diagnose() {
      put(diagDetail, h("p", { class: "sub" }, "正在检查…"));
      diagDetail.hidden = false;
      const [d, codex, proxy, backup, relays, model] = await Promise.all([
        call("maintenance.diagnostics").catch(() => null),
        call("codex.status").catch(() => null),
        call("proxy.status").catch(() => null),
        call("backup.status").catch(() => null),
        call("relay.list").catch(() => null),
        call("maintenance.modelCheck").catch(() => null),
      ]);
      if (!alive()) return;
      if (!d) {
        put(diagDetail, h("p", { class: "sub" }, "没能完成诊断，请重开 Hub 后再试"));
        return;
      }
      const enabledRelays =
        relays && relays.available ? relays.relays.filter((r) => r.enabled).length : 0;
      const proxyDown = Boolean(enabledRelays > 0 && proxy && proxy.available && !proxy.running);
      const rows = [
        ["Codex 配置目录", d.codexHomeExists, d.codexHomeExists ? "正常" : "没有"],
        ["Codex 登录", d.authJsonExists, d.authJsonExists ? "已登录" : "未登录"],
        [
          "Codex 配置文件",
          d.configTomlExists && d.configTomlParses !== false,
          !d.configTomlExists ? "没有" : d.configTomlParses === false ? "格式有误" : "正常",
        ],
        ["会话记录", true, d.sessionsDirExists ? "正常" : "还没有", true],
        [
          "零号核心",
          d.core.available,
          d.core.available ? `运行中 · v${d.core.version || "?"}` : "未运行",
        ],
        [
          "本地中转代理",
          !proxyDown,
          enabledRelays === 0
            ? "未使用中转"
            : proxy && proxy.running
              ? `运行中 · 端口 ${proxy.port}`
              : "未运行",
        ],
        ["Codex", true, codex && codex.running ? "运行中" : "未运行", true],
      ];
      const endpoint = d.codexEndpoint || null;
      if (d.desktopCompatibility) {
        const connection = d.desktopCompatibility;
        rows.push([
          "Codex 界面连接",
          connection.state === "ready",
          `${connection.desktopVersion ? `v${connection.desktopVersion} · ` : ""}${connection.message}`,
          ["not-running", "checking", "unverified"].includes(connection.state),
        ]);
      }
      if (endpoint)
        rows.splice(1, 0, [
          "Codex 模型服务",
          endpoint.reachable,
          `${endpoint.reachable ? "连得上" : "连不上"} · ${endpointHost(endpoint.url)}`,
        ]);
      // A service that answers can still refuse every task because of the model name.
      // Only meaningful once the service answers: fix the connection first, then the model.
      const rejection = endpoint && !endpoint.reachable ? null : model && model.rejection;
      if (model && (model.configModel || rejection))
        rows.splice(endpoint ? 2 : 1, 0, [
          "Codex 模型",
          !rejection,
          rejection
            ? `被拒 · ${rejection.model || model.configModel || "未知"}`
            : model.configModel || "默认",
        ]);
      // The endpoint gets its own, specific advice line below.
      const problems = d.advice.filter(
        (code) => code !== "SESSIONS_DIR_MISSING" && code !== "CODEX_ENDPOINT_DOWN",
      );
      const endpointDown = Boolean(endpoint && !endpoint.reachable);
      const fixes = [];
      if (endpointDown && endpoint.app)
        fixes.push(
          button(`启动 ${endpoint.app.name}`, async () => {
            const result = await call("maintenance.startEndpointApp").catch(() => null);
            if (!alive()) return;
            if (!result || !result.ok) {
              toast(`没能启动 ${endpoint.app.name}，请手动打开它`);
              return;
            }
            toast(`正在启动 ${endpoint.app.name}，稍等几秒后自动复查`);
            // Starting a bridge takes a while; re-check until it answers (about half a minute).
            for (let i = 0; i < 10 && alive(); i += 1) {
              await new Promise((resolve) => setTimeout(resolve, 4000));
              const again = await call("maintenance.diagnostics").catch(() => null);
              if (again && again.codexEndpoint && again.codexEndpoint.reachable) break;
            }
            if (alive()) await diagnose();
          }),
        );
      if (d.advice.includes("CONFIG_TOML_INVALID") && backup && backup.available)
        fixes.push(
          confirmButton("还原安装前的 Codex 设置", async () => {
            const result = await call("backup.restore").catch(() => null);
            toast(result && result.ok ? "已还原 Codex 设置" : "还原没有成功");
            await diagnose();
          }),
        );
      if (d.advice.includes("AUTH_JSON_MISSING"))
        fixes.push(button("去账号页登录", () => go("accounts")));
      if (proxyDown)
        fixes.push(
          button("启动本地代理", async () => {
            await call("proxy.start");
            toast("本地代理已启动");
            await diagnose();
          }),
        );
      let modelFix = null;
      if (rejection) {
        if (model.profileModel) {
          modelFix = h(
            "p",
            { class: "sub" },
            "这个模型是 Codex 配置里当前 profile 指定的，请在 config.toml 的对应 profile 里修改。",
          );
        } else if (model.choices.length) {
          const preferred =
            model.choices.find((c) => c.slug === model.configModel) ||
            model.choices.find((c) => !c.slug.includes("/")) ||
            model.choices[0];
          const select = h(
            "select",
            { class: "input", "aria-label": "换用的模型" },
            model.choices.map((c) =>
              h("option", { value: c.slug, selected: c.slug === preferred.slug }, c.name),
            ),
          );
          modelFix = h(
            "div",
            { class: "row" },
            select,
            confirmButton("换成这个模型", async () => {
              const result = await call("maintenance.setModel", { model: select.value }).catch(
                () => null,
              );
              if (!alive()) return;
              if (!result || !result.ok) {
                toast("没能修改 Codex 配置");
                return;
              }
              await applyToCodex("backend", "已换成这个模型，原配置已备份");
              await diagnose();
            }),
          );
        }
        if (endpoint && endpoint.local)
          fixes.push(
            button("Codex Web GPT 下载页", () => call("links.open", { target: "codexWebGpt" })),
          );
      }
      if (codex && codex.running && (problems.length || proxyDown || rejection))
        fixes.push(confirmButton("重启 Codex", () => restart()));
      const count =
        problems.length + (proxyDown ? 1 : 0) + (endpointDown ? 1 : 0) + (rejection ? 1 : 0);
      put(
        diagDetail,
        h(
          "p",
          { class: `diag-sum ${count ? "warn" : "ok"}` },
          count ? `发现 ${count} 个需要处理的问题` : "一切正常",
        ),
        h(
          "ul",
          { class: "diag-list" },
          rows.map(([label, ok, value, neutral]) =>
            h(
              "li",
              { class: ok ? (neutral ? "neutral" : "ok") : "bad" },
              h("span", null, label),
              h("b", null, value),
            ),
          ),
        ),
        count
          ? h(
              "ul",
              { class: "diag-advice" },
              endpointDown ? h("li", null, endpointAdvice(endpoint)) : null,
              problems.map((code) => h("li", null, CHECK_TEXT[code] || "需要检查")),
              proxyDown
                ? h("li", null, "已启用中转站，但本地代理没有运行，走中转的模型会失败")
                : null,
              rejection
                ? h(
                    "li",
                    null,
                    `Codex 能连上模型服务，但任务被拒绝了：${rejection.message}。换一个它支持的模型；如果用的是 Codex Web GPT，旧版本不认识新的模型名，也可以先升级它。已经开着的任务请在 Codex 的模型选择器里换掉 ${rejection.model || "这个模型"}。`,
                  )
                : null,
            )
          : null,
        modelFix,
        fixes.length ? h("div", { class: "row" }, fixes) : null,
      );
    }
    const runDiag = button("运行诊断", () => diagnose());

    /* 调试日志 */
    const logDetail = h("div", { class: "tool-detail", hidden: true });
    const exportLog = button("导出日志", async () => {
      const result = await call("maintenance.exportDiagnostics");
      if (!alive()) return;
      logDetail.hidden = false;
      put(
        logDetail,
        h("p", { class: "sub wrap" }, `已保存到 ${result.filePath}`),
        h(
          "div",
          { class: "row" },
          button("打开所在文件夹", () => call("maintenance.openDiagnosticsFolder")),
        ),
      );
    });
    // 反馈问题: the window's screenshot, the diagnostics package and the page's recent errors in
    // one folder (~/.rly0-hub/diagnostics/feedback-…). Without a screenshot the rest still saves.
    const feedbackFolder = () => {
      const pad = (n) => String(n).padStart(2, "0");
      const d = new Date();
      return `feedback-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    };
    const feedback = button("反馈问题", async () => {
      const shot = await call("window.capture").catch(() => null);
      const folder = shot && shot.folder ? shot.folder : feedbackFolder();
      const result = await call("maintenance.exportFeedback", { folder, errors: recentErrors() });
      if (!alive()) return;
      logDetail.hidden = false;
      put(
        logDetail,
        h("p", { class: "sub wrap" }, `已保存到 ${result.folderPath}`),
        h(
          "p",
          { class: "sub" },
          shot && shot.folder
            ? "包含窗口截图、诊断包和最近的出错记录，已去掉邮箱、密钥和用户名。"
            : "这次没能截图，只保存了诊断包和最近的出错记录。",
        ),
        h(
          "div",
          { class: "row" },
          button("打开文件夹", () => call("maintenance.openDiagnosticsFolder", { folder })),
        ),
      );
    });

    /* 清理数据 */
    const cleanSize = h("span", { class: "tool-meta" }, "");
    const clean = confirmButton("开始清理", async () => {
      const result = await call("maintenance.clearCache");
      toast(result.clearedBytes ? `已清理 ${bytes(result.clearedBytes)}` : "没有需要清理的数据");
      await loadCache();
    });
    async function loadCache() {
      const info = await call("maintenance.cacheInfo").catch(() => null);
      if (!alive() || !info) return;
      cleanSize.textContent = info.totalBytes
        ? `当前可释放 ${bytes(info.totalBytes)}`
        : "当前没有可清理的数据";
    }

    /* 修复聊天记录：所有助手和 Codex 自己的聊天（含旧版 CodexHost 留下的） */
    const chatMeta = h("span", { class: "tool-meta" }, "");
    const chatDetail = h("div", { class: "tool-detail", hidden: true });
    const AGENT_NAMES = {
      "claude-code": "Claude Code",
      codex: "Codex",
      gemini: "Gemini",
      antigravity: "Antigravity",
      grok: "Grok",
      pi: "Pi",
      hermes: "Hermes",
      opencode: "OpenCode",
    };
    // Per kind (rly0-maintenance/chat-repair.ts): what is wrong, and what the repair does or why
    // it cannot. `legacy-deleted` is listed apart (only brought back when asked).
    const CHAT_PROBLEMS = {
      "legacy-missing": {
        what: "旧版 CodexHost 里的聊天没搬过来，点开报 no rollout found 或一片空白",
        fix: "从旧版复制过来",
      },
      "legacy-outdated": {
        what: "在旧版 CodexHost 里又聊过，这里还是旧内容",
        fix: "换成新内容（旧内容另存一份）",
      },
      format: {
        what: "模型显示“自定义”、发不出消息（模型设置是旧格式）",
        fix: "打开 Codex 时自动转换",
      },
      "record-damaged": {
        what: "聊天记录文件损坏，打不开",
        fix: "用自动备份恢复",
      },
      "record-lost": {
        what: "聊天记录文件损坏，也没有能用的备份",
        cannot: "文件原样留着，没有删除",
      },
      "stuck-creating": {
        what: "聊天没有创建完成",
        cannot: "里面没有内容，新开一个聊天即可",
      },
      "session-missing": {
        what: "当前 Claude Code 记录目录中未找到会话文件，可能影响打开或续聊",
        next: "需检查旧目录、备份或隔离环境；找到完整副本后才能恢复，目前不能判定永久丢失",
      },
      "codex-rollout-missing": {
        what: "Codex 列表指向的位置未找到对话文件，可能报 no rollout found",
        next: "需检查归档、移动目录和备份；当前未找到不代表已永久丢失",
      },
      "codex-provider-missing": {
        what: "聊天文件还在，但旧服务商未在当前配置中，可能影响显示或续聊",
        next: "可核对并恢复原服务商配置，或另选续聊线路；Hub 暂未自动处理，仅恢复配置不保证能续聊",
      },
      "codex-unlisted-rollout": {
        what: "发现未列入当前 Codex 索引的对话文件，内容完整性尚待核实",
        next: "可检查原文件，再准备重新索引或导入；Hub 暂未执行，不能据此判定无法恢复",
      },
    };
    const chatTitle = (item) =>
      `${item.title || "未命名会话"} · ${AGENT_NAMES[item.harnessId] || item.harnessId || "助手"}${
        item.archived ? " · 已归档" : ""
      }`;
    function chatGroup(group) {
      const problem = CHAT_PROBLEMS[group.kind] || {
        what: "其他问题",
        cannot: "暂时没有自动修复",
      };
      const fixable = group.repairable && problem.fix;
      const named = group.items.filter((item) => item.title).slice(0, 5);
      return h(
        "li",
        { class: fixable ? "bad" : "" },
        h(
          "div",
          { class: "chat-problem" },
          h(
            "p",
            null,
            h("b", null, `${group.count} 条`),
            group.archived ? `（${group.archived} 条已归档）` : "",
            `：${problem.what}`,
          ),
          h(
            "p",
            { class: fixable ? "chat-fix ok" : "chat-fix" },
            fixable
              ? `→ 可以修复：${problem.fix}`
              : problem.next
                ? `→ 需要进一步恢复：${problem.next}`
                : `→ 暂不能自动修复：${problem.cannot}`,
          ),
          named.length
            ? h(
                "ul",
                { class: "chat-titles" },
                named.map((item) => h("li", null, chatTitle(item))),
                group.count > named.length
                  ? h("li", null, `…还有 ${group.count - named.length} 条`)
                  : null,
              )
            : null,
        ),
      );
    }
    async function repairChats(includeDeleted) {
      const status = await call("codex.status").catch(() => null);
      if (status && status.running) toast("正在关闭 Codex，修复后会自动重新打开…");
      const result = await call("maintenance.chatRepair", { includeDeleted }).catch(() => null);
      if (!alive()) return;
      if (!result || !result.ok) {
        toast(
          result && result.reason === "CODEX_STILL_RUNNING"
            ? "Codex 没能关闭，请先用“强制关闭 Codex”再修复"
            : result && result.reason === "backup-failed"
              ? "没能先备份聊天记录，所以什么都没改，请重开 Hub 后再试"
              : "修复没有完成，请重开 Hub 后再试",
        );
      } else if (!result.repaired && !result.fixedOnCodexStart) {
        toast("没有需要修复的聊天记录");
      } else {
        // Re-encoding model choices happens inside Codex's backend when it opens.
        waitingForCodex = result.fixedOnCodexStart > 0 && !result.codexRestarted;
        toast(
          [
            result.repaired ? `已修复 ${result.repaired} 条聊天记录（修改前已备份）` : "",
            waitingForCodex ? `${result.fixedOnCodexStart} 条会在打开 Codex 时自动修好` : "",
            result.reopenFailed
              ? "请手动打开 Codex"
              : result.codexRestarted
                ? "Codex 正在重新打开"
                : "",
          ]
            .filter(Boolean)
            .join("，"),
        );
      }
      await scanChats(true);
    }
    let waitingForCodex = false;
    async function scanChats(show) {
      const scan = await call("maintenance.chatRepairScan").catch(() => null);
      if (!alive()) return;
      if (!scan) {
        chatMeta.textContent = "";
        if (show) {
          chatDetail.hidden = false;
          put(chatDetail, h("p", { class: "diag-sum warn" }, "检查没有完成，请重开 Hub 后再试"));
        }
        return;
      }
      const groups = (scan.groups || []).filter((g) => g.kind !== "legacy-deleted");
      const checked = scan.checked
        ? scan.checked.agent + (scan.checked.codex || 0)
        : (scan.items || []).length;
      const problems = groups.reduce((sum, g) => sum + g.count, 0);
      if (
        waitingForCodex &&
        scan.broken > 0 &&
        groups.every((g) => !g.repairable || g.kind === "format")
      ) {
        chatMeta.textContent = "打开 Codex 后自动完成修复";
        if (!show) return;
        chatDetail.hidden = false;
        put(
          chatDetail,
          h(
            "p",
            { class: "diag-sum ok" },
            `已找回。还有 ${scan.broken} 条的模型设置会在下次打开 Codex 时自动转换，之后就能继续聊。`,
          ),
        );
        return;
      }
      chatMeta.textContent = problems
        ? `检查了 ${checked} 条聊天，${problems} 条需检查${scan.broken ? `，${scan.broken} 条可以自动修复` : ""}`
        : `检查了 ${checked} 条聊天，没有发现问题`;
      if (!show) return;
      chatDetail.hidden = false;
      put(
        chatDetail,
        h(
          "p",
          { class: `diag-sum ${problems ? "warn" : "ok"}` },
          problems
            ? `检查了 ${checked} 条聊天，发现 ${problems} 条需检查：`
            : `检查了 ${checked} 条聊天，没有发现问题`,
        ),
        groups.length ? h("ul", { class: "diag-list chat-list" }, groups.map(chatGroup)) : null,
        scan.checked && scan.checked.codex === null
          ? h("p", { class: "sub" }, "Codex 自己的聊天列表这次没读到，只检查了助手的聊天。")
          : null,
        h(
          "div",
          { class: "row" },
          scan.broken ? confirmButton(`修复 ${scan.broken} 条`, () => repairChats(false)) : null,
          scan.deleted
            ? confirmButton(`同时找回在 Hub 里删掉的 ${scan.deleted} 条`, () => repairChats(true))
            : null,
        ),
      );
    }
    const chatRepair = button("检查并修复", () => scanChats(true));
    const recoveryDetail = h("div", { class: "tool-detail", hidden: true });
    let recoveryVersion = 0;
    const recoverReadable = h(
      "button",
      {
        class: "btn",
        type: "button",
        onclick: async () => {
          const version = ++recoveryVersion;
          recoverReadable.disabled = true;
          try {
            const status = await call("maintenance.chatRecoverReadable");
            if (alive() && version === recoveryVersion) showRecovery(status, version);
          } catch (error) {
            if (alive() && version === recoveryVersion) {
              recoverReadable.disabled = false;
              failed(error);
            }
          }
        },
      },
      "找回可查看历史",
    );
    async function loadRecovery(version) {
      const status = await call("maintenance.chatRecoverStatus").catch(() => null);
      if (!alive() || version !== recoveryVersion) return;
      if (status) showRecovery(status, version);
      else {
        recoverReadable.disabled = false;
        recoveryDetail.hidden = false;
        put(recoveryDetail, h("p", { class: "sub" }, "暂未读到恢复状态，可稍后再试。"));
      }
    }
    function showRecovery(status, version) {
      if (!status || status.phase === "idle") {
        recoverReadable.disabled = false;
        return;
      }
      recoveryDetail.hidden = false;
      recoverReadable.disabled = status.phase === "running";
      if (status.phase === "running") {
        put(
          recoveryDetail,
          h(
            "p",
            { class: "sub" },
            `正在找回可查看历史：${status.processed || 0} / ${status.total || 0}，已生成 ${status.recovered || 0} 份副本。可切换页面，任务会继续。`,
          ),
        );
        setTimeout(() => {
          if (alive() && version === recoveryVersion) void loadRecovery(version);
        }, 1200);
      } else if (status.phase === "completed") {
        put(
          recoveryDetail,
          h(
            "p",
            { class: "diag-sum" },
            `已生成 ${status.recovered || 0} 份可查看副本，${status.partial || 0} 份为部分内容；${status.failed || 0} 份因文件或格式未生成，${status.limited || 0} 份因处理限制暂未生成；${status.unavailable || 0} 条 Codex 记录未定位到原文件。`,
          ),
          h(
            "p",
            { class: "sub" },
            "本次仅找回 Codex 本地文件。Claude 等助手仍需对应会话或备份。副本保存在本机，原聊天、归档和服务商未变；原生列表和续聊尚未修复。不明旧格式、隐藏推理和工具内容不导出，附件可能不完整。",
          ),
          status.scanIncomplete
            ? h("p", { class: "sub" }, "本次扫描达到范围上限，尚未检查全部目录；未扫描不代表丢失。")
            : null,
          button("打开找回的历史", () => call("maintenance.openRecoveredHistory")),
        );
      } else {
        put(
          recoveryDetail,
          h(
            "p",
            { class: "sub" },
            "没能完成历史找回。请检查聊天文件、配置和目录权限后重试；原聊天没有被改写。",
          ),
        );
      }
    }

    /* 过滤开关（零号核心的本地代理执行，只作用于发往中转站的请求） */
    const filterSwitch = (key, label) =>
      h("button", {
        class: "switch",
        type: "button",
        role: "switch",
        "aria-checked": "false",
        "aria-label": label,
        disabled: true,
        onclick: async (event) => {
          const el = event.currentTarget;
          const next = el.getAttribute("aria-checked") !== "true";
          el.disabled = true;
          try {
            const result = await call("maintenance.filtersSet", { [key]: next });
            if (!result || !result.available) throw new Error("RLY0_CORE_UNAVAILABLE");
            applyFilters(result);
            toast(next ? `已开启${label}` : `已关闭${label}`);
          } catch (error) {
            failed(error);
          } finally {
            el.disabled = false;
          }
        },
      });
    const imageSwitch = filterSwitch("imageTool", "生图声明过滤");
    const searchSwitch = filterSwitch("webSearchTool", "联网搜索过滤");
    const filterNote = h(
      "p",
      { class: "sub tool-detail", hidden: true },
      "两个过滤开关需要零号核心，当前不可用。重开 Hub 后再试。",
    );
    function applyFilters(result) {
      imageSwitch.setAttribute("aria-checked", String(Boolean(result.imageTool)));
      searchSwitch.setAttribute("aria-checked", String(Boolean(result.webSearchTool)));
    }
    async function loadFilters() {
      const result = await call("maintenance.filtersGet").catch(() => null);
      if (!alive()) return;
      const ok = Boolean(result && result.available);
      imageSwitch.disabled = !ok;
      searchSwitch.disabled = !ok;
      filterNote.hidden = ok;
      if (ok) applyFilters(result);
    }

    /* Codex 进程 */
    async function restart() {
      const result = await call("maintenance.restartCodex");
      toast(result.ok ? "Codex 正在重启" : "Codex 没有在运行，或没能结束它，请手动关闭后再打开");
    }
    const quit = confirmButton("强制关闭", async () => {
      const result = await call("maintenance.forceQuitCodex");
      toast(
        result.ok
          ? result.killed
            ? `已结束 ${result.killed} 个 Codex 相关进程`
            : "已请求关闭 Codex"
          : "没有找到正在运行的 Codex",
      );
    });

    root.append(
      h(
        "p",
        { class: "sub page-note" },
        "诊断运行状态、导出日志、清理数据，处理 Codex 卡住、打不开或中转报错。",
      ),
      h(
        "section",
        { class: "m tools" },
        tool({
          name: "diagnose",
          title: "系统诊断",
          brief: "检查连接、模型、配置、登录和代理，给出修复",
          text: "一次检查 Codex 能否连上模型服务、模型是否被拒、配置、登录、零号核心和本地中转代理；发现问题直接给出修复按钮，修好后可一键重启 Codex。",
          action: runDiag,
          detail: diagDetail,
        }),
        tool({
          name: "chats",
          title: "修复聊天记录",
          brief: "聊天打不开、历史不见或无法续聊时用",
          text: "检查聊天打不开、历史不见或无法续聊的原因。“找回可查看历史”从仍在本机的 Codex 文件生成只读副本，不改原生列表、不换线路、不重启 Codex；缺失记录仍需原文件或备份。修复 Hub 自身记录时会先备份并关闭 Codex，之后重新打开；不删除记录。",
          meta: chatMeta,
          action: [chatRepair, recoverReadable],
          detail: [chatDetail, recoveryDetail],
        }),
        tool({
          name: "import",
          title: "会话导入",
          text: "把 Claude Code 等助手的原生会话导入 Codex 继续用。",
          action: button("导入会话", () => consoleFeatures.openSessionImport()),
        }),
        tool({
          name: "log",
          title: "调试日志",
          brief: "导出脱敏诊断包或反馈材料，只存本机",
          text: "导出脱敏诊断包（运行状态、配置检查、缓存占用），只保存在本机，不会上传。“反馈问题”另外保存当前窗口截图和最近的出错记录，同样只在本机，提交反馈时自己附上。",
          action: [exportLog, feedback],
          detail: logDetail,
        }),
        tool({
          name: "clean",
          title: "清理数据",
          brief: "删除缓存和旧安装包，不动账号和会话",
          text: "删除 Hub 的缓存、临时文件和已下载的旧安装包，不动账号、中转站和会话。",
          meta: cleanSize,
          action: clean,
        }),
        tool({
          name: "quit",
          title: "强制关闭 Codex",
          brief: "结束全部 Codex 进程，进行中的任务会中断",
          text: "结束所有 Codex 相关进程（窗口、后台服务、插件进程），解决进程残留导致打不开或中转连不上。正在进行的任务会中断。",
          action: quit,
        }),
        tool({
          name: "image",
          title: "Image 声明过滤",
          brief: "去掉发往中转的生图工具，避免 403",
          text: "开启：发往中转站的请求去掉生图工具，避免不支持生图的中转返回 403。关闭：原样发送。官方账号不受影响，开启也不会新增生图能力。",
          action: imageSwitch,
        }),
        tool({
          name: "search",
          title: "Claude 联网搜索过滤",
          brief: "Claude Code 走中转时去掉内置联网搜索",
          text: "开启：Claude Code 走中转时去掉内置联网搜索工具，避免不支持的中转报错。不影响 MCP 或插件里的搜索工具，Claude 官方登录不受影响。",
          action: searchSwitch,
          detail: filterNote,
        }),
        tool({
          name: "restart",
          title: "重启 Codex",
          text: "关闭并重新打开 Codex，让配置变更生效或恢复异常状态。",
          action: confirmButton("重启", () => restart()),
        }),
      ),
    );
    void loadCache();
    void loadFilters();
    void scanChats(false);
    void loadRecovery(recoveryVersion);
  };

  pages.updates = (root, alive) => {
    const put = (element, ...items) =>
      element.replaceChildren(...items.filter((item) => item !== null && item !== undefined));
    const result = h("div", { class: "sub" }, "检查中…");
    const actions = h("div", { class: "row" });
    const check = async (force) => {
      result.textContent = "检查中…";
      const status = window.rly0Updates
        ? await window.rly0Updates.check(force)
        : await call("updates.status", { force }).catch(() => null);
      if (!alive()) return;
      if (!status || status.error || !status.latestVersion) {
        result.replaceChildren(
          h("p", null, `当前版本 ${(status && status.currentVersion) || "未知"}`),
          h(
            "p",
            null,
            status && status.error === "UPDATE_RATE_LIMITED"
              ? "GitHub 暂时限制了查询次数，几分钟后再试。"
              : status && status.error === "UPDATE_NETWORK"
                ? "连不上 GitHub，检查网络或在 设置→网络代理 配置代理。"
                : "暂时连不上发布页，稍后会自动再试。",
          ),
        );
        put(
          actions,
          button("重新检查", () => check(true)),
          button("打开发布页", () => call("links.open", { target: "releases" })),
        );
        return;
      }
      result.replaceChildren(
        h("p", null, `当前版本 ${status.currentVersion} · 最新版本 ${status.latestVersion}`),
        h(
          "p",
          { class: status.updateAvailable ? "update-ready" : "" },
          status.updateAvailable ? "有新版本可以更新" : "已经是最新版本",
        ),
      );
      put(
        actions,
        status.updateAvailable
          ? h(
              "button",
              {
                class: "btn paper",
                type: "button",
                onclick: () => window.rly0Updates && window.rly0Updates.prompt(),
              },
              "查看并更新",
            )
          : null,
        button("重新检查", () => check(true)),
        button("打开发布页", () => call("links.open", { target: "releases" })),
      );
    };
    root.append(
      h(
        "section",
        { class: "m" },
        h("h2", null, "RLY/0 Hub 更新"),
        result,
        actions,
        h(
          "p",
          { class: "sub" },
          "Hub 在后台自动检查更新（每 6 小时一次）。有新版本时会弹窗提醒，侧边栏的“设置”也会亮起红点。",
        ),
      ),
    );
    void check(false);
  };
};
