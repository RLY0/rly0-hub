"use strict";
// "免登录用中转": one switch shown on 首页, 账号 → OpenAI · Codex and 中转站. The service
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
      title: "免登录用中转",
      sub: "会修改 Codex 的设置",
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
            "开启后 Codex 只用中转模型，官方模型暂时不可用。",
          ),
          h("li", null, "Hub 需要一直在托盘里运行。"),
          h(
            "li",
            { "data-brief": "会自动让 Codex 重新打开一次，对话记录都在" },
            "Codex 会重新打开一次。",
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
      await applyToCodex("window", "已开启免登录用中转");
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
          h("b", null, "免登录用中转"),
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
        "aria-label": "免登录用中转",
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
          // 首页: the switch leads, right beside its label, instead of across a wide card.
          compact ? toggle : null,
          h(
            "div",
            { class: "who" },
            h("b", null, "免登录用中转"),
            h(
              "span",
              { "data-brief": status.enabled ? null : "Codex 直接用中转的 GPT" },
              status.enabled ? `已开启 · 默认模型 ${status.model || ""}` : "Codex 直接用中转的 GPT",
            ),
          ),
          compact ? null : h("span", { class: "spacer" }),
          compact ? null : toggle,
        ),
        compact
          ? null
          : status.enabled
            ? h("p", { class: "sub" }, "保持 Hub 在托盘里运行")
            : h("p", { class: "sub" }, blocked || null),
      );
    }
    window.addEventListener(CHANGED, load);
    load();
    return { reload: load };
  }

  return { mount };
};
