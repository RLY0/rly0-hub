"use strict";
// Registration receives the same bridge and DOM helpers as the existing Hub pages.
window.registerHubResources = ({ pages, h, call, toast, failed }) => {
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
  function confirmButton(text, action) {
    let armed = false;
    let timer;
    const el = button(text, async () => {
      if (!armed) {
        armed = true;
        el.textContent = "确认" + text;
        clearTimeout(timer);
        timer = setTimeout(() => {
          armed = false;
          el.textContent = text;
        }, 4000);
        return;
      }
      armed = false;
      clearTimeout(timer);
      try {
        await action();
      } finally {
        el.textContent = text;
      }
    });
    return el;
  }

  pages.mcp = (root, alive) => {
    const list = h("div", { class: "grid compact" });
    const name = input("例如：docs");
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
    root.append(
      h("div", { class: "row section-title" }, h("h2", null, "MCP 服务"), button("刷新", load)),
      h(
        "p",
        { class: "sub page-note" },
        "管理本机 Codex 的 MCP 配置。修改后，新会话或重启 Codex 生效。",
      ),
      list,
      h("h2", { class: "section-title" }, "添加服务"),
      h(
        "section",
        { class: "m" },
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
          button("添加", async () => {
            const common = { name: name.value.trim(), type: type.value };
            await call(
              "mcp.add",
              type.value === "stdio"
                ? {
                    ...common,
                    command: command.value.trim(),
                    args: args.value.split("\n").filter(Boolean),
                  }
                : { ...common, url: url.value.trim() },
            );
            toast("已添加");
            name.value = "";
            await load();
          }),
        ),
      ),
    );
    async function load() {
      try {
        const result = await call("mcp.list");
        if (!alive()) return;
        list.replaceChildren(
          ...(result.parseError
            ? [h("section", { class: "m span-6" }, "配置格式有误，请检查 config.toml 后刷新。")]
            : result.servers.map((server) =>
                h(
                  "section",
                  { class: "m span-3" },
                  h(
                    "div",
                    { class: "row" },
                    h("b", null, server.name),
                    h("span", { class: "tag" }, server.enabled ? "已启用" : "已停用"),
                  ),
                  h(
                    "p",
                    { class: "sub wrap" },
                    server.type === "stdio" ? server.command : server.url,
                  ),
                  h(
                    "div",
                    { class: "row" },
                    button(server.enabled ? "停用" : "启用", async () => {
                      await call("mcp.setEnabled", { name: server.name, enabled: !server.enabled });
                      await load();
                    }),
                    confirmButton("移除", async () => {
                      await call("mcp.remove", { name: server.name });
                      await load();
                    }),
                  ),
                ),
              )),
        );
        if (!result.parseError && !result.servers.length)
          list.append(h("p", { class: "empty span-6" }, "还没有 MCP 服务"));
      } catch (error) {
        if (alive()) {
          list.replaceChildren(h("p", { class: "empty" }, "读取失败，请刷新重试"));
          failed(error);
        }
      }
    }
    void load();
  };

  pages.skills = (root, alive) => {
    const installed = h("div", { class: "grid compact" });
    const backups = h("div", { class: "grid compact" });
    const source = input("含 SKILL.md 的文件夹完整路径");
    const name = input("可选，默认用文件夹名");
    root.append(
      h("div", { class: "row section-title" }, h("h2", null, "已安装"), button("刷新", load)),
      h("p", { class: "sub page-note" }, "停用会移入备份，随时可以恢复。"),
      installed,
      h("h2", { class: "section-title" }, "从本地导入"),
      h(
        "section",
        { class: "m" },
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
            await load();
          }),
        ),
      ),
      h("h2", { class: "section-title" }, "已停用"),
      backups,
    );
    async function load() {
      try {
        const result = await call("skills.list");
        if (!alive()) return;
        installed.replaceChildren(
          ...result.installed.map((skill) =>
            h(
              "section",
              { class: "m span-3" },
              h("b", null, skill.title || skill.name),
              h("p", { class: "sub wrap" }, skill.description || skill.name),
              h(
                "div",
                { class: "row" },
                confirmButton("停用", async () => {
                  await call("skills.deactivate", { name: skill.name });
                  await load();
                }),
              ),
            ),
          ),
        );
        backups.replaceChildren(
          ...result.backups.map((skill) =>
            h(
              "section",
              { class: "m span-3" },
              h("b", null, skill.title || skill.name),
              h("p", { class: "sub" }, skill.backedUpAt || "已备份"),
              h(
                "div",
                { class: "row" },
                button("恢复", async () => {
                  await call("skills.restore", { backupId: skill.backupId });
                  await load();
                }),
              ),
            ),
          ),
        );
        if (!result.installed.length)
          installed.append(h("p", { class: "empty span-6" }, "还没有 Skills"));
        if (!result.backups.length)
          backups.append(h("p", { class: "empty span-6" }, "没有停用的 Skills"));
      } catch (error) {
        if (alive()) failed(error);
      }
    }
    void load();
  };
  return { button, confirmButton };
};
