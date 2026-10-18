"use strict";
window.registerHubSystem = ({ pages, h, call, toast, failed, button, confirmButton, go }) => {
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
        h("p", { class: "sub" }, "用于 Hub 核心服务和 AI 助手下载。保存后核心服务重新连接。"),
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
    const tool = ({ name, title, text, action, detail }) =>
      h(
        "div",
        { class: "tool" },
        icon(name),
        h("div", { class: "tool-text" }, h("h3", null, title), h("p", null, text)),
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
      const [d, codex, proxy, backup, relays] = await Promise.all([
        call("maintenance.diagnostics").catch(() => null),
        call("codex.status").catch(() => null),
        call("proxy.status").catch(() => null),
        call("backup.status").catch(() => null),
        call("relay.list").catch(() => null),
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
      if (endpoint)
        rows.splice(1, 0, [
          "Codex 模型服务",
          endpoint.reachable,
          `${endpoint.reachable ? "连得上" : "连不上"} · ${endpointHost(endpoint.url)}`,
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
      if (codex && codex.running && (problems.length || proxyDown))
        fixes.push(confirmButton("重启 Codex", () => restart()));
      const count = problems.length + (proxyDown ? 1 : 0) + (endpointDown ? 1 : 0);
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
            )
          : null,
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
          text: "一次检查 Codex 能否连上模型服务、配置、登录、零号核心和本地中转代理；发现问题直接给出修复按钮，修好后可一键重启 Codex。",
          action: runDiag,
          detail: diagDetail,
        }),
        tool({
          name: "log",
          title: "调试日志",
          text: "导出脱敏诊断包（运行状态、配置检查、缓存占用），只保存在本机，不会上传。反馈问题时可以附上。",
          action: exportLog,
          detail: logDetail,
        }),
        tool({
          name: "clean",
          title: "清理数据",
          text: h(
            "span",
            null,
            "删除 Hub 的缓存、临时文件和已下载的旧安装包，不动账号、中转站和会话。",
            cleanSize,
          ),
          action: clean,
        }),
        tool({
          name: "quit",
          title: "强制关闭 Codex",
          text: "结束所有 Codex 相关进程（窗口、后台服务、插件进程），解决进程残留导致打不开或中转连不上。正在进行的任务会中断。",
          action: quit,
        }),
        tool({
          name: "image",
          title: "Image 声明过滤",
          text: "开启：发往中转站的请求去掉生图工具，避免不支持生图的中转返回 403。关闭：原样发送。官方账号不受影响，开启也不会新增生图能力。",
          action: imageSwitch,
        }),
        tool({
          name: "search",
          title: "Claude 联网搜索过滤",
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
          h("p", null, "暂时连不上发布页，稍后会自动再试。"),
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
