"use strict";
// 账号 page, agent tabs: where agents' own logins are added and managed.
// - Claude Code: saved Claude accounts (quota, switch, remove), add by web login / login file /
//   official API key, and what the saved key or subscription token is.
// - 其他助手: each installed third-party agent's own sign-in, with the steps for its terminal.
// Choosing which login or relay an agent uses happens on the AI 助手 page.
window.registerHubAgentAccounts = ({
  h,
  call,
  toast,
  failed,
  explain,
  pollers,
  go,
  countdown,
  resetText,
  LOGIN_ICONS,
}) => {
  const put = (element, ...items) =>
    element.replaceChildren(
      ...items
        .flat(Infinity)
        .filter((item) => item !== null && item !== undefined && item !== false),
    );
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

  const LOGOS = {
    "claude-code": "agents/claude-code.svg",
    antigravity: "agents/antigravity.svg",
    grok: "agents/grok.png",
    opencode: "agents/opencode.png",
    pi: "agents/pi.svg",
    hermes: "agents/hermes.png",
    "cursor-cli": "agents/cursor-cli.svg",
    "kiro-cli": "agents/kiro-cli.svg",
  };
  const logo = (agent, size = 40) =>
    h(
      "span",
      { class: "agent-logo", style: { width: `${size}px`, height: `${size}px` } },
      LOGOS[agent.id]
        ? h("img", { src: LOGOS[agent.id], alt: `${agent.name} 图标` })
        : agent.name.slice(0, 2),
    );

  function quotaBars(usage) {
    if (!usage || !usage.windows || !usage.windows.length) return null;
    return h(
      "div",
      { class: "claude-quota" },
      usage.windows.map((w) => {
        const left = Math.max(0, Math.round(100 - w.usedPercent));
        return h(
          "div",
          { class: `claude-quota-item ${left <= 15 ? "low" : ""}` },
          h(
            "div",
            { class: "row" },
            h("span", null, w.kind === "primary" ? "5 小时" : "每周"),
            h("span", { class: "spacer" }),
            h("b", { class: "tabular" }, `剩 ${left}%`),
          ),
          h("div", { class: "bar" }, h("i", { style: { width: `${left}%` } })),
          w.resetsAt
            ? h("small", null, `${countdown(w.resetsAt)} · ${resetText(w.resetsAt)}`)
            : null,
        );
      }),
    );
  }

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

  /* ---------- Claude Code ---------- */
  function claude(root, alive) {
    const keySection = vendorKey("anthropic", alive);
    const list = h("div", { class: "claude-accounts" });
    let usageRead = false;
    root.append(
      h(
        "div",
        { class: "row page-head" },
        h(
          "span",
          { class: "sub" },
          "保存多个 Claude 账号一键切换，或用官方 API Key / 订阅令牌。用哪个在「AI 助手」页选。",
        ),
        h("span", { class: "spacer" }),
        window.HubUI.menuButton(
          "+ 添加",
          [
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
                    load();
                  }, loginFailed),
                ),
            },
            {
              icon: LOGIN_ICONS.key,
              title: "官方 API Key",
              desc: "Anthropic 的 sk-ant- Key，或 claude setup-token 生成的令牌",
              onSelect: () => keySection.openForm(),
            },
          ],
          { align: "right" },
        ),
      ),
      keySection.element,
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
        if (alive()) load();
      }, 3000);
      pollers.add(timer);
    }

    async function load() {
      const listed = await call("agents.claudeAccounts.list").catch(() => null);
      if (!alive()) return;
      const accounts = (listed && listed.accounts) || [];
      const unsaved =
        listed && listed.liveUnsaved
          ? h(
              "div",
              { class: "claude-account current" },
              h(
                "div",
                { class: "row" },
                h(
                  "div",
                  { class: "who" },
                  h("b", null, (listed.live && listed.live.email) || "当前 Claude 登录"),
                  h("span", null, "正在使用 · 还没保存"),
                ),
                h("span", { class: "spacer" }),
                h(
                  "button",
                  {
                    class: "btn paper sm",
                    type: "button",
                    onclick: () =>
                      call("agents.claudeAccounts.importCurrent", {}).then(() => {
                        toast("已保存，之后可以一键切换");
                        load();
                      }, loginFailed),
                  },
                  "保存",
                ),
              ),
            )
          : null;
      put(
        list,
        h("span", { class: "label" }, `Claude 账号 · ${accounts.length}`),
        unsaved,
        accounts.map(accountRow),
        accounts.length || unsaved
          ? null
          : h(
              "p",
              { class: "empty" },
              "还没有 Claude 账号。点右上角“+ 添加” → 网页登录，可以添加多个，一键切换。",
            ),
      );
      if (!usageRead && accounts.length) {
        usageRead = true;
        call("agents.claudeAccounts.usageAll").then(
          () => alive() && load(),
          () => undefined,
        );
      }
    }

    function accountRow(account) {
      let confirmRemove = false;
      const remove = h(
        "button",
        {
          class: "btn quiet sm",
          type: "button",
          onclick: () => {
            if (!confirmRemove) {
              confirmRemove = true;
              remove.textContent = "确认删除";
              setTimeout(() => {
                confirmRemove = false;
                remove.textContent = "删除";
              }, 3000);
              return;
            }
            call("agents.claudeAccounts.remove", { id: account.id }).then(() => {
              toast("已删除保存的账号（当前登录不受影响）");
              load();
            }, failed);
          },
        },
        "删除",
      );
      return h(
        "div",
        { class: `claude-account ${account.current ? "current" : ""}` },
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "who" },
            h("b", null, account.alias),
            h(
              "span",
              null,
              [
                account.email && account.email !== account.alias ? account.email : null,
                account.plan ? account.plan.toUpperCase() : null,
                account.organization,
              ]
                .filter(Boolean)
                .join(" · ") || " ",
            ),
          ),
          h("span", { class: "spacer" }),
          account.current ? h("span", { class: "tag ok" }, "已登录") : null,
        ),
        quotaBars(account.lastUsage) ||
          h(
            "p",
            { class: "sub" },
            account.current ? "额度读取中…" : "额度：在 AI 助手页切换到它后读取",
          ),
        h("div", { class: "row" }, h("span", { class: "spacer" }), remove),
      );
    }

    load();
  }

  /* ---------- Official API keys (any vendor) ---------- */
  const VENDORS = {
    openai: {
      title: "OpenAI 官方 API Key",
      placeholder: "sk-…",
      hint: "OpenAI 平台（platform.openai.com）的 Key，按用量计费。",
    },
    anthropic: {
      title: "Anthropic 官方 API Key / 订阅令牌",
      placeholder: "sk-ant-api… 或 sk-ant-oat…",
      hint: "console.anthropic.com 的 Key，或 claude setup-token 生成的订阅令牌。",
    },
    google: {
      title: "Google Gemini 官方 API Key",
      placeholder: "AIza…",
      hint: "Google AI Studio（aistudio.google.com）的 Key。",
    },
    xai: {
      title: "xAI 官方 API Key",
      placeholder: "xai-…",
      hint: "xAI 控制台（console.x.ai）的 Key，按用量计费。",
    },
  };
  const KEY_ERRORS = {
    RELAY_UNAUTHORIZED: "官方不接受这个 Key",
    RELAY_NETWORK: "暂时连不上官方接口",
    USAGE_NETWORK: "暂时连不上官方接口",
  };

  // One vendor's key: a card saying what it is (and whether it works), and a form to save one.
  function vendorKey(vendor, alive) {
    const spec = VENDORS[vendor];
    const element = h("div", { class: "claude-accounts key-block" });
    const form = h("div");
    const card = h("div");
    element.append(h("span", { class: "label" }, spec.title), form, card);

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
          put(form);
          load();
        }, loginFailed);
      key.addEventListener("keydown", (event) => {
        if (event.key === "Enter") save();
      });
      put(
        form,
        h(
          "div",
          { class: "claude-account add-key" },
          h("p", { class: "sub" }, `${spec.hint}加密保存在本机，只发给官方，界面上不会再显示。`),
          h(
            "div",
            { class: "row wide" },
            key,
            h("button", { class: "btn paper", type: "button", onclick: save }, "保存"),
            h("button", { class: "btn quiet", type: "button", onclick: () => put(form) }, "取消"),
          ),
        ),
      );
      key.focus();
    }

    async function load() {
      put(card, h("p", { class: "sub" }, "读取中…"));
      const result = await call("agents.officialKeys.info", { vendor }).catch(() => null);
      if (!alive()) return;
      const info = result && result.info;
      if (!info) {
        put(
          card,
          h(
            "div",
            { class: "claude-account empty-key" },
            h(
              "span",
              { class: "sub" },
              "还没保存。保存后，Pi、Hermes、OpenCode 等助手都能直接用它。",
            ),
            h("span", { class: "spacer" }),
            h("button", { class: "btn paper sm", type: "button", onclick: openForm }, "保存 Key"),
          ),
        );
        return;
      }
      const subscription = info.kind === "subscription";
      const masked = info.last4 ? `····${info.last4}` : info.keyMask || "";
      const facts = subscription
        ? [info.plan ? info.plan.toUpperCase() : null, info.organization, `令牌 ${masked}`]
        : [`Key ${masked}`, info.modelCount ? `${info.modelCount} 个模型` : null, "按用量计费"];
      const state =
        info.valid === true
          ? h("span", { class: "tag ok" }, "有效")
          : info.valid === false
            ? h("span", { class: "tag warn" }, "已失效")
            : h("span", { class: "tag" }, "未能验证");
      let confirmRemove = false;
      const remove = h(
        "button",
        {
          class: "btn quiet sm",
          type: "button",
          onclick: () => {
            if (!confirmRemove) {
              confirmRemove = true;
              remove.textContent = "确认删除";
              setTimeout(() => {
                confirmRemove = false;
                remove.textContent = "删除";
              }, 3000);
              return;
            }
            call("agents.officialKeys.remove", { vendor }).then(() => {
              toast("已删除这个 Key");
              load();
            }, failed);
          },
        },
        "删除",
      );
      put(
        card,
        h(
          "div",
          { class: "claude-account key-card" },
          h(
            "div",
            { class: "row" },
            h(
              "div",
              { class: "who" },
              h(
                "b",
                null,
                subscription
                  ? info.email || "Claude 订阅令牌"
                  : spec.title.replace(" / 订阅令牌", ""),
              ),
              h("span", null, facts.filter(Boolean).join(" · ")),
            ),
            h("span", { class: "spacer" }),
            state,
          ),
          subscription
            ? quotaBars(info.usage) ||
                h(
                  "p",
                  { class: "sub" },
                  info.usageHidden || info.profileHidden
                    ? "这是 claude setup-token 生成的令牌：只能调用模型，官方不允许它查询账号资料和额度。"
                    : "额度暂时读不到",
                )
            : h("p", { class: "sub" }, "普通 API Key 官方不提供余额查询，账单请到官方控制台查看。"),
          info.valid === false
            ? h("p", { class: "warn-text" }, "官方不接受这个 Key / 令牌了，请换一个新的。")
            : info.error && info.valid !== true
              ? h("p", { class: "sub" }, KEY_ERRORS[info.error] || explain(info.error))
              : null,
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn sm", type: "button", onclick: openForm }, "换一个"),
            h("span", { class: "spacer" }),
            remove,
          ),
        ),
      );
    }

    load();
    return { element, openForm };
  }

  /* ---------- Google · Gemini and xAI · Grok ---------- */
  function vendorTab(root, alive, options) {
    const { vendor, agentId, agentName, intro, webDesc, fileDesc, keyDesc } = options;
    const login = h("div", { class: "grid compact" });
    const keySection = vendorKey(vendor, alive);
    let agent = null;
    // Same three ways as Codex and Claude: web sign-in, a login file, an official API key.
    const webLogin = () => {
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
      h(
        "div",
        { class: "row page-head" },
        h("span", { class: "sub" }, intro),
        h("span", { class: "spacer" }),
        window.HubUI.menuButton(
          "+ 添加",
          [
            { icon: LOGIN_ICONS.web, title: "网页登录", desc: webDesc, onSelect: webLogin },
            {
              icon: LOGIN_ICONS.file,
              title: "导入登录文件",
              desc: fileDesc,
              onSelect: () =>
                pickFile((content) =>
                  call("agents.officialKeys.importFile", { vendor, content }).then(() => {
                    toast("已从文件导入 Key");
                    root.replaceChildren();
                    vendorTab(root, alive, options);
                  }, loginFailed),
                ),
            },
            {
              icon: LOGIN_ICONS.key,
              title: "官方 API Key",
              desc: keyDesc,
              onSelect: () => keySection.openForm(),
            },
          ],
          { align: "right" },
        ),
      ),
      login,
      keySection.element,
    );
    call("agents.list")
      .catch(() => null)
      .then((result) => {
        if (!alive()) return;
        agent = ((result && result.agents) || []).find((a) => a.id === agentId) || null;
        put(
          login,
          h(
            "section",
            { class: "m span-6 agent-login-card" },
            h(
              "div",
              { class: "row" },
              agent ? logo(agent) : null,
              h(
                "div",
                { class: "who" },
                h("b", null, `${agentName} 官方账号`),
                h(
                  "span",
                  null,
                  agent && agent.installed
                    ? `在 ${agentName} 自己的终端里登录，登录后它就用这个账号`
                    : `先在「AI 助手」页装好 ${agentName}，再在这里登录`,
                ),
              ),
              h("span", { class: "spacer" }),
              agent && agent.installed && agent.canOpenLogin
                ? h(
                    "button",
                    {
                      class: "btn paper sm",
                      type: "button",
                      onclick: () =>
                        call("agents.openLogin", { agent: agentId }).then(
                          (r) => toast(r.ok ? "已打开终端，按提示登录" : "没能打开终端"),
                          failed,
                        ),
                    },
                    "登录官方账号",
                  )
                : h(
                    "button",
                    { class: "btn sm", type: "button", onclick: () => go("agents") },
                    "去安装",
                  ),
            ),
          ),
        );
      });
  }

  const gemini = (root, alive) =>
    vendorTab(root, alive, {
      vendor: "google",
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
      agentId: "grok",
      agentName: "Grok",
      intro: "xAI 的官方助手 Grok 用 xAI 账号登录；xAI API Key 也能给 Pi、Hermes 等助手用。",
      webDesc: "用 Grok 在浏览器里登录 xAI 账号",
      fileDesc: "Sub2API 导出的 Grok 账号 JSON",
      keyDesc: "xAI 控制台的 Key（xai-…）",
    });
  const openaiKey = (root, alive) => {
    root.append(vendorKey("openai", alive).element);
  };

  return { claude, gemini, grok, openaiKey };
};
