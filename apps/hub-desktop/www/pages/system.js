"use strict";
window.registerHubSystem = ({ pages, h, call, toast, failed, button, confirmButton }) => {
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

  const advice = {
    CODEX_HOME_MISSING: "还没有 Codex 配置目录",
    AUTH_JSON_MISSING: "还没有登录 Codex",
    CONFIG_TOML_MISSING: "还没有配置文件",
    CONFIG_TOML_INVALID: "配置格式有误",
    SESSIONS_DIR_MISSING: "还没有会话记录",
    CORE_UNAVAILABLE: "核心服务不可用",
  };
  pages.maintenance = (root, alive) => {
    const diagnostics = h("div", { class: "sub" }, "读取中…");
    const cache = h("div", { class: "sub" }, "读取中…");
    const exported = h("p", { class: "sub wrap", role: "status" });
    root.append(
      h(
        "div",
        { class: "grid compact" },
        h(
          "section",
          { class: "m span-3" },
          h("h2", null, "诊断"),
          diagnostics,
          exported,
          h(
            "div",
            { class: "row" },
            button("刷新", load),
            button("导出脱敏诊断", async () => {
              const result = await call("maintenance.exportDiagnostics");
              if (alive()) exported.textContent = `已保存：${result.filePath}`;
            }),
          ),
        ),
        h(
          "section",
          { class: "m tone span-3" },
          h("h2", null, "缓存"),
          cache,
          h("p", { class: "sub" }, "只清理 Hub 的 cache、tmp 等临时目录，保留账号和会话。"),
          h(
            "div",
            { class: "row" },
            confirmButton("清理缓存", async () => {
              const result = await call("maintenance.clearCache");
              toast(`已清理 ${bytes(result.clearedBytes)}`);
              await load();
            }),
          ),
        ),
        h(
          "section",
          { class: "m span-6" },
          h("h2", null, "Codex"),
          h(
            "p",
            { class: "sub" },
            "仅控制由 RLY/0 启动器启动的 Codex。强制退出和重启会中断正在进行的任务。",
          ),
          h(
            "div",
            { class: "row" },
            confirmButton("强制退出 Codex", () => processAction("maintenance.forceQuitCodex")),
            confirmButton("重启 Codex", () => processAction("maintenance.restartCodex")),
          ),
        ),
      ),
    );
    async function processAction(method) {
      const result = await call(method);
      toast(result.ok ? "请求已交给启动器" : "Codex 未运行，或不是由 RLY/0 启动器启动");
    }
    async function load() {
      try {
        const [d, c] = await Promise.all([
          call("maintenance.diagnostics"),
          call("maintenance.cacheInfo"),
        ]);
        if (!alive()) return;
        diagnostics.replaceChildren(
          h(
            "p",
            null,
            d.advice.length
              ? d.advice.map((code) => advice[code] || "需要检查").join("；")
              : "配置和核心服务正常",
          ),
          h("p", { class: "wrap" }, d.codexHome),
        );
        cache.replaceChildren(
          h("p", null, `合计 ${bytes(c.totalBytes)}`),
          ...c.entries.map((e) =>
            h("p", null, `${e.name} · ${e.fileCount} 个文件 · ${bytes(e.sizeBytes)}`),
          ),
        );
      } catch (error) {
        if (alive()) failed(error);
      }
    }
    void load();
  };

  pages.updates = (root, alive) => {
    const result = h("div", { class: "sub" }, "点击检查，获取最新版本。");
    root.append(
      h(
        "section",
        { class: "m" },
        h("h2", null, "RLY/0 Hub 更新"),
        result,
        h(
          "div",
          { class: "row" },
          button("检查更新", async () => {
            result.textContent = "检查中…";
            try {
              const status = await call("updates.check");
              if (!alive()) return;
              result.replaceChildren(
                ...[
                  h("p", null, `当前版本 ${status.currentVersion}`),
                  h(
                    "p",
                    null,
                    status.latestVersion
                      ? `最新版本 ${status.latestVersion}${status.updateAvailable ? "，可前往发布页下载" : "，已是最新"}`
                      : "暂时无法检查，请前往发布页查看",
                  ),
                  status.error
                    ? h("p", null, "无法确认完整更新信息，请稍后重试或查看发布页。")
                    : null,
                  status.releaseNotes
                    ? h("p", { class: "release-copy" }, status.releaseNotes)
                    : null,
                ].filter(Boolean),
              );
            } catch (error) {
              if (alive()) result.textContent = "检查失败，请稍后重试或查看发布页。";
              throw error;
            }
          }),
          button("打开发布页", () => call("links.open", { target: "releases" })),
        ),
        h("p", { class: "sub" }, "检查无需启动 Codex。免安装版下载后手动替换；这里不会自动安装。"),
      ),
    );
  };
};
