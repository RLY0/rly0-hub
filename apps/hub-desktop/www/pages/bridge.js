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
    new Date(time).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const tail = (project) => (project ? project.split("/").filter(Boolean).slice(-2).join("/") : "");

  const PINNED_MAX = 20; // matches PREFERENCE_LIMITS.records in host-runtime

  function memory(root, alive) {
    let scope = "all";
    let query = "";
    let timer;
    const list = h("div", { class: "memory-list" }, h("p", { class: "sub" }, "读取中…"));
    // 常驻偏好: pinned memories every agent reads at the start of a new chat.
    const pinnedList = h("div", { class: "memory-list" }, h("p", { class: "sub" }, "读取中…"));
    const pinnedCount = h("span", { class: "tag" });
    const syncNote = h("div", { class: "row pinned-sync", role: "status" });
    syncNote.hidden = true;
    const showSync = (code) => {
      syncNote.hidden = !code;
      if (!code) return syncNote.replaceChildren();
      syncNote.replaceChildren(
        h("span", { class: "dot warn", "aria-hidden": "true" }),
        h("span", null, "已保存，但还没同步给 Codex，Codex 新对话暂时读不到"),
        action("重试同步", async () => {
          await call("bridge.syncNative");
          showSync(null);
          toast("已同步");
        }),
      );
    };
    const afterNative = (result) => {
      const code = result && result.native && result.native.error;
      showSync(code || null);
      return !code;
    };
    const pinButton = (record) =>
      action(record.pinned ? "取消常驻" : "设为常驻", async () => {
        const result = await call("memory.pin", { id: record.id, pinned: !record.pinned });
        if (!result.record) {
          toast("这条记忆已不存在，请刷新");
        } else if (afterNative(result)) {
          toast(
            record.pinned ? "已取消，新对话不再自动带上" : "已设为常驻，所有助手新对话都会遵守",
          );
        }
        await load();
      });
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
    const text = h("textarea", {
      class: "input",
      rows: "3",
      placeholder: "要所有助手记住的事，不要写密钥",
      "aria-label": "记忆内容",
    });
    const kind = h(
      "select",
      { class: "input", "aria-label": "记忆范围" },
      h("option", { value: "global" }, "全局（所有项目）"),
      h("option", { value: "project" }, "只在一个项目"),
    );
    const project = h("input", {
      class: "input",
      placeholder: "项目文件夹完整路径",
      "aria-label": "项目文件夹",
    });
    const projectField = h("label", { class: "field" }, h("span", null, "项目"), project);
    projectField.hidden = true;
    kind.addEventListener("change", () => (projectField.hidden = kind.value !== "project"));
    const pinNew = h("input", { type: "checkbox" });
    function action(label, run, extra = {}) {
      return h(
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
    }
    // 添加 opens right under the title, so a new memory is written where the page starts.
    const addPanel = h(
      "section",
      { class: "m" },
      h("h3", { class: "list-panel-title" }, "添加记忆"),
      h(
        "div",
        { class: "form" },
        h("label", { class: "field" }, h("span", null, "内容"), text),
        h("label", { class: "field" }, h("span", null, "范围"), kind),
        projectField,
        h(
          "label",
          { class: "row pin-check" },
          pinNew,
          h("span", null, "设为常驻偏好（所有助手新对话都会遵守）"),
        ),
      ),
      h(
        "div",
        { class: "row" },
        action("记住", async () => {
          const result = await call("memory.add", {
            text: text.value.trim(),
            scope: kind.value,
            ...(kind.value === "project" ? { project: project.value.trim() } : {}),
            ...(pinNew.checked ? { tags: ["preference"] } : {}),
          });
          text.value = "";
          if (afterNative(result))
            toast(pinNew.checked ? "已记住，所有助手新对话都会遵守" : "已记住，所有助手都能用");
          pinNew.checked = false;
          setAddOpen(false);
          await load();
        }),
        h(
          "button",
          { class: "btn sm quiet", type: "button", onclick: () => setAddOpen(false) },
          "取消",
        ),
      ),
    );
    addPanel.classList.add("list-panel");
    addPanel.hidden = true;
    const addButton = h(
      "button",
      {
        class: "btn sm paper list-add",
        type: "button",
        "aria-expanded": "false",
        onclick: () => setAddOpen(addPanel.hidden),
      },
      "+ 添加",
    );
    function setAddOpen(open) {
      addPanel.hidden = !open;
      addButton.setAttribute("aria-expanded", String(open));
      addButton.classList.toggle("on", open);
      if (open) text.focus();
    }
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
          addButton,
        ),
      ),
      h("p", { class: "sub page-note" }, "所有助手共用，谁记下的都能看到"),
      addPanel,
      h(
        "section",
        { class: "m pinned-card", "aria-label": "常驻偏好" },
        h(
          "div",
          { class: "row pinned-head" },
          h("h3", null, "常驻偏好"),
          pinnedCount,
          info(
            "新对话自动带上",
            "Claude、Codex 等所有助手每次开新对话都会先读这些，用来定规矩，比如“回答一律用中文”。普通记忆要助手想起来才去查。",
          ),
        ),
        syncNote,
        pinnedList,
      ),
      h("h3", { class: "memory-sub" }, "其他记忆"),
      h("div", { class: "row memory-filter" }, search, scopes),
      summary,
      list,
    );
    function item(record) {
      const remove = h("button", { class: "btn sm", type: "button" }, "删除");
      const confirmTap = window.HubUI.armable(remove, { armedText: "确认删除" });
      remove.addEventListener("click", async () => {
        if (!confirmTap()) return;
        remove.disabled = true;
        try {
          const result = await call("memory.forget", { id: record.id });
          if (afterNative(result)) toast("已删除");
          await load();
        } catch (error) {
          remove.disabled = false;
          failed(error);
        }
      });
      return h(
        "article",
        { class: `memory-item${record.pinned ? " pinned" : ""}`, "data-memory": record.id },
        h("p", { class: "memory-text" }, record.text),
        h(
          "div",
          { class: "row memory-meta" },
          h(
            "span",
            { class: "tag" },
            record.scope === "global" ? "全局" : tail(record.project) || "项目",
          ),
          h("span", null, record.agent),
          ...record.tags
            .filter((tag) => tag !== "preference")
            .map((tag) => h("span", { class: "tag soft" }, tag)),
          h("span", { class: "sub" }, when(record.time)),
          h("span", { class: "memory-buttons row" }, pinButton(record), remove),
        ),
      );
    }
    async function load() {
      let result;
      let pinned;
      try {
        [result, pinned] = await Promise.all([
          call("memory.list", { scope, pinned: false, ...(query ? { query } : {}) }),
          call("memory.list", { pinned: true, limit: 500 }),
        ]);
      } catch (error) {
        if (alive()) {
          list.replaceChildren(h("p", { class: "empty" }, "读取失败，请刷新重试"));
          pinnedList.replaceChildren(h("p", { class: "empty" }, "读取失败，请刷新重试"));
        }
        failed(error);
        return;
      }
      if (!alive()) return;
      const over = pinned.records.length > PINNED_MAX;
      pinnedCount.textContent = `${pinned.records.length} / ${PINNED_MAX}`;
      pinnedCount.classList.toggle("warn", over);
      pinnedList.replaceChildren(
        ...(pinned.records.length
          ? pinned.records.map(item)
          : [h("p", { class: "empty" }, "还没有常驻偏好，在下面的记忆上点「设为常驻」")]),
        ...(over
          ? [
              h(
                "p",
                { class: "sub warn" },
                `超过 ${PINNED_MAX} 条，多出的不会自动带上，助手需要时再去查`,
              ),
            ]
          : []),
      );
      summary.textContent = `共 ${result.total} 条 · ${result.projects} 个项目 · 来自 ${result.agents.length ? result.agents.join("、") : "—"}`;
      list.replaceChildren(
        ...(result.records.length
          ? result.records.map(item)
          : [h("p", { class: "empty" }, query ? "没有找到" : "还没有其他记忆")]),
      );
    }
    void load();
    // A failed sync from an earlier change (or at Hub start) still shows here.
    call("bridge.status")
      .then((status) => alive() && status && showSync(status.nativeError || null))
      .catch(() => undefined);
  }

  for (const [id] of TABS) {
    const original = id === "bridge" || id === "memory" ? null : pages[id];
    if (original) PAGE_OF[id] = original;
    pages[id] = (root, alive, options) => frame(id, root, alive, options);
  }
  return { BRIDGE_TABS: TABS.map(([id]) => id) };
};
