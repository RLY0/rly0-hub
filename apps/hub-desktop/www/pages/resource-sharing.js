"use strict";
// "AI 助手" page card: share Codex's MCP servers, skills and memory with the other agents.
// Service side: resources.sharingGet / resources.sharingSet (shared-harness-resources.ts). The
// agents read the setting each time they open a conversation or send a message, so a change
// needs no Codex restart; MCP already attached to an open Claude / Grok conversation stays
// until that conversation is reopened.
window.registerHubResourceSharing = ({ h, call, toast, failed }) => {
  const KINDS = [
    {
      key: "mcp",
      label: "MCP 服务器",
      hint: "把 Codex 配置里的 MCP 服务器接到支持的助手上。需要 OAuth 登录或限定了工具的服务器不转接。密钥只交给本机的助手进程，不会写进对话。",
    },
    {
      key: "skills",
      label: "技能",
      hint: "告诉助手 Codex 装了哪些技能、SKILL.md 在哪里，用到时由助手自己去读。",
    },
    {
      key: "memory",
      label: "记忆",
      hint: "当前项目的 Codex 记忆和通用偏好。默认关闭：内容会发给其他厂商的模型，常见密钥格式会被去掉，但不能保证没有别的隐私。",
    },
  ];
  const cell = (supported, on, blocked) => {
    if (!supported) return h("span", { class: "share-cell no", title: "这个助手接不了" }, "不支持");
    if (blocked) return h("span", { class: "share-cell off", title: blocked }, "暂停");
    return on
      ? h("span", { class: "share-cell yes" }, "✓ 共享")
      : h("span", { class: "share-cell off" }, "已关闭");
  };

  /** Fills `card` and keeps it in sync with the service. */
  function mount(card, alive) {
    let state; // undefined while loading, null when the service could not answer
    let busy = false;
    const render = () => {
      if (!alive()) return;
      card.replaceChildren();
      card.append(
        h(
          "div",
          { class: "row share-head" },
          h(
            "div",
            { class: "who" },
            h("b", null, "共享 Codex 的 MCP / 技能 / 记忆给其他助手"),
            h(
              "span",
              null,
              "新对话和下一条消息起生效，不用重启 Codex。已打开的 Claude / Grok 对话里的 MCP 在重新打开后生效。",
            ),
          ),
        ),
      );
      if (state === undefined) {
        card.append(h("p", { class: "sub" }, "读取中…"));
        return;
      }
      if (!state) {
        card.append(h("p", { class: "sub" }, "资源共享设置读取失败，请更新完整安装包后重试。"));
        return;
      }
      const toggles = h("div", { class: "share-toggles" });
      for (const kind of KINDS) {
        const on = Boolean(state[kind.key]);
        toggles.append(
          h(
            "div",
            { class: "row share-toggle" },
            h("div", { class: "who" }, h("b", null, kind.label), h("span", null, kind.hint)),
            h("button", {
              class: "switch",
              type: "button",
              role: "switch",
              "aria-checked": String(on),
              "aria-label": `共享 Codex 的${kind.label}`,
              disabled: busy,
              onclick: () => change(kind, !on),
            }),
          ),
        );
      }
      const rows = (state.agents || []).map((agent) =>
        h(
          "tr",
          { class: agent.installed ? "" : "dormant" },
          h(
            "th",
            { scope: "row" },
            h("b", null, agent.name),
            agent.blocked || agent.note
              ? h("span", { class: "share-note" }, agent.blocked || agent.note)
              : null,
          ),
          ...KINDS.map((kind) =>
            h("td", null, cell(agent.support[kind.key], state[kind.key], agent.blocked)),
          ),
        ),
      );
      card.append(
        toggles,
        h(
          "table",
          { class: "share-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { scope: "col" }, "助手"),
              ...KINDS.map((kind) => h("th", { scope: "col" }, kind.label)),
            ),
          ),
          h("tbody", null, ...rows),
        ),
      );
    };
    async function change(kind, next) {
      busy = true;
      render();
      try {
        state = await call("resources.sharingSet", { [kind.key]: next });
        toast(
          next
            ? `已开启共享${kind.label}，新对话和下一条消息起生效`
            : `已停止共享${kind.label}，新对话和下一条消息起生效`,
        );
      } catch (error) {
        failed(error);
      } finally {
        busy = false;
        render();
      }
    }
    call("resources.sharingGet")
      .then((value) => {
        state = value && Array.isArray(value.agents) ? value : null;
        render();
      })
      .catch(() => {
        state = null;
        render();
      });
    render();
  }
  return { mount };
};
