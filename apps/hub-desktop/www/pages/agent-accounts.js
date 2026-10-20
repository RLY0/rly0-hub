"use strict";
// 账号 page, Anthropic · Claude / Google · Gemini / xAI · Grok tabs, in the same layout as the
// Codex tab (pages/account-cards.js).
// - Claude: saved Claude Code accounts (quota, switch, rename, remove), add by web login / login
//   file / official API key or subscription token; the saved key or token is a card of its own.
// - Gemini, Grok: pages/grok-gemini-accounts.js.
// Choosing which login or relay an agent uses happens on the AI 助手 page.
window.registerHubAgentAccounts = ({
  h,
  call,
  toast,
  failed,
  explain,
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
    // 从文件导入 (rly0-core claude/importFile)
    CLAUDE_FILE_NOT_JSON: "这个文件不是 JSON。请选 Claude Code 的 .credentials.json 登录文件",
    CLAUDE_FILE_NO_LOGIN:
      '文件里没有 Claude 登录。需要的格式是 {"claudeAiOauth": {"accessToken", "refreshToken", …}}',
    CLAUDE_FILE_API_KEY: "这是 API Key，不是账号登录：请用「+ 添加 → 官方 API Key」保存",
    CLAUDE_FILE_EXPIRED: "这个登录文件已经失效了（令牌过期且无法续期），请重新登录这个账号",
    CLAUDE_FILE_TOO_LARGE: "文件太大，不像是 Claude 登录文件",
    CLAUDE_FILE_IDENTITY_NETWORK:
      "连不上 Claude 官方，确认不了这是哪个账号，请检查网络或代理后重试",
    CLAUDE_FILE_IDENTITY_UNKNOWN: "官方没有告诉我们这是哪个账号，暂时无法导入",
    METHOD_NOT_FOUND: "后台核心版本太旧，请先更新 RLY/0 Hub",
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
    // The saved subscription token (full login or setup-token) has quota tiles of its own,
    // refreshed by re-reading the key's info; rly0-core reuses a setup-token probe for a minute.
    const keyRefreshable = (info) => cards.keyQuota(info).refreshable;
    const syncRefresh = () =>
      refresh.setReason(
        accountCount || keyRefreshable(key.info)
          ? null
          : key.info
            ? key.info.kind === "subscription"
              ? cards.keyQuota(key.info).reason
              : "API Key 官方不提供额度查询；保存 Claude 账号后可以刷新它们的额度"
            : "还没有保存的 Claude 账号，没有额度可刷新",
      );
    let keyStamped = false;
    const key = cards.keyCollection("anthropic", {
      alive,
      saveFailed: loginFailed,
      onChanged: () => load(),
      onLoaded: (info) => {
        syncRefresh();
        // Only the token: its first read is the page's first quota read.
        if (!keyStamped && !accountCount && info && info.usage && info.usage.fetchedAt) {
          keyStamped = true;
          refresh.stamp(info.usage.fetchedAt * 1000);
        }
      },
    });
    const refresh = cards.refresher({
      alive,
      run: async () => {
        const withKey = keyRefreshable(key.info);
        const [usage, info] = await Promise.all([
          accountCount ? call("agents.claudeAccounts.usageAll") : null,
          withKey ? key.reload() : null,
        ]);
        if (usage !== null) failures = cards.usageFailures(usage);
        await load();
        const keyFailed = withKey && !(info && info.usage) ? 1 : 0;
        const failed = failures.size + keyFailed;
        // Only the token: show when the core actually read it (a probe is reused for a minute).
        return !accountCount && info && info.usage && info.usage.fetchedAt
          ? { failed, at: info.usage.fetchedAt * 1000 }
          : failed;
      },
    });
    const importFile = () =>
      pickFile((content) =>
        call("agents.claudeAccounts.importFile", { content }).then((result) => {
          if (result.token) {
            toast("文件里是订阅令牌，已保存为官方令牌");
            key.reload().catch(() => undefined);
          } else
            toast(
              result.alreadyCurrent
                ? "这就是当前登录的账号，已保存"
                : `已导入 ${result.email || "Claude 账号"}，当前登录不受影响`,
            );
          load().then(() => refresh.refresh());
        }, loginFailed),
      );
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
            desc: "在浏览器里登录另一个 Claude 账号（Pro / Max），当前登录不受影响",
            onSelect: () =>
              window.openClaudeAddLogin({
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
            desc: "Claude Code 的 .credentials.json 登录文件，或 Sub2API 导出的账号",
            onSelect: importFile,
          },
          {
            icon: LOGIN_ICONS.key,
            title: "订阅令牌 / API Key",
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
          reason:
            "Claude 账号只能手动切换：自动轮换多个订阅账号可能违反 Anthropic 的使用条款，所以不提供。",
        }),
      ),
      list,
    );

    // Claude Code runs on its login unless the AI 助手 page bound it to the key or a relay.
    let using = "login";
    async function load() {
      const [listed, inUse] = await Promise.all([
        call("agents.claudeAccounts.list").catch(() => null),
        cards.credentialInUse("claudeCode", "anthropic"),
      ]);
      if (!alive()) return;
      using = inUse;
      key.setInUse(using === "key");
      const accounts = (listed && listed.accounts) || [];
      accountCount = accounts.length;
      syncRefresh();
      const unsaved =
        listed && listed.liveUnsaved
          ? cards.accountCard({
              name: (listed.live && listed.live.email) || "当前 Claude 登录",
              facts: ["还没保存"],
              current: using === "login",
              signedIn: using !== "login",
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
                "网页登录账号可用“+ 添加 → 网页登录”；订阅令牌保存在下方独立卡片，可继续添加。",
              ),
            ]),
        key.element,
      );
      list.dataset.accountReady = "true";
    }

    // An expired token means different things: the live login is Claude Code's to refresh; a
    // saved one is renewed by the core, and only a login that was signed out cannot be.
    const claudeUsageError = (code, current) =>
      code === "USAGE_TOKEN_EXPIRED"
        ? current
          ? "CLAUDE_LIVE_EXPIRED"
          : "CLAUDE_SAVED_EXPIRED"
        : code;

    function refreshOne(account) {
      return h(
        "button",
        {
          class: "btn quiet sm",
          type: "button",
          "aria-label": `刷新 ${account.alias || account.email || "这个账号"} 的额度`,
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              await call("agents.claudeAccounts.usage", { id: account.id });
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
      return cards.accountCard({
        name: account.alias || account.email || "Claude 账号",
        onRename: (alias) =>
          call("agents.claudeAccounts.rename", { id: account.id, alias }).then((result) => {
            if (!result || !result.ok) throw new Error("RLY0_CORE_UNAVAILABLE");
            return load();
          }),
        facts: [
          account.email && account.email !== account.alias ? account.email : null,
          account.plan ? account.plan.toUpperCase() : null,
          account.organization,
        ],
        current: account.current && using === "login",
        signedIn: account.current && using !== "login",
        quota: cards.quotaCards(account.lastUsage, {
          reason: "额度未知：点右上角刷新读取",
          stale: claudeUsageError(failures.get(account.id), account.current),
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
              ]),
        ],
        onRemove: () => call("agents.claudeAccounts.remove", { id: account.id }).then(() => load()),
        removedText: "已删除保存的账号（当前登录不受影响）",
      });
    }

    load().then(() => {
      if (alive() && accountCount) refresh.refresh();
    });
  }

  // Grok and Gemini (Antigravity): pages/grok-gemini-accounts.js.
  const others = window.registerHubGrokGeminiAccounts(
    { h, call, toast, failed, explain, go, LOGIN_ICONS, accountCards: cards },
    { pickFile, loginFailed },
  );

  return { claude, gemini: others.gemini, grok: others.grok };
};
