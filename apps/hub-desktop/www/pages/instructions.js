"use strict";
// 设置 → 自定义指令: the block RLY/0 Hub owns inside ~/.codex/AGENTS.md. Templates fill the
// editor, every change is previewed before it is written, and recent versions can be restored.
window.registerHubInstructions = ({ pages, h, call, toast, failed }) => {
  const put = (element, ...items) =>
    element.replaceChildren(
      ...items
        .flat(Infinity)
        .filter((item) => item !== null && item !== undefined && item !== false),
    );
  const time = (seconds) =>
    new Date(seconds * 1000).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const ACTIONS = { apply: "应用", clear: "清空", rollback: "回滚" };
  const ERRORS = {
    INSTRUCTIONS_MARKERS_DAMAGED: "AGENTS.md 里的 RLY/0 标记被改坏了，请手动修好后再试",
    INSTRUCTIONS_TOO_LONG: "内容太长了",
    INSTRUCTIONS_CONTENT_REJECTED: "内容里不能包含 RLY/0 的标记行",
  };
  const fail = (error) =>
    ERRORS[error && error.message] ? toast(ERRORS[error.message]) : failed(error);

  pages.instructions = (root, alive) => {
    const sharing = h("section", { class: "m span-6" });
    const status = h("section", { class: "m tone span-6" });
    const editorCard = h("section", { class: "m span-6 instructions-editor" });
    const preview = h("div");
    const historyCard = h("section", { class: "m span-6" });
    root.append(h("div", { class: "grid compact" }, sharing, status, editorCard, historyCard));
    call("resources.sharingGet")
      .then((state) => {
        if (!alive()) return;
        const toggle = h(
          "button",
          {
            class: "btn sm",
            type: "button",
            role: "switch",
            "aria-checked": String(state.enabled),
            onclick: async () => {
              toggle.disabled = true;
              try {
                state = await call("resources.sharingSet", { enabled: !state.enabled });
                toggle.setAttribute("aria-checked", String(state.enabled));
                toggle.textContent = state.enabled ? "已开启" : "开启共享";
                toast("已保存；MCP 在新建或重新打开的助手会话生效");
              } catch (error) {
                failed(error);
              } finally {
                toggle.disabled = false;
              }
            },
          },
          state.enabled ? "已开启" : "开启共享",
        );
        sharing.append(
          h("b", null, "向其他助手共享 Codex 资源"),
          h(
            "p",
            { class: "sub" },
            "共享当前项目记忆、通用偏好和技能索引。Claude/Grok 接入兼容的 MCP；Gemini 当前共享技能和记忆，MCP 尚未转接。工具仍需各助手原有审批，OAuth 授权不复制。",
          ),
          toggle,
        );
      })
      .catch(() => {
        if (alive())
          sharing.append(
            h("p", { class: "sub" }, "资源共享设置读取失败，请更新完整安装包后重试。"),
          );
      });
    const editor = h("textarea", {
      class: "input instructions-text",
      rows: "10",
      spellcheck: "false",
      "aria-label": "自定义指令内容",
      placeholder: "写给所有 Codex 对话的长期要求，例如：用中文回答、改代码前先列计划……",
    });
    let chosenTemplate;
    let state = null;

    async function load(keepEditor) {
      state = await call("instructions.state").catch(() => null);
      if (!alive() || !state) return;
      put(
        status,
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "who" },
            h("b", null, "全局自定义指令"),
            h("span", { class: "tabular" }, state.filePath),
          ),
          h(
            "span",
            { class: `tag ${state.managed ? "ok" : ""}` },
            state.protected ? "Protected" : state.managed ? "Managed" : "Not set",
          ),
        ),
        h(
          "p",
          { class: "sub" },
          "对所有 Codex 对话生效。只改 Hub 自己的那一段，你手写的其他规则和项目里的 AGENTS.md 都不动。",
        ),
        state.protected
          ? h(
              "p",
              { class: "warn-text" },
              "文件里的 RLY/0 标记不完整或重复了，为了不误改，Hub 暂时不会写入。",
            )
          : null,
        state.otherBlocks.length
          ? h(
              "p",
              { class: "sub" },
              `文件里还有 ${state.otherBlocks.join("、")} 写的一段，Hub 不会动它。`,
            )
          : null,
      );
      if (!keepEditor) editor.value = state.content;
      renderEditor();
      renderHistory();
    }

    function renderEditor() {
      put(
        editorCard,
        h("span", { class: "label" }, "Templates"),
        h(
          "div",
          { class: "row template-row" },
          state.templates.map((template) =>
            h(
              "button",
              {
                class: "btn sm",
                type: "button",
                onclick: () => {
                  const text = editor.value.trim();
                  editor.value =
                    text && !text.includes(template.content)
                      ? `${text}\n${template.content}`
                      : template.content;
                  chosenTemplate = template.id;
                  editor.focus();
                },
              },
              `+ ${template.name}`,
            ),
          ),
        ),
        editor,
        h(
          "div",
          { class: "row" },
          h(
            "button",
            { class: "btn paper", type: "button", disabled: state.protected, onclick: showPreview },
            "预览并应用",
          ),
          h(
            "button",
            {
              class: "btn quiet",
              type: "button",
              onclick: () => {
                editor.value = state.content;
                put(preview);
              },
            },
            "恢复当前生效内容",
          ),
          h("span", { class: "spacer" }),
          state.managed ? clearButton() : null,
        ),
        preview,
      );
    }

    function clearButton() {
      let confirmTap = () => true;
      const button = h(
        "button",
        {
          class: "btn quiet",
          type: "button",
          onclick: () => {
            if (!confirmTap()) return;
            call("instructions.clear").then(() => {
              toast("已清空 Hub 管理的那一段");
              load();
            }, fail);
          },
        },
        "清空",
      );
      confirmTap = window.HubUI.armable(button, { armedText: "确认清空" });
      return button;
    }

    async function showPreview() {
      const result = await call("instructions.preview", { content: editor.value }).catch(
        (error) => {
          fail(error);
          return null;
        },
      );
      if (!result || !alive()) return;
      if (result.current === result.next) {
        toast("内容没有变化");
        return;
      }
      put(
        preview,
        h(
          "div",
          { class: "instructions-compare" },
          h(
            "div",
            null,
            h("span", { class: "label" }, "Now"),
            h("pre", null, result.current || "（空）"),
          ),
          h(
            "div",
            null,
            h("span", { class: "label" }, "After"),
            h("pre", null, result.next || "（清空）"),
          ),
        ),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn red",
              type: "button",
              onclick: () =>
                call("instructions.apply", {
                  content: editor.value,
                  ...(chosenTemplate ? { template: chosenTemplate } : {}),
                }).then(() => {
                  toast("已更新，新开的 Codex 对话生效");
                  put(preview);
                  load();
                }, fail),
            },
            "确认应用",
          ),
          h("button", { class: "btn quiet", type: "button", onclick: () => put(preview) }, "取消"),
        ),
      );
    }

    function renderHistory() {
      put(
        historyCard,
        h("span", { class: "label" }, "History"),
        state.history.length
          ? h(
              "div",
              { class: "history-list" },
              state.history.map((entry, index) =>
                h(
                  "div",
                  { class: "row history-row" },
                  h("span", { class: "sub tabular" }, time(entry.at)),
                  h("span", { class: "tag" }, ACTIONS[entry.action] || entry.action),
                  h("span", { class: "history-preview" }, entry.preview || "（空）"),
                  h("span", { class: "spacer" }),
                  index === 0
                    ? h("span", { class: "sub" }, "当前")
                    : h(
                        "button",
                        {
                          class: "btn quiet sm",
                          type: "button",
                          disabled: state.protected,
                          onclick: () =>
                            call("instructions.rollback", { id: entry.id }).then(() => {
                              toast("已回滚到这个版本");
                              load();
                            }, fail),
                        },
                        "回滚到这里",
                      ),
                ),
              ),
            )
          : h("p", { class: "sub" }, "还没有改过。每次应用都会留一份，最多保留 10 份。"),
      );
    }

    load();
  };
};
