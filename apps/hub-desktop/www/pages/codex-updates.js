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
    CODEX_REOPEN_FAILED: "重新打开 Codex 没成功，Hub 正在每分钟重试一次。",
    CODEX_HEALTH_FAILED:
      "Codex 已更新，但更新后的检查没通过。如果用起来有问题，可以在 维护 → 系统诊断 里看看。",
    CODEX_STATE_FAILED: "Hub 没能保存更新记录，稍后会再试。",
    CODEX_STORE_FAILED: "没能改微软商店的“应用更新”开关，稍后会自动再试。",
    CODEX_STORE_UPDATE_FAILED:
      "微软商店这次没有给 Codex 更新（用 winget 也没成功）。点“去微软商店更新”自己更新一下就好，Hub 过几个小时也会再试。",
    CODEX_STORE_UPDATE_TIMEOUT:
      "更新已经开始，但等了二十多分钟版本还是没变。点“去微软商店更新”看看进度，Hub 过几个小时也会再试。",
  };

  const v = (version) => (version ? `v${version}` : "未知");
  // Windows reports 26.1117.3838.0 for the build listed as 26.1117.3838.
  const bare = (version) => String(version || "").replace(/^(\d+\.\d+\.\d+)\.0$/u, "$1");
  const sameVersion = (a, b) => Boolean(a && b) && bare(a) === bare(b);
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

  /**
   * Windows: the Hub turns the Store's switch off while the Store offers an unverified build, and
   * itself updates Codex (only Codex) to a verified offer while Codex is idle.
   */
  function describeStore(s) {
    const latest = v(s.latestVersion);
    const target = v(s.verifiedUpdate || s.latestVersion);
    if (s.store.mode === "canary") return ["off", "这台是试验机，Codex 跟着微软商店随时更新"];
    if (s.phase === "waiting-idle")
      return s.requested
        ? ["wait", `等 Codex 手上的任务做完，就关掉它更新到 ${target}`]
        : ["wait", `${target} 已适配，等 Codex 没有任务、你也离开电脑 5 分钟后自动更新`];
    if (s.phase === "installing")
      return [
        "wait",
        s.updateRoute === "winget"
          ? `微软商店没接手，正在用 winget 更新到 ${target}，好了会自动重新打开 Codex`
          : `正在通过微软商店更新到 ${target}，好了会自动重新打开 Codex`,
      ];
    if (s.phase === "manual-update")
      return ["hold", `Hub 没能自动更新到 ${target}，需要你手动更新一下`];
    if (s.phase === "disabled" && s.verifiedUpdate)
      return ["hold", `已适配的 ${target} 可以装了；你关了管理，Hub 不会自动更新`];
    if (s.phase === "waiting-compatibility" && s.store.mode === "user-off")
      return [
        "off",
        `商店出了新版 ${latest}，Hub 正在适配；商店自动更新本来就是关着的，Hub 没动它`,
      ];
    if (s.phase === "waiting-compatibility" && s.store.mode === "user-on")
      return [
        "hold",
        `商店出了新版 ${latest}，Hub 还在适配；你打开了商店自动更新，Hub 不再暂停，装上后部分增强会先停用`,
      ];
    if (s.phase === "waiting-compatibility")
      return ["hold", `商店出了新版 ${latest}，Hub 正在适配，已先暂停微软商店所有应用的自动更新`];
    if (s.phase === "up-to-date" && s.verifiedUpdate)
      return ["ok", `新版 ${target} 已适配，Hub 会在 Codex 空闲时更新`];
    return null;
  }

  /** One line in plain words for each phase, plus the tone of the status dot. */
  function describe(s) {
    const latest = v(s.latestVersion);
    const store = s.store && s.phase !== "failed" ? describeStore(s) : null;
    if (store) return store;
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
      // The user chose "跳过这个版本" in Codex's own window: kept as their choice, not a failure.
      case "user-skipped":
        // The skip may be the Hub's own unconfirmed write: do not say the user chose it.
        if (s.skipOwnershipUnconfirmed)
          return ["hold", "Codex 的跳过设置来源尚未确认，Hub 暂缓更新"];
        return [
          "off",
          `你已跳过 Codex ${v(s.userSkippedVersion || s.latestVersion)}，Hub 会保留这个选择，Codex 照常可用`,
        ];
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

    /** "现在更新" (Windows): Codex is closed for the update, so say so before starting. */
    function confirmUpdateNow(s) {
      const ui = window.HubUI.dialog({ title: `现在更新到 ${v(s.verifiedUpdate)}？` });
      ui.body.append(
        h(
          "p",
          { class: "sub", "data-keep": "" },
          "Hub 会等 Codex 手上的任务做完，然后关掉 Codex，通过微软商店更新，装好后自动重新打开，期间 Codex 会关掉几分钟。",
        ),
      );
      ui.foot.append(
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => ui.close() }, "先不更新"),
        h(
          "button",
          {
            class: "btn paper",
            type: "button",
            onclick: () => {
              ui.close();
              if (busy) return;
              busy = true;
              call("codex.updates.updateNow")
                .then(render, failed)
                .finally(() => {
                  busy = false;
                });
            },
          },
          "现在更新",
        ),
      );
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
      const prefsFailing = s.phase !== "failed" && s.error === "CODEX_PREFERENCES_FAILED";
      const [tone, line] = s.reopening
        ? ["wait", "正在重新打开 Codex…"]
        : prefsFailing
          ? ["hold", "读取 Codex 更新设置失败，Hub 稍后自动重试"]
          : describe(s);
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
        // Settings reads keep failing: the main line carries the error, keep the phase visible here.
        prefsFailing ? [describe(s)[1], false] : null,
        (s.phase === "failed" || s.phase === "manual-update") && s.error
          ? [
              s.error === "CODEX_REOPEN_FAILED" && s.reopenGivenUp
                ? "Hub 试了半小时也没能重新打开 Codex，已停止自动重试，请手动打开 Codex。"
                : ERRORS[s.error] || "原因未知，稍后会自动再试。",
              true,
            ]
          : null,
        // A failed check does not undo a pause: say so, the main line only shows the failure.
        s.phase === "failed" && s.store && s.store.mode === "holding"
          ? ["微软商店的应用自动更新仍暂停中，检查恢复正常后 Hub 会自动处理。", true]
          : null,
        compatNote(s.compatibility) ? [compatNote(s.compatibility), false] : null,
        s.renderer && s.renderer.mode !== "full"
          ? [
              s.store && s.verifiedUpdate
                ? `现在这版 Codex 还没适配，部分增强已暂停；Codex 和中转照常能用，更新到 ${v(s.verifiedUpdate)} 后自动恢复。`
                : "现在这版 Codex 还没适配，部分增强已暂停；Codex 和中转照常能用，适配好后自动恢复。",
              true,
            ]
          : null,
        !mac ? ["装上还没适配的版本时，Hub 会自动暂停部分增强，Codex 照常能用。", false] : null,
      ].filter(Boolean);
      // Windows: a verified build the Hub can bring Codex to. "现在更新" while nothing runs yet (or
      // only the automatic wait for five idle minutes); the Store page always works by hand.
      const offerManual =
        Boolean(s.store && s.verifiedUpdate) &&
        (s.phase === "manual-update" ||
          s.phase === "disabled" ||
          s.phase === "failed" ||
          (s.phase === "waiting-idle" && !s.requested));
      const actions = [
        offerManual
          ? h(
              "button",
              { class: "btn paper", type: "button", onclick: () => confirmUpdateNow(s) },
              "现在更新",
            )
          : null,
        offerManual
          ? button("去微软商店更新", () =>
              call("links.open", { target: "codexStore" }).catch(failed),
            )
          : null,
        button(s.phase === "failed" ? "重试" : "立即检查", () =>
          call("codex.updates.check").then(render, failed),
        ),
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
            h(
              "span",
              null,
              s.store
                ? "商店出了没适配的 Codex 新版时先暂停商店自动更新；适配好后在 Codex 空闲时把它更新上去"
                : mac
                  ? "新版 Codex 先等 Hub 适配好，再自动更新"
                  : unsupported(s)[1],
            ),
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
          `本机 ${v(s.currentVersion)}${s.latestVersion && (s.store ? !sameVersion(s.latestVersion, s.currentVersion) : s.phase !== "up-to-date") ? ` · 最新 ${v(s.latestVersion)}` : ""}`,
        ),
        ...notes.map(([text, keep]) =>
          h("p", { class: "sub cu-note", "data-keep": keep || null }, text),
        ),
        h("div", { class: "row" }, ...actions),
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
    // The notice describes the Mac flow (Codex restarts by itself); Windows only pauses the Store.
    if (!s || !s.noticePending || !s.enabled || s.supported === false || s.store) return;
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
