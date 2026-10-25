"use strict";
// "统一渠道": one switch shown on 首页, 账号 → OpenAI · Codex and 中转站, on by default. With it on,
// every Codex conversation runs through RLY/0 Hub's local proxy, so one conversation can switch
// among the official accounts, 零号中转, custom providers of config.toml and API keys. The service
// (`relay.unifiedStatus` / `relay.unifiedSet`) only writes Hub's own setting file; Codex's
// config.toml is never touched. Switching reaches open conversations by itself (codex-apply.js).
window.registerHubUnifiedChannel = ({ h, call, toast, failed, applyToCodex }) => {
  const CHANGED = "hub:unified-channel-changed";
  const TITLE = "统一渠道";
  const NOTE = "同一对话切换账号和中转";
  const TIP =
    "只在这台电脑上转一下：用的还是 Codex 自己登录的同一个账号和凭据，不经过任何第三方服务器；关掉后完全恢复原来的方式。";
  const put = (element, ...items) =>
    element.replaceChildren(
      ...items
        .flat(Infinity)
        .filter((item) => item !== null && item !== undefined && item !== false),
    );

  function mount(section, alive, { compact = false } = {}) {
    let busy = false;
    async function load() {
      const status = await call("relay.unifiedStatus").catch(() => null);
      if (!alive()) {
        window.removeEventListener(CHANGED, load);
        return;
      }
      if (!status) {
        put(section, h("b", null, TITLE), h("p", { class: "sub" }, "暂时读不到这个设置，稍后再试"));
        return;
      }
      const enabled = status.enabled !== false;
      const toggle = h("button", {
        class: "switch",
        type: "button",
        role: "switch",
        "aria-checked": String(enabled),
        "aria-disabled": busy ? "true" : null,
        "aria-label": TITLE,
        onclick: async () => {
          if (busy) return;
          busy = true;
          const r = await call("relay.unifiedSet", { enabled: !enabled }).catch((error) => {
            failed(error);
            return null;
          });
          busy = false;
          window.dispatchEvent(new Event(CHANGED));
          if (!r) return;
          await applyToCodex("backend", r.enabled ? "已开启统一渠道" : "已关闭统一渠道");
        },
      });
      put(
        section,
        h(
          "div",
          { class: "row" },
          compact ? toggle : null,
          h(
            "div",
            { class: "who" },
            h("b", null, TITLE),
            h(
              "span",
              { class: "unified-note", "data-tip": TIP, title: TIP },
              enabled ? NOTE : "已关闭：对话固定用开始时的方式",
            ),
          ),
          compact ? null : h("span", { class: "spacer" }),
          compact ? null : toggle,
        ),
        compact
          ? null
          : h(
              "p",
              { class: "sub" },
              enabled
                ? "模型菜单可直接选官方账号、中转和 API Key"
                : "打开后，同一对话可换账号、换中转",
            ),
      );
    }
    window.addEventListener(CHANGED, load);
    load();
    return { reload: load };
  }

  return { mount };
};
