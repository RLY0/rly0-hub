"use strict";
// 设置 → 通用 → "Codex 里": the options the former in-Codex 通用 page had that change how Codex
// itself behaves. The Hub service saves them (prefs.codexSet); Codex picks them up the next time
// its window gets focus (renderer-codex-preferences.ts), with no restart.
window.renderCodexPreferences = ({ h, call, toast, failed, alive }) => {
  const card = h("section", { class: "m span-6 codex-prefs" });
  const DEFAULTS = {
    reasoningSoftWrap: false,
    accentColor: "signal",
    quotaRefresh: "1m",
    quotaAlert: { enabled: false, thresholdPercent: 10 },
    idleRelease: { enabled: false, timeoutMinutes: 30 },
  };
  const info = (short, full) => window.HubUI.info(short, full);

  function save(values) {
    return call("prefs.codexSet", values).then(
      () => toast("已保存，回到 Codex 窗口就生效"),
      failed,
    );
  }
  const select = (label, value, options, onChange) => {
    const element = h(
      "select",
      { class: "input compact-select", "aria-label": label },
      options.map(([v, text]) => h("option", { value: String(v), selected: v === value }, text)),
    );
    element.addEventListener("change", () => onChange(element.value));
    return element;
  };
  const toggle = (label, on, onChange) => {
    const button = h("button", {
      class: "switch",
      type: "button",
      role: "switch",
      "aria-checked": String(on),
      "aria-label": label,
      onclick: () => {
        const next = button.getAttribute("aria-checked") !== "true";
        button.setAttribute("aria-checked", String(next));
        onChange(next);
      },
    });
    return button;
  };
  const row = (title, brief, full, control) =>
    h(
      "div",
      { class: "pref-row" },
      h("div", { class: "who" }, h("b", null, title), info(brief, full)),
      control,
    );

  function draw(saved) {
    const p = { ...DEFAULTS, ...(saved || {}) };
    card.replaceChildren(
      h("h3", null, "Codex 里"),
      row(
        "推理换行",
        "长推理自动换行",
        "推理过程自动换行",
        toggle("推理换行", p.reasoningSoftWrap, (on) => save({ reasoningSoftWrap: on })),
      ),
      row(
        "强调色",
        "Codex 里 RLY/0 控件的颜色",
        "RLY/0 控件在 Codex 里的颜色",
        select(
          "强调色",
          p.accentColor,
          [
            ["signal", "信号橙"],
            ["blue", "蓝"],
            ["purple", "紫"],
            ["green", "绿"],
            ["orange", "橙"],
            ["rose", "玫红"],
          ],
          (value) => save({ accentColor: value }),
        ),
      ),
      row(
        "额度刷新",
        "输入框上的额度多久刷新",
        "越短越及时，请求也越多",
        select(
          "额度刷新",
          p.quotaRefresh,
          [
            ["30s", "30 秒"],
            ["1m", "1 分钟"],
            ["3m", "3 分钟"],
            ["5m", "5 分钟"],
          ],
          (value) => save({ quotaRefresh: value }),
        ),
      ),
      row(
        "Codex 里的低额度提醒",
        "剩余额度低时在 Codex 里提示",
        "低于这个比例时在 Codex 里提醒一次",
        h(
          "div",
          { class: "row" },
          select(
            "提醒阈值",
            p.quotaAlert.thresholdPercent,
            [5, 10, 15, 20, 30].map((v) => [v, `剩 ${v}%`]),
            (value) =>
              save({
                quotaAlert: { enabled: p.quotaAlert.enabled, thresholdPercent: Number(value) },
              }).then(() => {
                p.quotaAlert = { ...p.quotaAlert, thresholdPercent: Number(value) };
              }),
          ),
          toggle("Codex 里的低额度提醒", p.quotaAlert.enabled, (on) => {
            p.quotaAlert = { ...p.quotaAlert, enabled: on };
            save({ quotaAlert: p.quotaAlert });
          }),
        ),
      ),
      row(
        "空闲释放",
        "闲置的助手进程自动退出",
        "闲置后结束后台进程，再发消息时自动恢复",
        h(
          "div",
          { class: "row" },
          select(
            "闲置多久",
            p.idleRelease.timeoutMinutes,
            [10, 30, 60, 120, 240].map((v) => [v, v < 60 ? `${v} 分钟` : `${v / 60} 小时`]),
            (value) => {
              p.idleRelease = { ...p.idleRelease, timeoutMinutes: Number(value) };
              save({ idleRelease: p.idleRelease });
            },
          ),
          toggle("空闲释放", p.idleRelease.enabled, (on) => {
            p.idleRelease = { ...p.idleRelease, enabled: on };
            save({ idleRelease: p.idleRelease });
          }),
        ),
      ),
    );
  }

  draw(null);
  call("prefs.codexGet")
    .then((result) => {
      if (alive()) draw(result && result.preferences);
    })
    .catch(() => undefined);
  return card;
};
