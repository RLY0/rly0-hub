"use strict";
// 打通设置: one place for what every agent shares — 概览 (switches + per-agent table), MCP,
// 技能, 记忆 (rly0-memory) and 线程 (Codex sessions). MCP / 技能 / 线程 reuse the managers that
// 设置 used to hold (pages/resources.js, pages/system.js); Codex opens them by the same names.
window.registerHubBridge = ({ pages, h, call, toast, failed, go, resourceSharing }) => {
  const TABS = [
    ["bridge", "概览"],
    ["mcp", "MCP"],
    ["skills", "技能"],
    ["memory", "记忆"],
    ["threads", "线程"],
  ];
  const info = (short, full) => window.HubUI.info(short, full);
  const PAGE_OF = { mcp: pages.mcp, skills: pages.skills, threads: pages.threads };

  /** The tab row and the chosen tab's content. */
  function frame(tab, root, alive, options) {
    const content = h("div", { class: "bridge-content" });
    root.append(
      h(
        "div",
        { class: "segment bridge-tabs", role: "tablist", "aria-label": "打通设置" },
        TABS.map(([id, label]) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              class: id === tab ? "on" : "",
              "aria-selected": id === tab ? "true" : "false",
              onclick: () => go(id),
            },
            label,
          ),
        ),
      ),
      content,
    );
    if (tab === "bridge") overview(content, alive);
    else if (tab === "memory") memory(content, alive);
    else PAGE_OF[tab](content, alive, options);
  }

  function overview(root, alive) {
    const card = h("section", { class: "m span-6 share-card" });
    resourceSharing.mount(card, alive);
    root.append(h("div", { class: "grid compact" }, card));
  }

  const SCOPES = [
    ["all", "全部"],
    ["project", "项目"],
    ["global", "全局"],
  ];
  const when = (time) =>
    new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const tail = (project) => (project ? project.split("/").filter(Boolean).slice(-2).join("/") : "");

  function memory(root, alive) {
    let scope = "all";
    let query = "";
    let timer;
    const list = h("div", { class: "memory-list" }, h("p", { class: "sub" }, "读取中…"));
    const summary = h("p", { class: "sub memory-summary" });
    const search = h("input", {
      class: "input",
      type: "search",
      placeholder: "搜索记忆",
      "aria-label": "搜索记忆",
      oninput: () => {
        query = search.value.trim();
        clearTimeout(timer);
        timer = setTimeout(load, 200);
      },
    });
    const scopes = h("div", { class: "segment", role: "tablist", "aria-label": "记忆范围" });
    const drawScopes = () =>
      scopes.replaceChildren(
        ...SCOPES.map(([id, label]) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              class: id === scope ? "on" : "",
              "aria-selected": id === scope ? "true" : "false",
              onclick: () => {
                scope = id;
                drawScopes();
                void load();
              },
            },
            label,
          ),
        ),
      );
    drawScopes();
    const text = h("textarea", { class: "input", rows: "3", placeholder: "要所有助手记住的事，不要写密钥", "aria-label": "记忆内容" });
    const kind = h(
      "select",
      { class: "input", "aria-label": "记忆范围" },
      h("option", { value: "global" }, "全局（所有项目）"),
      h("option", { value: "project" }, "只在一个项目"),
    );
    const project = h("input", { class: "input", placeholder: "项目文件夹完整路径", "aria-label": "项目文件夹" });
    const projectField = h("label", { class: "field" }, h("span", null, "项目"), project);
    projectField.hidden = true;
    kind.addEventListener("change", () => (projectField.hidden = kind.value !== "project"));
    const action = (label, run, extra = {}) =>
      h(
        "button",
        {
          class: "btn sm",
          type: "button",
          ...extra,
          onclick: async (event) => {
            const el = event.currentTarget;
            el.disabled = true;
            try {
              await run();
            } catch (error) {
              failed(error);
            } finally {
              el.disabled = false;
            }
          },
        },
        label,
      );
    root.append(
      h(
        "div",
        { class: "row section-title" },
        h("h2", null, "共享记忆"),
        h(
          "div",
          { class: "row memory-actions" },
          action("导出", async () => {
            const result = await call("memory.export");
            toast(`已导出 ${result.count} 条到 ${result.file}`);
          }),
          action("打开文件夹", () => call("memory.openFolder")),
        ),
      ),
      h(
        "p",
        { class: "sub page-note" },
        info(
          "所有助手共用，谁记下的都能看到",
          "rly0-memory 保存在本机 RLY/0 数据目录。每条记录有内容、标签、来自哪个助手、时间和范围（某个项目或全局）。写入和读出时都会去掉常见的密钥、令牌、密码、私钥和连接串；删除会把内容从磁盘上去掉，操作记录在 audit.jsonl 里（不含内容）。",
        ),
      ),
      h("div", { class: "row memory-filter" }, search, scopes),
      summary,
      list,
      h("h2", { class: "section-title" }, "添加记忆"),
      h(
        "section",
        { class: "m" },
        h(
          "div",
          { class: "form" },
          h("label", { class: "field" }, h("span", null, "内容"), text),
          h("label", { class: "field" }, h("span", null, "范围"), kind),
          projectField,
        ),
        h(
          "div",
          { class: "row" },
          action("记住", async () => {
            await call("memory.add", {
              text: text.value.trim(),
              scope: kind.value,
              ...(kind.value === "project" ? { project: project.value.trim() } : {}),
            });
            text.value = "";
            toast("已记住，所有助手都能用");
            await load();
          }),
        ),
      ),
    );
    async function load() {
      let result;
      try {
        result = await call("memory.list", { scope, ...(query ? { query } : {}) });
      } catch (error) {
        if (alive()) list.replaceChildren(h("p", { class: "empty" }, "读取失败，请刷新重试"));
        failed(error);
        return;
      }
      if (!alive()) return;
      summary.textContent = `共 ${result.total} 条 · ${result.projects} 个项目 · 来自 ${result.agents.length ? result.agents.join("、") : "—"}`;
      if (!result.records.length) {
        list.replaceChildren(h("p", { class: "empty" }, query ? "没有找到" : "还没有记忆"));
        return;
      }
      list.replaceChildren(
        ...result.records.map((record) => {
          const remove = h("button", { class: "btn sm", type: "button" }, "删除");
          const confirmTap = window.HubUI.armable(remove, { armedText: "确认删除" });
          remove.addEventListener("click", async () => {
            if (!confirmTap()) return;
            remove.disabled = true;
            try {
              await call("memory.forget", { id: record.id });
              toast("已删除");
              await load();
            } catch (error) {
              remove.disabled = false;
              failed(error);
            }
          });
          return h(
            "article",
            { class: "memory-item", "data-memory": record.id },
            h("p", { class: "memory-text" }, record.text),
            h(
              "div",
              { class: "row memory-meta" },
              h("span", { class: "tag" }, record.scope === "global" ? "全局" : tail(record.project) || "项目"),
              h("span", null, record.agent),
              ...record.tags.map((tag) => h("span", { class: "tag soft" }, tag)),
              h("span", { class: "sub" }, when(record.time)),
              remove,
            ),
          );
        }),
      );
    }
    void load();
  }

  for (const [id] of TABS) {
    const original = id === "bridge" || id === "memory" ? null : pages[id];
    if (original) PAGE_OF[id] = original;
    pages[id] = (root, alive, options) => frame(id, root, alive, options);
  }
  return { BRIDGE_TABS: TABS.map(([id]) => id) };
};
