"use strict";
// AI 助手 → 自动更新命令行工具: the default-on switch, and one line per agent card saying which
// version runs and what the last automatic update did. State comes from agents.cliUpdates.*
// (contract .pm/selfheal/AGENT-CLI-AUTOUPDATE-CONTRACT.md); this file only shows it and sends the
// switch and "check now". It never names a command, a package or a version to install.
(() => {
  const ERRORS = {
    CHECK_FAILED: "查不到新版本，稍后会再试",
    INSTALL_FAILED: "新版没装上",
    VERSION_MISMATCH: "装完的版本对不上",
    CONNECTION_NOT_READY: "新版跟 Hub 对接不上",
    ROLLBACK_FAILED: "退回旧版也没成功",
    HOST_UNAVAILABLE: "Codex 没开着，打开 Codex 后才会检查",
    BUSY: "它正在干活，空闲后再更新",
    BAD_VERSION: "这个版本之前出过问题，已跳过",
    NOT_INSTALLED: "没有安装",
    ORIGINAL_INSTALLER: "不是 Hub 能更新的安装方式，请用原来的方式更新",
    NO_OFFICIAL_UPDATER: "这个工具没有官方的更新方式",
    ROLLBACK_UNSUPPORTED: "出问题时没法退回旧版，为安全不自动更新",
    STATE_INVALID: "更新记录读不出来",
    STATE_WRITE_FAILED: "更新记录没能保存",
    INTERRUPTED: "上次更新被打断，已处理",
    DISABLED: "自动更新已关闭",
    PERMISSION_DENIED: "没有权限改它的安装位置",
  };
  // What went wrong with a new version that was rolled back, said after "新版 vX".
  const CAUSES = {
    CONNECTION_NOT_READY: "跟 Hub 对接不上",
    VERSION_MISMATCH: "装完版本对不上",
    INSTALL_FAILED: "没装好",
    INTERRUPTED: "更新被打断",
  };
  const v = (version) => (version ? `v${version}` : "");
  const why = (code) => ERRORS[code] || "原因未知";
  const ago = (ms) => {
    if (!ms) return "";
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
  };

  /** [tone, text, keep]: tone ok | wait | warn | off; keep = a warning shown whole, never shortened. */
  function describe(entry, enabled) {
    const cur = v(entry.currentVersion);
    const latest = v(entry.latestVersion);
    const bad = v(entry.badVersions && entry.badVersions[entry.badVersions.length - 1]);
    switch (entry.phase) {
      case "checking":
        return ["wait", "正在检查新版本…"];
      case "updating":
        return ["wait", `正在更新到 ${latest}…`];
      case "verifying":
        return ["wait", "已装上新版，正在检查还能不能用…"];
      case "rolling-back":
        return ["wait", "新版有问题，正在退回旧版…"];
      default:
        break;
    }
    switch (entry.result) {
      case "updated":
        return ["ok", `${cur} · ${ago(entry.lastUpdatedAt) || "刚刚"}自动更新过`];
      case "rolled-back":
        return [
          "warn",
          `新版 ${bad} ${CAUSES[entry.causeCode] || "有问题"}，已退回 ${cur}，不再装这个版本`,
          true,
        ];
      case "failed":
        return entry.errorCode === "ROLLBACK_FAILED"
          ? ["warn", "新版有问题，退回旧版也没成功，请在下面重新安装一次", true]
          : ["warn", `${cur ? `${cur} · ` : ""}自动更新没成功：${why(entry.errorCode)}`, true];
      case "up-to-date":
        return ["ok", `${cur} · 已是最新`];
      case "skipped-busy":
        return ["wait", `${cur} · 有新版 ${latest}，等它空闲后更新`];
      case "skipped-bad-version":
        return ["off", `${cur} · 新版 ${latest} 之前出过问题，已跳过`];
      case "skipped-unsupported":
        return ["off", `${cur ? `${cur} · ` : ""}不自动更新：${why(entry.errorCode)}`];
      case "skipped-not-installed":
        return null;
      default:
        break;
    }
    if (!entry.canUpdate && entry.installKind !== "unknown")
      return [
        "off",
        `${cur ? `${cur} · ` : ""}不自动更新：${why(entry.errorCode || "ORIGINAL_INSTALLER")}`,
      ];
    if (!enabled) return ["off", cur ? `${cur} · 自动更新已关闭` : "自动更新已关闭"];
    return cur ? ["off", cur] : null;
  }

  window.AgentCliUpdates = ({ h, call, failed, alive, onChange }) => {
    let status = null;
    let timer = null;
    const card = h("section", { class: "m span-6 cli-updates", "aria-live": "polite" });

    const schedule = () => {
      clearTimeout(timer);
      const moving =
        status &&
        (status.checking || status.agents.some((entry) => entry.phase && entry.phase !== "idle"));
      if (alive() && moving) timer = setTimeout(load, 3000);
    };
    const set = (next) => {
      if (!alive()) return;
      if (next) status = next;
      render();
      onChange();
      schedule();
    };
    function load() {
      return call("agents.cliUpdates.status")
        .catch(() => null)
        .then(set);
    }

    function render() {
      if (!status) {
        card.replaceChildren(
          h(
            "div",
            { class: "row" },
            h(
              "div",
              { class: "who" },
              h("b", null, "自动更新命令行工具"),
              h("span", null, "暂时读不到更新状态，Hub 后台可能还在启动"),
            ),
          ),
        );
        return;
      }
      const sw = h("button", {
        class: "switch",
        type: "button",
        role: "switch",
        "aria-checked": String(Boolean(status.enabled)),
        "aria-label": "自动更新命令行工具",
        onclick: () =>
          call("agents.cliUpdates.setEnabled", { enabled: !status.enabled }).then(set, failed),
      });
      const checked = status.agents
        .map((entry) => entry.lastCheckedAt || 0)
        .reduce((a, b) => Math.max(a, b), 0);
      const now = h(
        "button",
        {
          class: "btn sm",
          type: "button",
          disabled: !status.enabled || status.checking,
          onclick: () => call("agents.cliUpdates.check", {}).then(set, failed),
        },
        status.checking ? "检查中…" : "立即检查",
      );
      // replaceChildren would print a null child as the text "null".
      const parts = [
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "who" },
            h("b", null, "自动更新命令行工具"),
            h(
              "span",
              null,
              status.enabled
                ? `每天检查，空闲时更新${checked ? ` · 上次 ${ago(checked)}` : ""}`
                : "已关闭，各工具保持现有版本",
            ),
          ),
          now,
          sw,
        ),
        status.enabled
          ? h(
              "p",
              { class: "sub" },
              window.HubUI.info(
                "更新后不能用会自动退回旧版",
                "每次更新后马上检查这个工具还能不能和 Hub 对接，不能就自动退回旧版，并且不再装那个版本。Claude Code 会自己更新，Codex 在 设置 → 更新 里管，都不在这里。",
              ),
            )
          : null,
      ];
      card.replaceChildren(...parts.filter(Boolean));
    }

    /** The per-card line, or null when there is nothing to say for this agent. */
    function line(agentId) {
      const entry = status && status.agents.find((item) => item.agent === agentId);
      if (!entry) return null;
      const said = describe(entry, status.enabled);
      if (!said) return null;
      const [tone, text, keep] = said;
      return h(
        "div",
        { class: `cli-line ${tone}` },
        h("i", { class: "cli-dot", "aria-hidden": "true" }),
        h("span", { "data-keep": keep ? "" : null }, text),
      );
    }

    load();
    return { card, line };
  };
})();
