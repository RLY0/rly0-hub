"use strict";
// "不登录 OpenAI 也能用": one switch shown on 首页, 账号 → OpenAI · Codex and 中转站. The service
// (`relay.noAccountStatus`, read from ~/.codex/config.toml) is the only state; every mounted card
// re-reads it after any of them changes it. Turning it on shows the exact changes first; on and
// off both reach Codex by themselves (codex-apply.js).
window.registerHubNoAccount = ({ h, call, toast, failed, applyToCodex }) => {
  const CHANGED = "hub:no-account-changed";
  const put = (element, ...items) =>
    element.replaceChildren(
      ...items
        .flat(Infinity)
        .filter((item) => item !== null && item !== undefined && item !== false),
    );
  const changed = () => window.dispatchEvent(new Event(CHANGED));

  function enableDialog(models) {
    const ui = window.HubUI.dialog({
      title: "不登录 OpenAI 也能用",
      sub: "会修改 Codex 的设置文件，改之前先备份，随时可以关掉恢复",
    });
    const model = h(
      "select",
      { class: "input", "aria-label": "默认模型" },
      models.map((m) => h("option", { value: m }, m)),
    );
    const plan = h("div");
    const confirm = h("button", { class: "btn red", type: "button", disabled: true }, "开启并应用");
    const preview = async () => {
      confirm.disabled = true;
      const result = await call("relay.noAccountPreview", { model: model.value }).catch((error) => {
        failed(error);
        return null;
      });
      if (!result) return;
      put(
        plan,
        h("span", { class: "label" }, "会修改"),
        h("p", { class: "sub tabular" }, result.configPath),
        h("pre", { class: "plan-lines" }, result.changes.join("\n")),
        h(
          "ul",
          { class: "plan-notes" },
          h(
            "li",
            { "data-brief": "Codex 模型菜单只显示中转模型" },
            "开启后 Codex 只用中转站的模型，模型菜单只显示中转模型，官方模型暂时不可用；已选的官方模型自动换成同名中转模型（没有同名时用默认模型）。",
          ),
          h("li", null, "Hub 要一直在托盘里运行（开机自启已默认打开）。"),
          h(
            "li",
            { "data-brief": "会自动让 Codex 重新打开一次，对话记录都在" },
            "开启后 Hub 会自动让 Codex 重新打开一次来生效，对话记录都在；Codex 正在回复时，会等它回复完。",
          ),
        ),
      );
      confirm.disabled = false;
    };
    model.addEventListener("change", preview);
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      const r = await call("relay.noAccountEnable", { model: model.value, confirmed: true }).catch(
        (error) => {
          failed(error);
          return null;
        },
      );
      ui.close();
      if (!r) return;
      if (!r.noAccount) {
        toast("没有开启成功");
        return;
      }
      changed();
      await applyToCodex("window", "已开启不登录 OpenAI 模式");
    });
    put(ui.body, h("label", { class: "field" }, h("span", null, "默认模型"), model), plan);
    put(
      ui.foot,
      h("span", { class: "spacer" }),
      h("button", { class: "btn quiet", type: "button", onclick: () => ui.close() }, "取消"),
      confirm,
    );
    preview();
  }

  /**
   * The switch card. `section` is the module element to fill; `alive` stops updates once the page
   * is gone. `compact` drops the longer note (for 首页).
   */
  function mount(section, alive, { compact = false } = {}) {
    let busy = false;
    async function load() {
      const status = await call("relay.noAccountStatus").catch(() => null);
      if (!alive()) {
        window.removeEventListener(CHANGED, load);
        return;
      }
      if (!status) {
        put(
          section,
          h("b", null, "不登录 OpenAI 也能用"),
          h("p", { class: "sub" }, "暂时读不到 Codex 设置，稍后再试"),
        );
        return;
      }
      const blocked = status.enabled
        ? null
        : status.models.length
          ? null
          : "先添加一个有 GPT 模型的中转站，才能打开";
      const toggle = h("button", {
        class: `switch ${blocked ? "off" : ""}`,
        type: "button",
        role: "switch",
        "aria-checked": String(Boolean(status.enabled)),
        "aria-disabled": blocked || busy ? "true" : null,
        "data-tip": blocked,
        "aria-label": "不登录 OpenAI 也能用",
        onclick: async () => {
          if (busy) return;
          if (blocked) return toast(blocked);
          if (!status.enabled) return enableDialog(status.models);
          busy = true;
          const r = await call("relay.noAccountDisable").catch((error) => {
            failed(error);
            return null;
          });
          busy = false;
          changed();
          if (r && r.ok) await applyToCodex("window", "已恢复原来的 Codex 设置");
          else if (r) toast("没能恢复原来的设置");
        },
      });
      put(
        section,
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "who" },
            h("b", null, "不登录 OpenAI 也能用"),
            h(
              "span",
              { "data-brief": status.enabled ? null : "Codex 直接用中转站的 GPT 模型" },
              status.enabled
                ? `已开启 · 默认模型 ${status.model || ""}`
                : "没有 OpenAI 账号时，Codex 直接用中转站的 GPT 模型",
            ),
          ),
          h("span", { class: "spacer" }),
          toggle,
        ),
        compact
          ? null
          : status.enabled
            ? h(
                "p",
                { class: "sub" },
                "请保持 Hub 在托盘里运行。关掉开关会恢复原来的设置，并自动应用到 Codex。",
              )
            : h(
                "p",
                { class: "sub" },
                blocked || "打开前会先列出要改的设置，改之前自动备份；开关后自动应用到 Codex。",
              ),
      );
    }
    window.addEventListener(CHANGED, load);
    load();
    return { reload: load };
  }

  return { mount };
};
