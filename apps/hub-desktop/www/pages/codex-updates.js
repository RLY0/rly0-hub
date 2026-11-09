"use strict";
// 设置 → 更新 → "Codex 更新": whether the Hub holds Codex's own updates until a version is adapted,
// and where that hold stands. State comes from codex.updates.* (contract
// .pm/selfheal/CODEX-VERSION-GATE-CONTRACT.md); this file only shows it and sends the user's choice.
(() => {
  // Phases that move on their own; the card re-reads status while it shows one.
  const MOVING = new Set(["checking", "downloading", "waiting-idle", "installing", "health-check"]);

  const ERRORS = {
    CODEX_PREFERENCES_FAILED: "没能改 Codex 的更新设置，Mac 可能拦下了这次修改。",
    CODEX_APPCAST_FAILED: "查不到 Codex 的最新版本，可能是网络问题，稍后会自动再查。",
    CODEX_VERSION_UNAVAILABLE: "读不到本机 Codex 的版本，确认 Codex 已安装。",
    CODEX_UPDATE_CHECK_FAILED: "这次没能准备好更新，稍后会自动再试。",
    CODEX_DOWNLOAD_TIMEOUT: "新版下载太久没完成，这次先停下，稍后会再试。",
    CODEX_INSTALL_TIMEOUT:
      "这次更新没完成（Codex 没有退出，或退出后迟迟没装完），稍后会再试。如果 Codex 没有自己打开，请手动打开它。",
    CODEX_UPDATE_TARGET_CHANGED: "OpenAI 刚又换了一个新版，这个版本还没适配，先不更新。",
    CODEX_REOPEN_FAILED: "Hub 多次尝试也没能重新打开 Codex，已停止重试，请手动打开 Codex。",
    CODEX_HEALTH_FAILED:
      "Codex 已更新，但更新后的检查没通过。如果用起来有问题，可以在 维护 → 系统诊断 里看看。",
    CODEX_STATE_FAILED: "Hub 没能保存更新记录，稍后会再试。",
  };

  const v = (version) => (version ? `v${version}` : "未知");
  const isMac = () => Boolean(window.HubUI && window.HubUI.isMac);
  /**
   * Why the Hub does not manage Codex updates here (supported=false): [status line, switch note].
   * `unsupportedReason` is optional; without it, the platform decides.
   */
  function unsupported(s) {
    const reason = s.unsupportedReason || (isMac() ? "control-disabled" : "platform");
    if (reason === "environment")
      return [
        "Hub 的数据位置改过，这台电脑上暂不管理 Codex 更新",
        "数据放在默认位置的 Hub 才会管理",
      ];
    if (reason === "control-disabled")
      return ["测试版 Hub 不管理 Codex 更新", "只有正式安装的 Hub 才会管理"];
    return ["这台电脑上 Hub 拦不住 Codex 更新", "Windows 版 Codex 由微软商店负责更新"];
  }

  /** One line in plain words for each phase, plus the tone of the status dot. */
  function describe(s) {
    const latest = v(s.latestVersion);
    switch (s.phase) {
      case "checking":
        return ["wait", "正在检查…"];
      case "disabled":
        return ["off", "已交给 Codex 自己更新"];
      case "unsupported":
        return ["off", unsupported(s)[0]];
      case "up-to-date":
        return ["ok", "已是适配好的最新版"];
      case "waiting-compatibility":
        return ["hold", `Codex 出了新版 ${latest}，Hub 正在适配，适配好就自动更新`];
      case "downloading":
        return ["wait", `${latest} 已适配，Codex 正在后台下载`];
      case "waiting-idle":
        return ["wait", `${latest} 已适配，等你离开电脑 5 分钟后开始更新`];
      case "installing":
        return ["wait", "正在更新，Codex 会自动重新打开"];
      case "health-check":
        return ["wait", "已更新，正在检查是否正常"];
      case "failed":
        return ["bad", "这次更新没成功"];
      default:
        return ["off", "状态未知"];
    }
  }

  function compatNote(c) {
    if (!c || !c.error) return null;
    if (c.error === "COMPAT_UNAVAILABLE")
      return c.source === "cache"
        ? "暂时连不上适配名单，先按上次拿到的名单判断。"
        : "暂时连不上适配名单，先按 Hub 自带的名单判断。";
    if (c.error === "COMPAT_INVALID") return "线上适配名单读不懂，先按之前的名单判断。";
    return null;
  }

  window.renderCodexUpdates = ({ h, call, failed, button, alive }) => {
    const card = h("section", { class: "m codex-updates", "aria-live": "polite" });
    let timer = null;
    let busy = false;

    const schedule = (status) => {
      clearTimeout(timer);
      if (alive() && status && MOVING.has(status.phase)) timer = setTimeout(load, 3000);
    };

    function setEnabled(enabled) {
      if (busy) return;
      busy = true;
      call("codex.updates.setEnabled", { enabled })
        .then(render, failed)
        .finally(() => {
          busy = false;
        });
    }

    function confirmOff() {
      const ui = window.HubUI.dialog({ title: "让 Codex 自己更新？" });
      ui.body.append(
        h(
          "p",
          { class: "sub", "data-keep": "" },
          "关掉后 Codex 会照常自动更新，可能装上 Hub 还没适配的版本。到时 Codex 照常能用，部分增强会暂停，等适配好再恢复。",
        ),
      );
      ui.foot.append(
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => ui.close() }, "保持由 Hub 管理"),
        h(
          "button",
          {
            class: "btn paper",
            type: "button",
            onclick: () => {
              ui.close();
              setEnabled(false);
            },
          },
          "关掉",
        ),
      );
    }

    function render(s) {
      if (!alive()) return;
      if (!s) {
        card.replaceChildren(
          h("h2", null, "Codex 更新"),
          h("p", { class: "sub" }, "暂时读不到 Codex 更新状态，Hub 后台可能还在启动。"),
          h(
            "div",
            { class: "row" },
            button("重新读取", () => load()),
          ),
        );
        return;
      }
      const [tone, line] = s.reopening ? ["wait", "正在重新打开 Codex…"] : describe(s);
      const mac = s.supported !== false;
      const sw = h("button", {
        class: "switch",
        type: "button",
        role: "switch",
        "aria-checked": String(Boolean(s.enabled) && mac),
        "aria-label": "由 Hub 管理 Codex 更新",
        disabled: !mac || busy,
        onclick: () => (s.enabled ? confirmOff() : setEnabled(true)),
      });
      // [text, keep]: failures and the degraded-mode note are warnings, shown whole rather than
      // shortened behind an ⓘ.
      const notes = [
        s.phase === "failed" && s.error
          ? [ERRORS[s.error] || "原因未知，稍后会自动再试。", true]
          : null,
        compatNote(s.compatibility) ? [compatNote(s.compatibility), false] : null,
        s.renderer && s.renderer.mode !== "full"
          ? [
              "现在这版 Codex 还没适配，部分增强已暂停；Codex 和中转照常能用，适配好后自动恢复。",
              true,
            ]
          : null,
        !mac ? ["装上还没适配的版本时，Hub 会自动暂停部分增强，Codex 照常能用。", false] : null,
      ].filter(Boolean);
      card.replaceChildren(
        h("h2", null, "Codex 更新"),
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "who" },
            h("b", null, "由 Hub 管理 Codex 更新"),
            h("span", null, mac ? "新版 Codex 先等 Hub 适配好，再自动更新" : unsupported(s)[1]),
          ),
          sw,
        ),
        h(
          "div",
          { class: `cu-status ${tone}` },
          h("i", { class: "cu-dot", "aria-hidden": "true" }),
          h("b", null, line),
        ),
        h(
          "p",
          { class: "sub" },
          `本机 ${v(s.currentVersion)}${s.latestVersion && s.phase !== "up-to-date" ? ` · 最新 ${v(s.latestVersion)}` : ""}`,
        ),
        ...notes.map(([text, keep]) =>
          h("p", { class: "sub cu-note", "data-keep": keep || null }, text),
        ),
        h(
          "div",
          { class: "row" },
          button(s.phase === "failed" ? "重试" : "立即检查", () =>
            call("codex.updates.check").then(render, failed),
          ),
        ),
      );
      schedule(s);
    }

    function load() {
      return call("codex.updates.status")
        .catch(() => null)
        .then(render);
    }
    load();
    return card;
  };

  /**
   * Once, after the Hub first takes over Codex updates (Mac only): say so in one dialog. Either
   * button marks the notice read; the switch itself stays as it is.
   */
  window.showCodexUpdatesNotice = async ({ h, call, go }) => {
    const s = await call("codex.updates.status").catch(() => null);
    if (!s || !s.noticePending || !s.enabled || s.supported === false) return;
    // However the dialog closes (a button, Esc, ×), the notice counts as read.
    const ui = window.HubUI.dialog({
      title: "Hub 会帮你管 Codex 更新",
      onClose: () => void call("codex.updates.acknowledgeNotice").catch(() => undefined),
    });
    ui.body.append(
      h(
        "p",
        { class: "sub", "data-keep": "" },
        "Codex 出新版后，Hub 先适配好再让它更新，避免装上就用不了。适配好后，会在 Codex 没有任务、你也离开电脑 5 分钟时自动更新，期间 Codex 会自动重启。",
      ),
      h("p", { class: "sub", "data-keep": "" }, "不想要的话，可以在 设置 → 更新 里关掉。"),
    );
    ui.foot.append(
      h(
        "button",
        {
          class: "btn quiet",
          type: "button",
          onclick: () => {
            ui.close();
            go("updates");
          },
        },
        "去设置",
      ),
      h("span", { class: "spacer" }),
      h("button", { class: "btn paper", type: "button", onclick: () => ui.close() }, "知道了"),
    );
  };
})();
