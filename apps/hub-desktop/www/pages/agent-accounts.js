"use strict";
// 账号 page, Anthropic · Claude / Google · Gemini / xAI · Grok tabs, in the same layout as the
// Codex tab (pages/account-cards.js).
// - Claude: saved Claude Code accounts (quota, switch, rename, remove), add by web login / login
//   file / official API key or subscription token; the saved key or token is a card of its own.
// - Gemini, Grok: the agent's own sign-in (in its terminal) and the vendor's official API key.
//   The Hub cannot read those logins, so saving, switching and quota are shown as unsupported.
// Choosing which login or relay an agent uses happens on the AI 助手 page.
window.registerHubAgentAccounts = ({
  h,
  call,
  toast,
  failed,
  explain,
  pollers,
  go,
  LOGIN_ICONS,
  accountCards: cards,
}) => {
  const LOGIN_ERRORS = {
    API_KEY_INVALID: "Key 格式不对，请检查是不是这家的官方 Key",
    AUTH_FILE_INVALID: "这个文件不是有效的 JSON",
    AUTH_FILE_NOT_A_LOGIN:
      "文件里没有这家的登录或 Key（支持官方登录文件和 Sub2API 导出的账号 JSON）",
    RLY0_CORE_UNAVAILABLE: "后台服务还没准备好，请稍后再试",
    CLAUDE_IDENTITY_UNKNOWN: "还读不到这个账号是谁：在 Codex 里用一次 Claude Code 后再保存",
    CLAUDE_NOT_LOGGED_IN: "Claude Code 还没登录",
  };
  const loginFailed = (error) =>
    toast(LOGIN_ERRORS[error && error.message] || explain(error && error.message));

  function pickFile(onText) {
    const input = h("input", { type: "file", accept: ".json,application/json", hidden: true });
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      if (file.size > 256 * 1024) {
        toast("文件太大，不像是登录文件");
        return;
      }
      file.text().then(onText);
    });
    document.body.append(input);
    input.click();
  }

  /* ---------- Anthropic · Claude ---------- */
  function claude(root, alive) {
    const list = h("div", { class: "grid compact" });
    let failures = new Map();
    let accountCount = 0;
    // The token can report quota only when it is a full login token, not a setup-token.
    const keyHasQuota = (info) => Boolean(info && info.kind === "subscription" && info.usage);
    const syncRefresh = () =>
      refresh.setReason(
        accountCount || keyHasQuota(key.info)
          ? null
          : key.info && key.info.kind === "subscription"
            ? "订阅令牌（claude setup-token）只能调用模型，官方不允许它查询额度"
            : key.info
              ? "API Key 官方不提供额度查询；保存 Claude 账号后可以刷新它们的额度"
              : "还没有保存的 Claude 账号，没有额度可刷新",
      );
    const key = cards.keyCard("anthropic", {
      alive,
      saveFailed: loginFailed,
      onLoaded: () => syncRefresh(),
    });
    const refresh = cards.refresher({
      alive,
      run: async () => {
        const [usage] = await Promise.all([
          accountCount ? call("agents.claudeAccounts.usageAll") : null,
          keyHasQuota(key.info) ? key.reload() : null,
        ]);
        if (usage !== null) failures = cards.usageFailures(usage);
        await load();
        return failures.size;
      },
    });
    const saveCurrent = () =>
      call("agents.claudeAccounts.importCurrent", {}).then(() => {
        toast("已保存当前 Claude 登录，之后可以一键切换");
        load();
      }, loginFailed);
    root.append(
      cards.pageHead({
        intro: "保存多个 Claude 账号一键切换，也能用官方 API Key / 订阅令牌。",
        refresh: refresh.element,
        saveCurrent: { onClick: saveCurrent },
        addItems: [
          {
            icon: LOGIN_ICONS.web,
            title: "网页登录",
            desc: "在浏览器里登录 Claude 账号（Pro / Max），可以添加多个",
            onSelect: () => webLogin(),
          },
          {
            icon: LOGIN_ICONS.file,
            title: "导入登录文件",
            desc: ".credentials.json 或 Sub2API 导出的 Claude 账号",
            onSelect: () =>
              pickFile((content) =>
                call("agents.claudeCode.importCredentials", { content }).then(async (result) => {
                  if (!result.token)
                    await call("agents.claudeAccounts.importCurrent", {}).catch(() => undefined);
                  toast(result.token ? "已导入 Claude 令牌" : "已导入并保存这个账号");
                  if (result.token) key.reload().catch(() => undefined);
                  load();
                }, loginFailed),
              ),
          },
          {
            icon: LOGIN_ICONS.key,
            title: "官方 API Key",
            desc: "Anthropic 的 sk-ant- Key，或 claude setup-token 生成的令牌",
            onSelect: () => key.openForm(),
          },
        ],
      }),
      h(
        "div",
        { class: "grid compact account-auto" },
        cards.autoSwitchCard({
          alive,
          reason: "自动切换目前只管 Codex 账号，后台还没有 Claude 账号的切换规则。",
        }),
      ),
      list,
    );

    // Claude's sign-in replaces the live login: save the current one first, the new one after.
    async function webLogin() {
      const before = await call("agents.claudeCode.status").catch(() => null);
      if (before && before.loggedIn)
        await call("agents.claudeAccounts.importCurrent", {}).catch(() => undefined);
      const previous = before && before.loggedIn ? before.email || "" : null;
      const result = await call("agents.claudeCode.login", { mode: "claudeai" }).catch(() => null);
      if (!result || !result.started) {
        toast("没能开始登录，请确认已安装 Claude Code");
        return;
      }
      toast("已在浏览器打开登录页，用要添加的 Claude 账号登录");
      const startedAt = Date.now();
      const timer = setInterval(async () => {
        if (Date.now() - startedAt > 5 * 60_000) {
          clearInterval(timer);
          pollers.delete(timer);
          return;
        }
        const status = await call("agents.claudeCode.status").catch(() => null);
        if (!status || !status.loggedIn) return;
        if (previous !== null && (status.email || "") === previous) return;
        clearInterval(timer);
        pollers.delete(timer);
        await call("agents.claudeAccounts.importCurrent", {}).then(
          () => toast(`已添加 ${status.email || "Claude 账号"}`),
          loginFailed,
        );
        if (alive()) load().then(() => refresh.refresh());
      }, 3000);
      pollers.add(timer);
    }

    async function load() {
      const listed = await call("agents.claudeAccounts.list").catch(() => null);
      if (!alive()) return;
      const accounts = (listed && listed.accounts) || [];
      accountCount = accounts.length;
      syncRefresh();
      const unsaved =
        listed && listed.liveUnsaved
          ? cards.accountCard({
              name: (listed.live && listed.live.email) || "当前 Claude 登录",
              facts: ["正在使用"],
              current: true,
              quota: cards.quotaCards(null, { reason: "保存后会读取它的额度" }),
              notes: [h("p", { class: "sub" }, "还没保存。保存后可以和其他账号一键切换。")],
              actions: [
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
                "还没有保存的 Claude 账号。点右上角“+ 添加” → 网页登录，可以添加多个，一键切换。",
              ),
            ]),
        key.element,
      );
    }

    function card(account) {
      return cards.accountCard({
        name: account.alias || account.email || "Claude 账号",
        onRename: (alias) =>
          call("agents.claudeAccounts.rename", { id: account.id, alias }).then(() => load()),
        facts: [
          account.email && account.email !== account.alias ? account.email : null,
          account.plan ? account.plan.toUpperCase() : null,
          account.organization,
        ],
        current: account.current,
        quota: cards.quotaCards(account.lastUsage, {
          reason: "额度未知：点右上角刷新读取",
          stale: failures.get(account.id),
        }),
        actions: account.current
          ? []
          : [
              h(
                "button",
                {
                  class: "btn paper sm",
                  type: "button",
                  onclick: () =>
                    call("agents.claudeAccounts.switch", { id: account.id }).then((r) => {
                      toast(
                        r && r.switched
                          ? `已切换到 ${account.alias || account.email}，新开的 Claude Code 对话生效`
                          : "已经是这个账号",
                      );
                      load();
                    }, failed),
                },
                "切换到这个",
              ),
            ],
        onRemove: () => call("agents.claudeAccounts.remove", { id: account.id }).then(() => load()),
        removedText: "已删除保存的账号（当前登录不受影响）",
      });
    }

    load().then(() => {
      if (alive() && accountCount) refresh.refresh();
    });
  }

  /* ---------- Google · Gemini and xAI · Grok ---------- */
  // Their logins live inside the agents themselves; the Hub can open the agent's sign-in and keep
  // the vendor's official key, nothing more.
  function vendorTab(root, alive, options) {
    const { vendor, agentId, agentName, intro, webDesc, fileDesc, keyDesc } = options;
    const list = h("div", { class: "grid compact" });
    const key = cards.keyCard(vendor, { alive, saveFailed: loginFailed });
    const refresh = cards.refresher({ alive, run: async () => 0 });
    refresh.setReason(
      `Hub 读不到 ${agentName} 自己登录的额度；${options.vendorName} API Key 官方不提供额度查询`,
    );
    let agent = null;
    const openLogin = () => {
      if (!agent || !agent.installed) {
        toast(`先在「AI 助手」页装好 ${agentName}`);
        return;
      }
      call("agents.openLogin", { agent: agentId }).then(
        (r) => toast(r.ok ? "已打开终端，按提示在浏览器里登录" : "没能打开终端"),
        failed,
      );
    };
    root.append(
      cards.pageHead({
        intro,
        refresh: refresh.element,
        saveCurrent: {
          reason: `暂不支持：${agentName} 的登录保存在它自己那里，Hub 读不到，没法保存或切换多个账号`,
        },
        addItems: [
          { icon: LOGIN_ICONS.web, title: "网页登录", desc: webDesc, onSelect: openLogin },
          {
            icon: LOGIN_ICONS.file,
            title: "导入登录文件",
            desc: fileDesc,
            onSelect: () =>
              pickFile((content) =>
                call("agents.officialKeys.importFile", { vendor, content }).then(() => {
                  toast("已从文件导入 Key");
                  key.reload().catch(() => undefined);
                }, loginFailed),
              ),
          },
          {
            icon: LOGIN_ICONS.key,
            title: "官方 API Key",
            desc: keyDesc,
            onSelect: () => key.openForm(),
          },
        ],
      }),
      h(
        "div",
        { class: "grid compact account-auto" },
        cards.autoSwitchCard({
          alive,
          reason: `Hub 只能保存一个 ${agentName} 登录和一个 Key，没有可切换的账号，也读不到额度。`,
        }),
      ),
      list,
    );
    const render = () =>
      list.replaceChildren(
        cards.accountCard({
          name: `${agentName} 官方账号`,
          facts: [
            agent && agent.installed
              ? `在 ${agentName} 自己的终端里登录，登录后它就用这个账号`
              : `先在「AI 助手」页装好 ${agentName}，再在这里登录`,
          ],
          badge: h("span", { class: "tag" }, "登录状态未知"),
          quota: cards.quotaCards(null, {
            reason: `Hub 读不到 ${agentName} 自己的登录，所以不知道登没登录、还剩多少额度。`,
          }),
          actions: [
            agent && agent.installed && agent.canOpenLogin
              ? h(
                  "button",
                  { class: "btn paper sm", type: "button", onclick: openLogin },
                  "登录官方账号",
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
    render();
    call("agents.list")
      .catch(() => null)
      .then((result) => {
        if (!alive()) return;
        agent = ((result && result.agents) || []).find((a) => a.id === agentId) || null;
        render();
      });
  }

  const gemini = (root, alive) =>
    vendorTab(root, alive, {
      vendor: "google",
      vendorName: "Gemini",
      agentId: "antigravity",
      agentName: "Antigravity",
      intro:
        "Google 的官方助手 Antigravity 用 Google 账号登录；Gemini API Key 也能给 Pi、Hermes 等助手用。",
      webDesc: "用 Antigravity 在浏览器里登录 Google 账号",
      fileDesc: "Sub2API 导出的 Gemini / Antigravity 账号 JSON",
      keyDesc: "Google AI Studio 的 Gemini Key（AIza…）",
    });
  const grok = (root, alive) =>
    vendorTab(root, alive, {
      vendor: "xai",
      vendorName: "xAI",
      agentId: "grok",
      agentName: "Grok",
      intro: "xAI 的官方助手 Grok 用 xAI 账号登录；xAI API Key 也能给 Pi、Hermes 等助手用。",
      webDesc: "用 Grok 在浏览器里登录 xAI 账号",
      fileDesc: "Sub2API 导出的 Grok 账号 JSON",
      keyDesc: "xAI 控制台的 Key（xai-…）",
    });

  return { claude, gemini, grok };
};
