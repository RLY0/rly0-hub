"use strict";
// 账号 page, xAI · Grok and Google · Gemini tabs (same layout as the Codex and Claude tabs,
// pages/account-cards.js). Both are 测试版: not yet tried with real accounts.
// - Grok: saved Grok CLI accounts (copies of its auth.json kept by rly0-core): quota, manual
//   switch and the opt-in auto-switch, rename, remove; add by `grok login` in a throw-away
//   folder, an auth.json file, or the official xAI API key.
// - Gemini: Antigravity keeps one login in the system keyring, shared with the Antigravity App and
//   IDE extensions, so the Hub cannot save or switch accounts there. It shows the current login's
//   quota from Antigravity's own /usage, read only when asked.
window.registerHubGrokGeminiAccounts = (
  { h, call, toast, failed, explain, go, LOGIN_ICONS, accountCards: cards },
  { pickFile, loginFailed },
) => {
  const GROK_ERRORS = {
    GROK_NOT_LOGGED_IN: "Grok 还没登录：先在 Grok 里登录（或用“+ 添加 → 网页登录”）",
    GROK_IDENTITY_UNKNOWN: "Grok 的登录文件里没有账号 ID，暂时无法保存",
    GROK_FILE_NOT_JSON: "这个文件不是 JSON。请选 Grok 的 auth.json 登录文件（在 ~/.grok 里）",
    GROK_FILE_NO_LOGIN:
      "文件里没有 Grok 登录。需要的是 Grok 的 auth.json（含 https://auth.x.ai 登录），或带 xAI Key 的账号 JSON",
    GROK_FILE_API_KEY: "这是 xAI API Key，不是账号登录：请用「+ 添加 → 官方 API Key」保存",
    GROK_FILE_IDENTITY_UNKNOWN: "文件里的登录没有账号 ID（user_id），无法区分是哪个账号",
    GROK_FILE_TOO_LARGE: "文件太大，不像是 Grok 登录文件",
  };
  const grokFailed = (error) => {
    const code = error && error.message;
    if (GROK_ERRORS[code]) toast(GROK_ERRORS[code]);
    else loginFailed(error);
  };
  const BETA_GROK =
    "还没用真实 Grok 账号验证过。切换会替换 Grok 的 ~/.grok/auth.json（替换前会先备份当前登录）；遇到问题请在「维护工具」里反馈。";
  const BETA_GEMINI =
    "还没用真实 Antigravity 账号验证过：额度来自 Antigravity 自己的 /usage 命令。";

  /* ---------- xAI · Grok ---------- */
  function grok(root, alive) {
    const list = h("div", { class: "grid compact" });
    let failures = new Map();
    let accountCount = 0;
    const key = cards.keyCard("xai", { alive, saveFailed: loginFailed });
    const refresh = cards.refresher({
      alive,
      run: async () => {
        failures = cards.usageFailures(await call("agents.grokAccounts.usageAll"));
        await load();
        return failures.size;
      },
    });
    const syncRefresh = () =>
      refresh.setReason(
        accountCount
          ? null
          : "还没有保存的 Grok 账号，没有额度可刷新（xAI API Key 官方不提供额度查询）",
      );
    const saveCurrent = () =>
      call("agents.grokAccounts.importCurrent", {}).then(() => {
        toast("已保存当前 Grok 登录，之后可以一键切换");
        load().then(() => refresh.refresh());
      }, grokFailed);
    const importFile = () =>
      pickFile((content) =>
        call("agents.grokAccounts.importFile", { content }).then((result) => {
          if (result.key) {
            toast("文件里是 xAI API Key，已保存为官方 Key");
            key.reload().catch(() => undefined);
            return;
          }
          toast(
            result.alreadyCurrent
              ? "这就是当前登录的 Grok 账号，已保存"
              : result.expired
                ? `已导入 ${result.email || "Grok 账号"}；它的登录已过期，切换过去后 Grok 会自动续期`
                : `已导入 ${result.email || "Grok 账号"}，当前登录不受影响`,
          );
          load().then(() => refresh.refresh());
        }, grokFailed),
      );
    root.append(
      cards.pageHead({
        intro: "保存多个 Grok 账号手动一键切换，也能用 xAI 官方 API Key。",
        beta: BETA_GROK,
        refresh: refresh.element,
        saveCurrent: { onClick: saveCurrent },
        addItems: [
          {
            icon: LOGIN_ICONS.web,
            title: "网页登录",
            desc: "用 Grok 官方的 grok login 在浏览器里登录另一个 xAI 账号，当前登录不受影响",
            onSelect: () =>
              window.openGrokAddLogin({
                h,
                call,
                toast,
                explain,
                onAdded: () => {
                  if (alive()) load().then(() => refresh.refresh());
                },
              }),
          },
          {
            icon: LOGIN_ICONS.file,
            title: "从文件导入",
            desc: "Grok 的 auth.json 登录文件（~/.grok/auth.json），或带 xAI Key 的账号 JSON",
            onSelect: importFile,
          },
          {
            icon: LOGIN_ICONS.key,
            title: "官方 API Key",
            desc: "xAI 控制台的 Key（xai-…）",
            onSelect: () => key.openForm(),
          },
        ],
      }),
      h(
        "div",
        { class: "grid compact account-auto" },
        cards.autoSwitchCard({
          alive,
          agent: "grok",
          vendor: "xAI",
          sub: "低于阈值时切到额度最多的已保存 Grok 账号；新的对话就用它，不用重启",
          windows: [["remainWeekly", "每周 / 每月额度", "额度阈值"]],
          beta: "还没用真实 Grok 账号验证过自动切换；切换方式和「切换到这个」一样，替换 Grok 的登录文件。",
        }),
      ),
      list,
    );

    // Grok runs on its own login unless the AI 助手 page bound it to the xAI key or a relay.
    let using = "login";
    async function load() {
      const [listed, inUse] = await Promise.all([
        call("agents.grokAccounts.list").catch(() => null),
        cards.credentialInUse("grok", "xai"),
      ]);
      if (!alive()) return;
      using = inUse;
      key.setInUse(using === "key");
      const accounts = (listed && listed.accounts) || [];
      accountCount = accounts.length;
      syncRefresh();
      const live =
        listed && listed.liveLoggedIn && (listed.liveUnsaved || listed.liveIdentityUnknown);
      const unsaved = live
        ? cards.accountCard({
            name: (listed.live && listed.live.email) || "当前 Grok 登录",
            facts: ["还没保存"],
            current: using === "login",
            signedIn: using !== "login",
            quota: cards.quotaCards(null, { kinds: ["额度"], reason: "保存后会读取它的额度" }),
            notes: [
              h(
                "p",
                { class: "sub" },
                listed.liveIdentityUnknown
                  ? "Grok 的登录文件里没有账号 ID，暂时无法保存这个登录。"
                  : "还没保存。保存后可以和其他账号一键切换。",
              ),
            ],
            actions: listed.liveIdentityUnknown
              ? []
              : [
                  h(
                    "button",
                    { class: "btn paper sm", type: "button", onclick: saveCurrent },
                    "保存",
                  ),
                ],
          })
        : null;
      list.replaceChildren(
        ...(unsaved ? [unsaved] : []),
        ...accounts.map(card),
        ...(accounts.length || unsaved
          ? []
          : [
              h(
                "p",
                { class: "empty span-6" },
                listed
                  ? "还没有保存的 Grok 账号。点右上角“+ 添加” → 网页登录，可以添加多个，手动一键切换。"
                  : "后台服务还没准备好，读不到 Grok 账号。",
              ),
            ]),
        key.element,
      );
      list.dataset.accountReady = "true";
    }

    // An expired token: the live one is the Grok CLI's to renew; a saved one is renewed by the CLI
    // once it is switched to (the Hub does not refresh Grok tokens).
    const grokUsageError = (code, current) =>
      code === "USAGE_TOKEN_EXPIRED"
        ? current
          ? "GROK_LIVE_EXPIRED"
          : "GROK_SAVED_EXPIRED"
        : code;

    function refreshOne(account) {
      return h(
        "button",
        {
          class: "btn quiet sm",
          type: "button",
          "aria-label": `刷新 ${account.alias || account.email || "这个账号"} 的额度`,
          onclick: async (event) => {
            event.currentTarget.disabled = true;
            try {
              await call("agents.grokAccounts.usage", { id: account.id });
              failures.delete(account.id);
            } catch (error) {
              failures.set(account.id, (error && error.message) || "USAGE_BAD_RESPONSE");
            }
            if (alive()) await load();
          },
        },
        "刷新",
      );
    }

    function card(account) {
      const stale =
        failures.get(account.id) ||
        (account.loginExpired && !account.lastUsage ? "USAGE_TOKEN_EXPIRED" : null);
      return cards.accountCard({
        name: account.alias || account.email || "Grok 账号",
        onRename: (alias) =>
          call("agents.grokAccounts.rename", { id: account.id, alias }).then((result) => {
            if (!result || !result.ok) throw new Error("RLY0_CORE_UNAVAILABLE");
            return load();
          }),
        facts: [
          account.email && account.email !== account.alias ? account.email : null,
          "xAI 账号",
        ],
        current: account.current && using === "login",
        signedIn: account.current && using !== "login",
        quota: cards.quotaCards(account.lastUsage, {
          reset: { vendor: "xai" },
          updated: true,
          kinds: ["额度"],
          reason: "额度未知：点右上角刷新读取",
          stale: stale ? grokUsageError(stale, account.current) : null,
        }),
        actions: [
          refreshOne(account),
          ...(account.current
            ? []
            : [
                h(
                  "button",
                  {
                    class: "btn paper sm",
                    type: "button",
                    onclick: () =>
                      call("agents.grokAccounts.switch", { id: account.id }).then((r) => {
                        toast(
                          r && r.switched
                            ? `已切换到 ${account.alias || account.email}，新开的 Grok 对话生效${r.expired ? "（Grok 会自动续期这个登录）" : ""}`
                            : "已经是这个账号",
                        );
                        load();
                      }, failed),
                  },
                  "切换到这个",
                ),
              ]),
        ],
        onRemove: () => call("agents.grokAccounts.remove", { id: account.id }).then(() => load()),
        removedText: "已删除保存的账号（当前登录不受影响）",
      });
    }

    load().then(() => {
      if (alive() && accountCount) refresh.refresh();
    });
  }

  /* ---------- Google · Gemini (Antigravity) ---------- */
  const AGY_ERRORS = {
    ANTIGRAVITY_NOT_LOGGED_IN: "Antigravity 还没登录（或登录已失效）",
    ANTIGRAVITY_START_FAILED: "Antigravity 没能运行",
    TIMEOUT: "Antigravity 回答超时",
    USAGE_BAD_RESPONSE: "Antigravity 没有给出额度",
  };
  const MULTI_REASON =
    "Antigravity 把登录存在系统钥匙串（Windows 凭据管理器）里，并和 Antigravity 桌面版、IDE 插件共用这一份，也没有能换位置的设置；Hub 不去读写它，所以暂不支持保存和切换多个 Google 账号。";

  function gemini(root, alive) {
    const list = h("div", { class: "grid compact" });
    const key = cards.keyCard("google", { alive, saveFailed: loginFailed });
    let agent = null;
    let state = null; // agents.antigravity.status / usage reply
    let statusFailed = false;
    let statusLoading = null;
    let stateVersion = 0;
    const refresh = cards.refresher({
      alive,
      run: async () => {
        const version = ++stateVersion;
        const result = await call("agents.antigravity.usage");
        if (!alive() || version !== stateVersion) return 0;
        state = result;
        render();
        if (state && state.error && !state.usage) throw new Error(state.error);
        return state && state.error ? 1 : 0;
      },
    });
    const openLogin = () => {
      if (!agent || !agent.installed) {
        toast("先在「AI 助手」页装好 Antigravity");
        return;
      }
      call("agents.openLogin", { agent: "antigravity" }).then(
        (r) => toast(r.ok ? "已打开终端，按提示在浏览器里登录" : "没能打开终端"),
        failed,
      );
    };
    root.append(
      cards.pageHead({
        intro:
          "Google 的官方助手 Antigravity 用 Google 账号登录；Gemini API Key 也能给 Pi、Hermes 等助手用。",
        beta: BETA_GEMINI,
        refresh: refresh.element,
        saveCurrent: { reason: `暂不支持：${MULTI_REASON}` },
        addItems: [
          {
            icon: LOGIN_ICONS.web,
            title: "网页登录",
            desc: "打开 Antigravity，在浏览器里登录 Google 账号（会替换它当前的登录）",
            onSelect: openLogin,
          },
          {
            icon: LOGIN_ICONS.file,
            title: "导入登录文件",
            desc: "Sub2API 导出的 Gemini 账号 JSON（只取其中的 Gemini Key）",
            onSelect: () =>
              pickFile((content) =>
                call("agents.officialKeys.importFile", { vendor: "google", content }).then(() => {
                  toast("已从文件导入 Key");
                  key.reload().catch(() => undefined);
                }, loginFailed),
              ),
          },
          {
            icon: LOGIN_ICONS.key,
            title: "官方 API Key",
            desc: "Google AI Studio 的 Gemini Key（AIza…）",
            onSelect: () => key.openForm(),
          },
        ],
      }),
      h(
        "div",
        { class: "grid compact account-auto" },
        cards.autoSwitchCard({ alive, reason: MULTI_REASON }),
      ),
      list,
    );

    function render() {
      const installed = Boolean(state ? state.installed : agent && agent.installed);
      const known = Boolean(state && typeof state.installed === "boolean");
      refresh.setReason(
        known
          ? installed
            ? null
            : "先在「AI 助手」页装好 Antigravity，才能读取额度"
          : "登录状态暂未读到，请重试读取",
      );
      const usage = state && state.usage;
      const historical = Boolean(usage && state.observationOnly);
      const error = state && state.error;
      // Antigravity has one login, so a working one is the one in use.
      const inUse = installed && Boolean(usage) && !error && !historical;
      const badge = !known
        ? h("span", { class: "tag" }, statusFailed ? "读取失败" : "读取中")
        : !installed
          ? h("span", { class: "tag" }, "未安装")
          : historical
            ? h("span", { class: "tag" }, "上次查询")
            : inUse
              ? null
              : error === "ANTIGRAVITY_NOT_LOGGED_IN"
                ? h("span", { class: "tag warn" }, "未登录")
                : h("span", { class: "tag" }, "登录状态未知");
      list.replaceChildren(
        cards.accountCard({
          name: historical ? "Antigravity 上次查询" : "Antigravity 当前登录",
          current: inUse,
          facts: [
            !known
              ? statusFailed
                ? "安装和登录状态未知，请重试"
                : "正在读取本机状态"
              : installed
                ? "Google 账号 · 只有一个登录"
                : "先在「AI 助手」页装好 Antigravity",
          ],
          badge,
          quota: usage
            ? cards.quotaCards(usage, {
                updated: true,
                stale: error || null,
                reset: { vendor: "google" },
              })
            : cards.quotaCards(null, {
                reason: !known
                  ? statusFailed
                    ? "状态读取失败，请重试读取"
                    : "正在读取本机状态"
                  : !installed
                    ? "装好 Antigravity 后可以读取它当前登录的额度。"
                    : error
                      ? `读取失败：${AGY_ERRORS[error] || explain(error)}`
                      : "点右上角刷新，用 Antigravity 自己的 /usage 读取当前登录的额度（没登录时它可能会打开浏览器让你登录）。",
              }),
          notes: [
            historical
              ? h("p", { class: "sub" }, "这是上次查询的额度；当前登录尚未核实，点刷新读取当前额度")
              : null,
            state && state.cacheError
              ? h(
                  "p",
                  { class: "warn-text" },
                  "额度已读到，但本地保存失败；下次打开可能需要重新查询",
                )
              : null,
          ],
          actions: [
            !known
              ? h("button", { class: "btn sm", type: "button", onclick: loadStatus }, "重试读取")
              : installed
                ? h(
                    "button",
                    { class: "btn paper sm", type: "button", onclick: openLogin },
                    "登录 / 换账号",
                  )
                : h(
                    "button",
                    { class: "btn sm", type: "button", onclick: () => go("agents") },
                    "去安装",
                  ),
          ],
        }),
        key.element,
      );
    }
    render();
    function loadStatus() {
      if (statusLoading) return statusLoading;
      const version = ++stateVersion;
      call("agents.antigravity.cached")
        .then((cached) => {
          if (!alive() || version !== stateVersion || !cached || !cached.usage) return;
          if (state && state.error === "ANTIGRAVITY_NOT_LOGGED_IN") return;
          state = { ...(state || {}), ...cached, observationOnly: true };
          refresh.stamp(cached.usage.fetchedAt * 1000);
          render();
          list.dataset.accountReady = "true";
        })
        .catch(() => undefined);
      statusLoading = call("agents.antigravity.status")
        .catch(() => null)
        .then((status) => {
          if (!alive() || version !== stateVersion) return;
          agent = status;
          state = status || state;
          statusFailed = !status;
          if (state && state.usage && state.usage.fetchedAt)
            refresh.stamp(state.usage.fetchedAt * 1000);
          render();
          list.dataset.accountReady = "true";
        })
        .finally(() => {
          statusLoading = null;
        });
      return statusLoading;
    }
    loadStatus();
  }

  return { grok, gemini };
};
