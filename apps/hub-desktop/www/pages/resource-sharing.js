"use strict";
// 打通设置 → 概览: share MCP servers, skills and memory with every agent, and what each agent
// gets. Service side: resources.sharingGet / resources.sharingSet (shared-harness-resources.ts)
// and bridge.status / bridge.globalSet (rly0-hub-service/bridge-routes.ts). Agents read the
// settings each time they open a conversation or send a message; Codex's own memory server entry
// is written by the Hub and applied by codex-apply, so nothing needs a manual restart.
window.registerHubResourceSharing = ({ h, call, toast, failed, applyToCodex }) => {
  const info = (short, full) => window.HubUI.info(short, full);
  const KINDS = [
    {
      key: "mcp",
      label: "MCP",
      hint: "MCP 服务器接到每个助手",
      full: "MCP 管理里的服务器（来自 Codex 配置）按每个助手自己的方式接上：Claude / Grok / Kiro / Kimi / Cursor / CodeBuddy 走会话参数，OpenCode 走进程配置，Pi 走临时扩展。密钥只进本机的助手进程，不写进对话，也不写进全局文件。需要 OAuth 或限定了工具的服务器不转接。",
    },
    {
      key: "skills",
      label: "技能",
      hint: "Codex 的技能给每个助手用",
      full: "Pi 和 Hermes 直接注册技能文件夹；其他助手拿到技能目录（名称、说明、SKILL.md 位置），用到时自己去读。",
    },
    {
      key: "memory",
      label: "记忆",
      hint: "所有助手共用一份记忆 rly0-memory",
      full: "rly0-memory 是本机的共享记忆：能接 MCP 的助手（包括 Codex 自己）可以记住、回想、搜索、删除，任何一个助手记下的其他助手都能看到。不能接 MCP 的助手只读到本项目和全局记忆的摘要。写入和读出时都会去掉常见的密钥、令牌、密码、私钥和连接串，但记忆内容会发给各助手的模型厂商。",
    },
  ];
  const MODE_TEXT = { native: "已接通", context: "已接通 · 提示注入", global: "需单独开启" };
  /** One table cell: 已接通 / 需要安装 / 不支持（原因）, following the switch and the agent. */
  function cell(agent, kind, state, globals) {
    const mode = (agent.modes && agent.modes[kind.key]) || (agent.support[kind.key] ? "native" : "none");
    if (mode === "none") return h("span", { class: "share-cell no" }, "不支持");
    if (!state[kind.key]) return h("span", { class: "share-cell off" }, "已关闭");
    if (agent.blocked) return h("span", { class: "share-cell off", title: agent.blocked }, "暂停");
    if (agent.installed === false) return h("span", { class: "share-cell off" }, "需要安装");
    if (mode === "global") {
      const on = globals.some((g) => g.agent === agent.id && g.enabled);
      return h("span", { class: `share-cell ${on ? "yes" : "off"}` }, on ? "已接通 · 全局" : MODE_TEXT.global);
    }
    return h("span", { class: "share-cell yes" }, `✓ ${MODE_TEXT[mode]}`);
  }

  /** Fills `card` and keeps it in sync with the service. */
  function mount(card, alive) {
    let state; // undefined while loading, null when the service could not answer
    let bridge = { globals: [], memoryServer: { available: false } };
    let busy = false;
    const render = () => {
      if (!alive()) return;
      card.replaceChildren(
        h(
          "div",
          { class: "row share-head" },
          h(
            "div",
            { class: "who" },
            h("b", null, "MCP / 技能 / 记忆 打通给所有助手"),
            info(
              "改了自动生效，不用重启",
              "新对话和下一条消息起生效；Codex 自己的记忆服务器由 Hub 写进配置后自动应用。已打开的对话里已挂上的 MCP 在重新打开后更新。",
            ),
          ),
        ),
      );
      if (state === undefined) return void card.append(h("p", { class: "sub" }, "读取中…"));
      if (!state)
        return void card.append(h("p", { class: "sub" }, "打通设置读取失败，请更新完整安装包后重试。"));
      const toggles = h("div", { class: "share-toggles" });
      for (const kind of KINDS) {
        const on = Boolean(state[kind.key]);
        toggles.append(
          h(
            "div",
            { class: "row share-toggle" },
            h("div", { class: "who" }, h("b", null, kind.label), info(kind.hint, kind.full)),
            h("button", {
              class: "switch",
              type: "button",
              role: "switch",
              "aria-checked": String(on),
              "aria-label": `打通${kind.label}`,
              disabled: busy,
              onclick: () => change(kind, !on),
            }),
          ),
        );
      }
      const codexMemory = !state.memory
        ? h("span", { class: "share-cell off" }, "已关闭")
        : bridge.memoryServer.available
          ? h("span", { class: "share-cell yes" }, "✓ 已接通")
          : h("span", { class: "share-cell no", title: "这个版本没有带记忆服务器" }, "需要安装");
      const rows = [
        h(
          "tr",
          { "data-agent": "codex" },
          h("th", { scope: "row" }, h("b", null, "Codex"), h("span", { class: "share-note" }, "MCP 和技能的来源")),
          h("td", null, h("span", { class: "share-cell yes" }, "本身")),
          h("td", null, h("span", { class: "share-cell yes" }, "本身")),
          h("td", null, codexMemory),
        ),
        ...(state.agents || []).map((agent) =>
          h(
            "tr",
            { class: agent.installed ? "" : "dormant", "data-agent": agent.id },
            h(
              "th",
              { scope: "row" },
              h("b", null, agent.name),
              agent.blocked || agent.note
                ? h("span", { class: "share-note" }, agent.blocked || agent.note)
                : null,
            ),
            ...KINDS.map((kind) => h("td", null, cell(agent, kind, state, bridge.globals))),
          ),
        ),
      ];
      card.append(
        toggles,
        h(
          "div",
          { class: "share-scroll" },
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
        ),
        globalSection(),
      );
    };
    /** Agents that read MCP only from a global file: one opt-in switch each, off by default. */
    function globalSection() {
      const names = { antigravity: "Antigravity（agy）", hermes: "Hermes" };
      return h(
        "div",
        { class: "share-globals" },
        h(
          "div",
          { class: "who" },
          h("b", null, "只能改全局配置的助手"),
          info(
            "默认不改，开了才写",
            "这两个助手只从自己的全局配置文件读取 MCP。开启后 Hub 先备份那个文件，只添加 rly0-* 条目（含共享记忆），带密钥的服务器不写进去；关闭时只删掉这些条目。",
          ),
        ),
        ...bridge.globals.map((g) =>
          h(
            "div",
            { class: "row share-toggle", "data-global": g.agent },
            h(
              "div",
              { class: "who" },
              h("b", null, names[g.agent] || g.agent),
              h("span", { class: "share-note mono" }, g.file),
              g.enabled && g.skipped.length
                ? h("span", { class: "share-note" }, `带密钥未写入：${g.skipped.join("、")}`)
                : null,
            ),
            h("button", {
              class: "switch",
              type: "button",
              role: "switch",
              "aria-checked": String(g.enabled),
              "aria-label": `${names[g.agent] || g.agent} 写入全局 MCP`,
              disabled: busy,
              onclick: () => setGlobal(g, !g.enabled),
            }),
          ),
        ),
      );
    }
    async function setGlobal(g, next) {
      busy = true;
      render();
      try {
        const updated = await call("bridge.globalSet", { agent: g.agent, enabled: next });
        bridge.globals = bridge.globals.map((x) => (x.agent === g.agent ? updated : x));
        toast(next ? "已写入，并备份了原文件" : "已删掉 Hub 写入的条目");
      } catch (error) {
        failed(error);
      } finally {
        busy = false;
        render();
      }
    }
    async function change(kind, next) {
      busy = true;
      render();
      try {
        const result = await call("resources.sharingSet", { [kind.key]: next });
        state = result;
        if (kind.key === "memory" && result.codexMemory && result.codexMemory !== "unchanged")
          await applyToCodex("backend", next ? "已打通记忆" : "已停止共享记忆");
        else toast(next ? `已打通${kind.label}，新对话起生效` : `已停止共享${kind.label}`);
      } catch (error) {
        failed(error);
      } finally {
        busy = false;
        render();
      }
    }
    Promise.all([call("resources.sharingGet"), call("bridge.status").catch(() => null)])
      .then(([value, status]) => {
        state = value && Array.isArray(value.agents) ? value : null;
        if (status && Array.isArray(status.globals)) bridge = status;
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
