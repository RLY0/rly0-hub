"use strict";
// Registration receives the same bridge and DOM helpers as the existing Hub pages.
window.registerHubResources = ({ pages, h, call, toast, failed, applyToCodex }) => {
  const button = (text, action) =>
    h(
      "button",
      {
        class: "btn sm",
        type: "button",
        onclick: async (event) => {
          const el = event.currentTarget;
          el.disabled = true;
          try {
            await action();
          } catch (error) {
            failed(error);
          } finally {
            el.disabled = false;
          }
        },
      },
      text,
    );
  const field = (label, input) => h("label", { class: "field" }, h("span", null, label), input);
  const input = (placeholder) => h("input", { class: "input", placeholder });
  // Where an item came from. Third-party installers put things in many places; the Hub picks
  // them up and shares them, so the card says whose folder holds the original.
  const SOURCE_LABELS = {
    codex: "Codex",
    claude: "Claude",
    agents: "共用目录",
    cursor: "Cursor",
    gemini: "Gemini",
    antigravity: "Antigravity",
    external: "外部安装",
  };
  const sourceTags = (item) => {
    const tags = [];
    if (item.source)
      tags.push(
        h(
          "span",
          { class: "tag soft", title: item.sourcePath || "" },
          `来自 ${SOURCE_LABELS[item.source] || item.source}`,
        ),
      );
    if (item.isLink)
      tags.push(h("span", { class: "tag soft", title: item.realPath || "" }, "快捷方式"));
    if (item.conflicts?.length)
      tags.push(
        h(
          "span",
          { class: "tag warn", title: item.conflicts.join("\n") },
          `另有 ${item.conflicts.length} 处同名`,
        ),
      );
    return tags.length ? [h("div", { class: "src-tags" }, ...tags)] : [];
  };
  // The list still works when part of it could not be read or copied; say so instead of hiding
  // it. A list load shows it as a line above the cards (it stays true until fixed); a button
  // click shows it once as a toast.
  const NATIVE_WARNINGS = {
    GLOBAL_CONFIG_SKILL_ROOT_UNAVAILABLE: "有个技能文件夹读不了，已先跳过，其余照常显示",
    GLOBAL_CONFIG_MCP_SOURCE_UNAVAILABLE: "有个助手的 MCP 配置读不了，已先跳过，其余照常显示",
  };
  const warningText = (result) =>
    result?.native?.error
      ? NATIVE_WARNINGS[result.native.error] || "同步给其他助手时出了问题，下次刷新会再试"
      : "";
  const nativeWarn = (result) => {
    const text = warningText(result);
    if (text) toast(text);
  };
  const warnLine = () => {
    const line = h("p", { class: "sub list-warn", role: "status" });
    line.hidden = true;
    return {
      line,
      show(result) {
        const text = warningText(result);
        line.hidden = !text;
        line.replaceChildren(
          ...(text ? [h("span", { class: "dot warn", "aria-hidden": "true" }), text] : []),
        );
      },
    };
  };
  function confirmButton(text, action) {
    let confirmTap = () => true;
    const el = button(text, async () => {
      if (!confirmTap()) return;
      await action();
    });
    confirmTap = window.HubUI.armable(el, { armedText: `确认${text}` });
    return el;
  }

  pages.mcp = (root, alive) => {
    const { listBar, newestFirst, matches } = window.HubUI;
    const list = h("div", { class: "grid compact" });
    const summary = h("p", { class: "sub list-summary" });
    let view = "on";
    let query = "";
    let data = null;
    const warn = warnLine();
    const name = input("例如：docs");
    // Editing: the panel under the search bar holds the server; saving changes only how it
    // connects. edit(null) resets it to "add" and closes it.
    let editing = null;
    const formTitle = h("h3", { class: "list-panel-title" }, "添加服务");
    const submit = h("span", null, "添加");
    const cancelEdit = h(
      "button",
      { class: "btn sm quiet", type: "button", onclick: () => edit(null) },
      "取消",
    );
    function edit(server) {
      editing = server;
      formTitle.textContent = server ? `修改 ${server.name}` : "添加服务";
      submit.textContent = server ? "保存修改" : "添加";
      name.value = server ? server.name : "";
      name.disabled = Boolean(server);
      type.value = server ? server.type : "stdio";
      type.dispatchEvent(new Event("change"));
      command.value = server && server.command ? server.command : "";
      args.value = server && server.args ? server.args.join("\n") : "";
      url.value = server && server.url ? server.url : "";
      tools.setOpen(Boolean(server));
      if (server) panel.scrollIntoView({ block: "nearest" });
    }
    const type = h(
      "select",
      { class: "input" },
      h("option", { value: "stdio" }, "本地命令"),
      h("option", { value: "http" }, "HTTP 地址"),
    );
    const command = input("例如：npx");
    const url = input("https://…");
    const args = h("textarea", { class: "input", rows: "3", placeholder: "每行一个参数" });
    const localFields = h(
      "div",
      { class: "form span-6" },
      field("命令", command),
      field("参数", args),
    );
    const remoteFields = field("地址", url);
    remoteFields.hidden = true;
    type.addEventListener("change", () => {
      localFields.hidden = type.value !== "stdio";
      remoteFields.hidden = type.value !== "http";
    });
    const panel = h(
      "section",
      { class: "m" },
      formTitle,
      h(
        "div",
        { class: "form" },
        field("名称", name),
        field("类型", type),
        localFields,
        remoteFields,
      ),
      h(
        "div",
        { class: "row" },
        button(submit, async () => {
          const common = { name: name.value.trim(), type: type.value };
          const updating = Boolean(editing);
          await call(
            updating ? "mcp.update" : "mcp.add",
            type.value === "stdio"
              ? {
                  ...common,
                  command: command.value.trim(),
                  args: args.value.split("\n").filter(Boolean),
                }
              : { ...common, url: url.value.trim() },
          );
          edit(null);
          await load();
          await applyToCodex("backend", updating ? "MCP 服务已修改" : "MCP 服务已添加");
        }),
        cancelEdit,
      ),
    );
    const tools = listBar({
      placeholder: "搜索服务名称、命令、地址或来源",
      onSearch: (value) => {
        query = value;
        draw();
      },
      segments: [
        ["on", "使用中"],
        ["off", "已停用"],
      ],
      current: view,
      onSegment: (id) => {
        view = id;
        draw();
      },
      addLabel: "+ 添加",
      panel,
    });
    // The add button always opens a blank form, even right after 修改 was used.
    tools.bar.querySelector(".list-add").addEventListener("click", () => {
      if (!editing) return;
      edit(null);
      tools.setOpen(true);
    });
    root.append(
      h("div", { class: "row section-title" }, h("h2", null, "MCP 服务"), button("刷新", load)),
      h("p", { class: "sub page-note" }, "所有助手共用；其他助手里配好的服务也会收进来"),
      tools.bar,
      panel,
      warn.line,
      summary,
      list,
    );
    async function load() {
      try {
        const result = await call("mcp.list");
        if (!alive()) return;
        data = result;
        warn.show(result);
        tools.setCounts({
          on: result.servers.filter((s) => s.enabled).length,
          off: result.servers.filter((s) => !s.enabled).length,
        });
        draw();
      } catch (error) {
        if (alive()) {
          list.replaceChildren(h("p", { class: "empty" }, "读取失败，请刷新重试"));
          failed(error);
        }
      }
    }
    function draw() {
      if (!data) return;
      if (data.parseError) {
        list.replaceChildren(
          h("section", { class: "m span-6" }, "配置格式有误，请检查 config.toml 后刷新。"),
        );
        summary.textContent = "";
        return;
      }
      const all = data.servers.filter((s) => (view === "on" ? s.enabled : !s.enabled));
      const shown = newestFirst(
        all
          .map((s) => ({ ...s, sourceLabel: SOURCE_LABELS[s.source] || s.source || "" }))
          .filter((s) => matches(s, query, ["name", "command", "url", "sourceLabel"])),
      );
      summary.textContent = query ? `找到 ${shown.length} 个，共 ${all.length} 个` : "";
      list.replaceChildren(
        ...shown.map((server) =>
          h(
            "section",
            { class: "m span-3" },
            h(
              "div",
              { class: "row" },
              h("b", null, server.name),
              h(
                "span",
                { class: "tag" },
                server.external
                  ? server.enabled
                    ? "共享中"
                    : "已停止共享"
                  : server.enabled
                    ? "已启用"
                    : "已停用",
              ),
            ),
            ...sourceTags(server),
            h("p", { class: "sub wrap" }, server.type === "stdio" ? server.command : server.url),
            // External servers live in another assistant's config file; the Hub only
            // decides whether to share them, so editing and removing stay with that app.
            server.external
              ? h(
                  "div",
                  { class: "row" },
                  button(server.enabled ? "停止共享" : "恢复共享", async () => {
                    nativeWarn(
                      await call("mcp.setEnabled", {
                        name: server.name,
                        enabled: !server.enabled,
                      }),
                    );
                    await load();
                    await applyToCodex("backend", server.enabled ? "已停止共享" : "已恢复共享");
                  }),
                )
              : h(
                  "div",
                  { class: "row" },
                  button("修改", async () => edit(server)),
                  button(server.enabled ? "停用" : "启用", async () => {
                    await call("mcp.setEnabled", {
                      name: server.name,
                      enabled: !server.enabled,
                    });
                    await load();
                    await applyToCodex("backend", server.enabled ? "已停用" : "已启用");
                  }),
                  confirmButton("移除", async () => {
                    await call("mcp.remove", { name: server.name });
                    await load();
                    await applyToCodex("backend", "已移除");
                  }),
                ),
          ),
        ),
      );
      if (!shown.length)
        list.append(
          h(
            "p",
            { class: "empty span-6" },
            query
              ? `没有找到“${query}”`
              : view === "on"
                ? "还没有 MCP 服务，点右上方“+ 添加”"
                : "没有停用的服务",
          ),
        );
    }
    void load();
  };

  pages.skills = (root, alive) => {
    const { listBar, newestFirst, matches } = window.HubUI;
    const grid = h("div", { class: "grid compact" }, h("p", { class: "empty span-6" }, "读取中…"));
    const summary = h("p", { class: "sub list-summary" });
    const source = input("含 SKILL.md 的文件夹完整路径");
    const name = input("可选，默认用文件夹名");
    let view = "installed";
    let query = "";
    const warn = warnLine();
    let data = null; // null until the first list arrives, so nothing claims "还没有技能" early
    const panel = h(
      "section",
      { class: "m" },
      h("h3", { class: "list-panel-title" }, "从本地导入"),
      h("div", { class: "form" }, field("文件夹", source), field("名称", name)),
      h(
        "div",
        { class: "row" },
        button("导入", async () => {
          await call("skills.import", {
            sourcePath: source.value.trim(),
            ...(name.value.trim() ? { name: name.value.trim() } : {}),
          });
          toast("已导入");
          source.value = "";
          name.value = "";
          tools.setOpen(false);
          view = "installed";
          tools.setSegment(view);
          await load();
        }),
        h(
          "button",
          { class: "btn sm quiet", type: "button", onclick: () => tools.setOpen(false) },
          "取消",
        ),
      ),
    );
    const tools = listBar({
      placeholder: "搜索技能名称、说明或来源",
      onSearch: (value) => {
        query = value;
        draw();
      },
      segments: [
        ["installed", "已安装"],
        ["backups", "已停用"],
      ],
      current: view,
      onSegment: (id) => {
        view = id;
        draw();
      },
      addLabel: "+ 导入",
      panel,
    });
    root.append(
      h(
        "div",
        { class: "row section-title" },
        h("h2", null, "技能"),
        h(
          "div",
          { class: "row" },
          button("打开文件夹", () => call("skills.openFolder", {})),
          button("刷新", load),
        ),
      ),
      h("p", { class: "sub page-note" }, "各助手装的技能都会收进来，所有助手共用；停用后可以恢复"),
      tools.bar,
      panel,
      warn.line,
      summary,
      grid,
    );
    const label = (skill) => ({
      ...skill,
      sourceLabel: SOURCE_LABELS[skill.source] || skill.source || "",
    });
    const installedCard = (skill) =>
      h(
        "section",
        { class: "m span-3" },
        h("b", null, skill.title || skill.name),
        ...sourceTags(skill),
        h("p", { class: "sub wrap" }, skill.description || skill.name),
        // Installed by another tool: moving its folder would break that tool's updates,
        // so the Hub can only stop sharing it.
        skill.distributionOnly
          ? h("p", { class: "sub note" }, "由安装它的程序管理，这里只能停止共享")
          : null,
        h(
          "div",
          { class: "row" },
          button("打开文件夹", () => call("skills.openFolder", { name: skill.name })),
          confirmButton(skill.distributionOnly ? "停止共享" : "停用", async () => {
            await call("skills.deactivate", { name: skill.name });
            await load();
          }),
        ),
      );
    const backupCard = (skill) =>
      h(
        "section",
        { class: "m span-3" },
        h("b", null, skill.title || skill.name),
        h(
          "p",
          { class: "sub" },
          skill.distributionOnly
            ? `已停止共享${skill.backedUpAt ? " · " + skill.backedUpAt : ""}`
            : skill.backedUpAt || "已备份",
        ),
        h(
          "div",
          { class: "row" },
          button(skill.distributionOnly ? "恢复共享" : "恢复", async () => {
            await call("skills.restore", { backupId: skill.backupId });
            await load();
          }),
        ),
      );
    function draw() {
      if (!data) return;
      const all = view === "installed" ? data.installed : data.backups;
      const shown = newestFirst(
        all
          .map(label)
          .filter((skill) =>
            matches(skill, query, ["name", "title", "description", "sourceLabel"]),
          ),
        view === "installed" ? "addedAt" : "backedUpAt",
      );
      grid.replaceChildren(...shown.map(view === "installed" ? installedCard : backupCard));
      summary.textContent = query ? `找到 ${shown.length} 个，共 ${all.length} 个` : "";
      if (!shown.length)
        grid.append(
          h(
            "p",
            { class: "empty span-6" },
            query
              ? `没有找到“${query}”`
              : view === "installed"
                ? "还没有技能，点右上方“+ 导入”添加"
                : "没有停用的技能",
          ),
        );
    }
    async function load() {
      try {
        const result = await call("skills.list");
        if (!alive()) return;
        warn.show(result);
        data = result;
        tools.setCounts({ installed: result.installed.length, backups: result.backups.length });
        draw();
      } catch (error) {
        if (alive()) failed(error);
      }
    }
    void load();
  };
  return { button, confirmButton };
};
