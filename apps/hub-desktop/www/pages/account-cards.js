"use strict";
// 账号 page building blocks shared by every provider tab (OpenAI · Codex, Anthropic · Claude,
// Google · Gemini, xAI · Grok): the head row, the auto-switch card, account cards with their
// quota tiles, the official-key card and the quota refresh control. A tab passes what its
// backend can do; what it cannot do is shown disabled with the reason, never as a working button.
window.registerHubAccountCards = ({
  h,
  call,
  toast,
  failed,
  explain,
  countdown,
  resetText,
  resetCardTile,
}) => {
  const put = (element, ...items) =>
    element.replaceChildren(
      ...items
        .flat(Infinity)
        .filter((item) => item !== null && item !== undefined && item !== false),
    );
  const icon = (markup, viewBox = "0 0 24 24") => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("viewBox", viewBox);
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = markup; // fixed markup only, never service data
    return node;
  };
  const clock = (ms) =>
    new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  // A control that cannot act: still focusable so its reason shows as a hint.
  const unavailable = (button, reason) => {
    button.setAttribute("aria-disabled", "true");
    button.setAttribute("data-tip", reason);
    button.classList.add("off");
    return button;
  };

  const USAGE_ERRORS = {
    USAGE_TOKEN_EXPIRED: "登录已过期",
    USAGE_BLOCKED: "官方拒绝了这次查询",
    USAGE_NETWORK: "暂时连不上官方接口",
    USAGE_BAD_RESPONSE: "官方返回的额度看不懂",
    USAGE_RATE_LIMITED: "官方暂时限制查询，稍后点刷新",
    ACCOUNT_TOKEN_MISSING: "这个账号没有可查询的登录",
    // Claude accounts (rly0-core renews a saved, non-current account's token itself).
    CLAUDE_LIVE_EXPIRED: "登录需要续期：用一次 Claude Code 后再刷新",
    CLAUDE_SAVED_EXPIRED: "登录已过期，切换一次即可更新额度",
    // Grok accounts (the Grok CLI renews tokens; the Hub never does).
    GROK_LIVE_EXPIRED: "登录需要续期：用一次 Grok 后再刷新",
    GROK_SAVED_EXPIRED: "登录已过期，切换一次即可更新额度",
    ACCOUNT_REFRESH_REJECTED: "这个账号的登录已失效（可能在别处退出了），请重新添加",
    ACCOUNT_REFRESH_MISMATCH: "官方返回的不是这个账号，已停止续期",
    ACCOUNT_BUSY: "这个账号正在续期，稍后再刷新",
    RLY0_CORE_UNAVAILABLE: "后台服务还没准备好",
    TIMEOUT: "查询超时",
  };
  const usageError = (code) => USAGE_ERRORS[code] || explain(code);
  // A window's own label (Antigravity names its model groups) or its kind's.
  const KIND_LABELS = {
    primary: "5 小时额度",
    secondary: "每周额度",
    weekly: "每周额度",
    monthly: "每月额度",
    credits: "额度",
  };
  const windowLabel = (w) => w.label || KIND_LABELS[w.kind] || "额度";

  /* ---------- Quota tiles ---------- */
  // Known usage: one tile per window. Otherwise the same two tiles marked 未知 / 不支持 with the
  // reason; an unknown number is never shown as 0. `stale` keeps the old numbers after a failed
  // refresh and says so. `updated` adds when the numbers were read (usage.fetchedAt, seconds) for
  // a card whose quota is refreshed on its own rather than with the page's accounts.
  // `kinds`: the placeholder tiles when nothing is known (the 5-hour and weekly ones by default).
  function quotaCards(
    usage,
    { value = "未知", reason, stale, updated, kinds = ["5 小时额度", "每周额度"] } = {},
  ) {
    const known = Boolean(usage && usage.windows && usage.windows.length);
    const staleNote = stale
      ? h(
          "p",
          { class: "warn-text quota-note" },
          known
            ? `刷新失败：${usageError(stale)}，显示的是上次读到的额度`
            : `读取失败：${usageError(stale)}`,
        )
      : null;
    if (known)
      return h(
        "div",
        { class: "quota-block" },
        h(
          "div",
          { class: "reset-cards" },
          usage.windows.map((w) => {
            const left = Math.max(0, Math.round(100 - w.usedPercent));
            return h(
              "div",
              { class: `reset-card ${left <= 15 ? "low" : ""}` },
              h(
                "div",
                { class: "row" },
                h("span", { class: "reset-kind" }, windowLabel(w)),
                h("span", { class: "spacer" }),
                h("b", { class: "tabular" }, `剩 ${left}%`),
              ),
              h("div", { class: "bar" }, h("i", { style: { width: `${left}%` } })),
              h(
                "span",
                { class: "reset-when" },
                w.resetsAt ? `${countdown(w.resetsAt)} · ${resetText(w.resetsAt)}` : "重置时间未知",
              ),
            );
          }),
          usage.resetCredits === undefined ? null : resetCardTile(usage.resetCredits),
        ),
        staleNote ||
          (updated && usage.fetchedAt
            ? h("p", { class: "sub quota-note" }, `更新于 ${clock(usage.fetchedAt * 1000)}`)
            : null),
      );
    return h(
      "div",
      { class: "quota-block" },
      h(
        "div",
        { class: "reset-cards unknown" },
        kinds.map((kind) =>
          h(
            "div",
            { class: "reset-card none" },
            h(
              "div",
              { class: "row" },
              h("span", { class: "reset-kind" }, kind),
              h("span", { class: "spacer" }),
              h("b", null, value),
            ),
            h("div", { class: "bar" }),
          ),
        ),
      ),
      staleNote || (reason ? h("p", { class: "sub quota-note" }, reason) : null),
    );
  }

  /* ---------- Account card ---------- */
  // { name, onRename(alias) → Promise, facts[], current, badge, quota, notes[], actions[],
  //   onRemove() → Promise, removedText }
  function accountCard(o) {
    let remove = null;
    if (o.onRemove) {
      let confirmTap = () => true;
      remove = h(
        "button",
        {
          class: "btn quiet sm",
          type: "button",
          onclick: () => {
            if (!confirmTap()) return;
            o.onRemove().then(() => toast(o.removedText || "已删除"), failed);
          },
        },
        "删除",
      );
      confirmTap = window.HubUI.armable(remove, { armedText: "确认删除" });
    }
    const name = o.onRename
      ? h(
          "b",
          {
            class: "renamable",
            title: "点击改名",
            tabindex: "0",
            onclick: (event) => rename(event.currentTarget, o),
            onkeydown: (event) => {
              if (event.key === "Enter") rename(event.currentTarget, o);
            },
          },
          o.name,
        )
      : h("b", null, o.name);
    return h(
      "section",
      { class: `m span-3 account-card ${o.current ? "tone" : ""}` },
      h(
        "div",
        { class: "row" },
        h("span", { class: `dot ${o.current ? "ok" : ""}` }),
        h(
          "div",
          { class: "who" },
          name,
          h("span", null, (o.facts || []).filter(Boolean).join(" · ") || " "),
        ),
        o.current ? h("span", { class: "tag ok" }, "Current") : o.badge || null,
      ),
      o.quota,
      ...(o.notes || []),
      h("div", { class: "row" }, ...(o.actions || []), h("span", { class: "spacer" }), remove),
    );
  }

  function rename(label, o) {
    const input = h("input", {
      class: "input rename-input",
      maxlength: "40",
      value: o.name,
      "aria-label": "账号名称",
    });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const alias = input.value.trim();
      if (!save || !alias || alias === o.name) {
        input.replaceWith(label);
        return;
      }
      o.onRename(alias).then(() => toast("已改名"), failed);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  /* ---------- Head row ---------- */
  // saveCurrent: { onClick } or { reason } when the provider's live login cannot be read.
  // `beta`: a small 测试版 tag after the intro, with why.
  function pageHead({ intro, saveCurrent, addItems, refresh, beta }) {
    const save = h("button", { class: "btn quiet", type: "button" }, "保存当前登录");
    if (saveCurrent.reason) unavailable(save, saveCurrent.reason);
    else save.addEventListener("click", saveCurrent.onClick);
    return h(
      "div",
      { class: "row page-head account-head" },
      h(
        "span",
        { class: "sub" },
        intro,
        beta ? h("span", { class: "tag beta-tag", "data-tip": beta }, "测试版") : null,
      ),
      h(
        "span",
        { class: "head-actions" },
        refresh,
        save,
        window.HubUI.menuButton("+ 添加", addItems, { align: "right" }),
      ),
    );
  }

  /* ---------- Auto switch ---------- */
  // Switch before the current account runs out (AiMaMi's 自动切换). Off by default. Only the
  // Codex accounts have it; other tabs pass `reason` and get the same card, switched off.
  function autoSwitchCard({ alive, reason }) {
    const card = h("section", {
      class: `m tone span-6 auto-switch ${reason ? "unsupported" : ""}`,
    });
    const head = (toggle, sub) =>
      h(
        "div",
        { class: "row" },
        h("div", { class: "who" }, h("b", null, "额度快用完时自动切换账号"), h("span", null, sub)),
        toggle,
      );
    if (reason) {
      const toggle = unavailable(
        h("button", {
          class: "switch",
          type: "button",
          role: "switch",
          "aria-checked": "false",
          "aria-label": "自动切换账号",
        }),
        reason,
      );
      put(card, head(toggle, "暂不支持"), h("p", { class: "sub quota-note" }, reason));
      return card;
    }
    async function load() {
      const settings = await call("accounts.autoSwitchGet").catch(() => null);
      if (!alive() || !settings) return;
      const percentSelect = (value, label) =>
        h(
          "select",
          { class: "input compact-select", "aria-label": label },
          [5, 10, 15, 20, 30].map((n) =>
            h("option", { value: String(n), selected: n === value }, `剩 ${n}%`),
          ),
        );
      const h5 = percentSelect(settings.remain5h, "5 小时阈值");
      const weekly = percentSelect(settings.remainWeekly, "每周阈值");
      const mode = h(
        "select",
        { class: "input compact-select", "aria-label": "切换方式" },
        h("option", { value: "ask", selected: settings.mode === "ask" }, "先提醒我"),
        h("option", { value: "auto", selected: settings.mode === "auto" }, "直接切换并重启 Codex"),
      );
      const save = (enabled) =>
        call("accounts.autoSwitchSet", {
          enabled,
          remain5h: Number(h5.value),
          remainWeekly: Number(weekly.value),
          mode: mode.value,
        }).then((next) => {
          toast(next.enabled ? "自动切换已开启" : "设置已保存");
          load();
        }, failed);
      for (const select of [h5, weekly, mode])
        select.addEventListener("change", () => save(settings.enabled));
      put(
        card,
        head(
          h("button", {
            class: "switch",
            type: "button",
            role: "switch",
            "aria-checked": String(settings.enabled),
            "aria-label": "自动切换账号",
            onclick: () => save(!settings.enabled),
          }),
          "低于阈值时切到额度最多的已保存账号，Codex 会重启",
        ),
        h(
          "div",
          { class: "row auto-switch-fields" },
          h("label", { class: "field" }, h("span", null, "5 小时额度"), h5),
          h("label", { class: "field" }, h("span", null, "每周额度"), weekly),
          h("label", { class: "field" }, h("span", null, "到阈值时"), mode),
        ),
      );
    }
    load();
    return card;
  }

  /* ---------- Quota refresh ---------- */
  // An icon button plus when the numbers were last read. `run()` re-reads quota and resolves to
  // the number of accounts that failed (0 = all fine), or to `{ failed, at }` when the numbers
  // are older than the lookup (a cached read; `at` in ms), or rejects when the whole lookup
  // failed; the old numbers stay either way. One lookup at a time, and a short pause after a
  // manual one. `stamp(at)` records a read that happened outside the control.
  const COOLDOWN_MS = 10_000;
  const REFRESH_ICON =
    '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>';
  function refresher({ alive, run }) {
    const button = h(
      "button",
      { class: "icon-btn refresh-btn", type: "button", "aria-label": "刷新额度" },
      icon(REFRESH_ICON),
    );
    const when = h("small", { class: "refresh-when", "aria-live": "polite" });
    const element = h("span", { class: "refresh" }, button, when);
    let busy = false;
    let coolUntil = 0;
    let coolTimer = null;
    let reason = null;
    let at = 0;
    let note = "";
    const paint = () => {
      const blocked =
        reason ||
        (busy ? "正在刷新额度…" : Date.now() < coolUntil ? "刚刷新过，稍等几秒再刷新" : null);
      button.classList.toggle("off", Boolean(blocked));
      button.classList.toggle("spin", busy);
      button.setAttribute("aria-busy", String(busy));
      if (blocked) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
      button.setAttribute("data-tip", blocked || "刷新额度");
      when.classList.toggle("bad", note === "fail");
      when.textContent = reason
        ? "无法查询额度"
        : busy
          ? "刷新中…"
          : note === "fail"
            ? at
              ? `刷新失败 · 仍是 ${clock(at)} 的额度`
              : "刷新失败"
            : at
              ? `更新于 ${clock(at)}${note ? ` · ${note}` : ""}`
              : "";
    };
    async function start(manual) {
      if (busy || reason) return;
      busy = true;
      paint();
      try {
        const result = await run();
        const failedCount = typeof result === "object" && result ? result.failed : result;
        at = (typeof result === "object" && result && result.at) || Date.now();
        note = failedCount ? `${failedCount} 个账号刷新失败` : "";
      } catch {
        note = "fail";
      }
      busy = false;
      if (!alive()) return;
      if (manual) {
        coolUntil = Date.now() + COOLDOWN_MS;
        clearTimeout(coolTimer);
        coolTimer = setTimeout(paint, COOLDOWN_MS + 50);
        if (note === "fail") toast("刷新失败，显示的还是上次读到的额度");
      }
      paint();
    }
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      start(true);
    });
    paint();
    return {
      element,
      refresh: () => start(false),
      stamp(next) {
        if (busy || !next) return;
        at = next;
        note = "";
        paint();
      },
      // A reason disables the control (nothing on this tab can report quota).
      setReason(next) {
        reason = next || null;
        paint();
      },
      get busy() {
        return busy;
      },
    };
  }

  /* ---------- Official API key card ---------- */
  const VENDORS = {
    openai: {
      title: "OpenAI 官方 API Key",
      placeholder: "sk-…",
      hint: "OpenAI 平台（platform.openai.com）的 Key，按用量计费。",
      use: "Pi、Hermes、OpenCode 等助手可以直接用它",
    },
    anthropic: {
      title: "Anthropic 官方 API Key / 订阅令牌",
      placeholder: "sk-ant-api… 或 sk-ant-oat…",
      hint: "console.anthropic.com 的 Key，或 claude setup-token 生成的订阅令牌。",
      use: "Claude Code、Pi、Hermes 等助手可以直接用它",
    },
    google: {
      title: "Google Gemini 官方 API Key",
      placeholder: "AIza…",
      hint: "Google AI Studio（aistudio.google.com）的 Key。",
      use: "Pi、Hermes、OpenCode 等助手可以直接用它",
    },
    xai: {
      title: "xAI 官方 API Key",
      placeholder: "xai-…",
      hint: "xAI 控制台（console.x.ai）的 Key，按用量计费。",
      use: "Pi、Hermes、OpenCode 等助手可以直接用它",
    },
  };
  const KEY_ERRORS = {
    RELAY_UNAUTHORIZED: "官方不接受这个 Key",
    RELAY_NETWORK: "暂时连不上官方接口",
    USAGE_NETWORK: "暂时连不上官方接口",
  };

  // What the saved key's quota tiles can show. A subscription token (a full login or a
  // `claude setup-token` token) reports the 5-hour and weekly windows; rly0-core reads a
  // setup-token's off a model response, and `usageError` says why that failed. A plain API key
  // has no quota at all. `refreshable` is false only when re-reading cannot help.
  const KEY_USAGE_ERRORS = {
    USAGE_NETWORK: "网络连不上官方，点刷新重试。",
    TIMEOUT: "网络连不上官方，点刷新重试。",
    USAGE_BAD_RESPONSE: "官方返回异常，读不到额度，稍后点刷新重试。",
    USAGE_BLOCKED: "官方返回异常，读不到额度，稍后点刷新重试。",
    USAGE_RATE_LIMITED: "官方暂时限制查询，稍后点刷新。",
    USAGE_TOKEN_EXPIRED: "令牌失效了，请点“换一个”保存新的令牌。",
  };
  function keyQuota(info) {
    if (!info || info.kind !== "subscription")
      return { refreshable: false, reason: "API Key 官方不提供额度查询" };
    // valid === false already gets the card's "换一个" warning.
    if (info.valid === false) return { refreshable: false, reason: "令牌失效了，读不到额度。" };
    if (info.usageError === "USAGE_TOKEN_EXPIRED")
      return { refreshable: false, reason: KEY_USAGE_ERRORS.USAGE_TOKEN_EXPIRED };
    if (info.usage) return { refreshable: true, reason: null };
    return {
      refreshable: true,
      reason: KEY_USAGE_ERRORS[info.usageError] || "额度暂时读不到，点刷新重试。",
    };
  }

  // The vendor's one saved key (or Claude subscription token) as a card in the account grid;
  // hidden while none is saved. `openForm()` shows the save / replace form in its place.
  function keyCard(vendor, { alive, onLoaded, saveFailed }) {
    const spec = VENDORS[vendor];
    const element = h("section", { class: "m span-3 account-card key-card", hidden: true });
    let info = null;

    function openForm() {
      const key = h("input", {
        class: "input",
        type: "password",
        placeholder: spec.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        "aria-label": spec.title,
      });
      const save = () =>
        call("agents.officialKeys.set", { vendor, apiKey: key.value.trim() }).then((r) => {
          toast(
            r && r.valid
              ? `已保存，读到 ${r.modelCount} 个模型。在「AI 助手」页的“使用”里选它`
              : "已保存，但官方接口暂时没通过验证",
          );
          load();
        }, saveFailed);
      key.addEventListener("keydown", (event) => {
        if (event.key === "Enter") save();
        if (event.key === "Escape") render();
      });
      element.hidden = false;
      element.classList.add("tone");
      put(
        element,
        h(
          "div",
          { class: "row" },
          h("div", { class: "who" }, h("b", null, spec.title), h("span", null, spec.use)),
        ),
        h("p", { class: "sub" }, `${spec.hint}加密保存在本机，只发给官方，界面上不会再显示。`),
        h("div", { class: "form" }, key),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn paper sm", type: "button", onclick: save }, "保存"),
          h("button", { class: "btn quiet sm", type: "button", onclick: render }, "取消"),
        ),
      );
      element.scrollIntoView({ block: "nearest" });
      key.focus();
    }

    function render() {
      element.classList.remove("tone");
      element.hidden = !info;
      if (!info) {
        put(element);
        return;
      }
      const subscription = info.kind === "subscription";
      const masked = info.last4 ? `····${info.last4}` : info.keyMask || "";
      const state =
        info.valid === true
          ? h("span", { class: "tag ok" }, "有效")
          : info.valid === false
            ? h("span", { class: "tag warn" }, "已失效")
            : h("span", { class: "tag" }, "未能验证");
      const card = accountCard({
        name: subscription
          ? info.email || "Claude 订阅令牌"
          : spec.title.replace(" / 订阅令牌", ""),
        facts: subscription
          ? ["订阅令牌", info.plan ? info.plan.toUpperCase() : null, info.organization, masked]
          : ["API Key", masked, info.modelCount ? `${info.modelCount} 个模型` : null, "按用量计费"],
        badge: state,
        quota: subscription
          ? info.usage
            ? quotaCards(info.usage, { updated: true })
            : quotaCards(null, { reason: keyQuota(info).reason })
          : quotaCards(null, {
              value: "不支持",
              reason: "普通 API Key 官方不提供额度查询，账单请到官方控制台查看。",
            }),
        notes: [
          h("p", { class: "sub" }, spec.use),
          info.valid === false
            ? h("p", { class: "warn-text" }, "官方不接受这个 Key / 令牌了，请换一个新的。")
            : info.error && info.valid !== true && !(subscription && info.usageError)
              ? h("p", { class: "sub" }, KEY_ERRORS[info.error] || explain(info.error))
              : null,
        ],
        actions: [h("button", { class: "btn sm", type: "button", onclick: openForm }, "换一个")],
        onRemove: () =>
          call("agents.officialKeys.remove", { vendor }).then(() => {
            info = null;
            render();
            if (onLoaded) onLoaded(null);
          }),
        removedText: "已删除这个 Key",
      });
      put(element, ...card.childNodes);
    }

    async function load() {
      const result = await call("agents.officialKeys.info", { vendor }).catch(() => undefined);
      if (!alive()) return info;
      if (result !== undefined) info = (result && result.info) || null;
      render();
      if (onLoaded) onLoaded(info);
      if (result === undefined) throw new Error("KEY_INFO_FAILED");
      return info;
    }

    load().catch(() => undefined);
    return {
      element,
      openForm,
      reload: load,
      get info() {
        return info;
      },
    };
  }

  // usageAll replies: { results: [{ id, usage } | { id, error }] } (Codex adds `available`).
  function usageFailures(result) {
    if (!result || result.available === false || !Array.isArray(result.results))
      throw new Error("RLY0_CORE_UNAVAILABLE");
    return new Map(result.results.filter((r) => r.error).map((r) => [r.id, r.error]));
  }

  return {
    quotaCards,
    accountCard,
    pageHead,
    autoSwitchCard,
    refresher,
    keyCard,
    usageFailures,
    keyQuota,
    unavailable,
    icon,
  };
};
