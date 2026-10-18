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
    API_KEY_INVALID: "Key 格式不对，Anthropic 的 Key / 令牌以 sk-ant- 开头",
    AUTH_FILE_INVALID: "这个文件不是有效的 JSON",
    AUTH_FILE_NOT_A_LOGIN:
      "文件里没有 Claude 登录（支持 .credentials.json 和 Sub2API 导出的 Claude 账号）",
    RLY0_CORE_UNAVAILABLE: "后台服务还没准备好，请稍后再试",
    CLAUDE_IDENTITY_UNKNOWN: "还读不到这个账号是谁：在 Codex 里用一次 Claude Code 后再保存",
    CLAUDE_NOT_LOGGED_IN: "Claude Code 还没登录",
  };
  const loginFailed = (error) =>
    toast(LOGIN_ERRORS[error && error.message] || explain(error && error.message));

  // What to do in each agent's own terminal to sign in.
  const TERMINAL_LOGIN_STEPS = {
    pi: [
      "终端里会出现 Pi 的界面，底部有输入框。",
      "输入 /login 然后回车，选一个服务商（如 OpenAI、Anthropic），按提示在浏览器里登录或粘贴 API Key。",
      "看到登录成功后，按 Ctrl+C 两次退出，关闭窗口。",
      "回到 AI 助手页，“使用”里选「自己的登录」。",
    ],
    hermes: [
      "第一次运行 Hermes 会问「Help improve Hermes?」，直接按回车（不发送数据）。",
      "接着选择模型服务商（如 OpenRouter、OpenAI、Anthropic），按提示登录或粘贴 API Key，再选一个模型。",
      "完成后关闭窗口。",
      "回到 AI 助手页，“使用”里选「自己的登录」。",
    ],
    opencode: [
      "终端里会打开 OpenCode。",
      "输入 /connect（或 /login）回车，选服务商并登录。",
      "完成后关闭窗口，回到 AI 助手页选「自己的登录」。",
    ],
  };

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
    const keyCard = h("div", { class: "claude-accounts key-block" });
    const list = h("div", { class: "claude-accounts" });
    const form = h("div");
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
              title: "网页登录 Claude 账号",
              desc: "Pro / Max 账号，可以添加多个",
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
              title: "官方 API Key / 订阅令牌",
              desc: "sk-ant-api… 按量计费，或 claude setup-token 生成的 sk-ant-oat…",
              onSelect: () => keyForm(),
            },
          ],
          { align: "right" },
        ),
      ),
      form,
      keyCard,
      list,
    );

    function keyForm() {
      const key = h("input", {
        class: "input",
        type: "password",
        placeholder: "sk-ant-api… 或 sk-ant-oat…",
        autocomplete: "off",
        spellcheck: "false",
        "aria-label": "Anthropic API Key",
      });
      const save = () =>
        call("agents.claudeCode.setApiKey", { apiKey: key.value.trim() }).then(() => {
          toast("已保存，并让 Claude Code 用它（可在 AI 助手页改回账号）");
          put(form);
          load();
        }, loginFailed);
      key.addEventListener("keydown", (event) => {
        if (event.key === "Enter") save();
      });
      put(
        form,
        h(
          "section",
          { class: "m tone add-login" },
          h("b", null, "官方 API Key / 订阅令牌"),
          h(
            "p",
            { class: "sub" },
            "加密保存在本机，只发给 Anthropic 官方，界面上不会再显示。保存一个新的会替换旧的。",
          ),
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

    async function loadKey() {
      const result = await call("agents.claudeCode.keyInfo").catch(() => null);
      if (!alive()) return;
      const info = result && result.info;
      if (!info) {
        put(keyCard);
        return;
      }
      const subscription = info.kind === "subscription";
      const title = subscription ? info.email || "Claude 订阅令牌" : "Anthropic API Key";
      const facts = subscription
        ? [info.plan ? info.plan.toUpperCase() : null, info.organization, `令牌 ····${info.last4}`]
        : [`Key ····${info.last4}`, "按用量计费"];
      const state =
        info.valid === true
          ? h("span", { class: "tag ok" }, "有效")
          : info.valid === false
            ? h("span", { class: "tag warn" }, "已失效")
            : h("span", { class: "tag" }, "未能验证");
      put(
        keyCard,
        h("span", { class: "label" }, "官方 API Key / 订阅令牌"),
        h(
          "div",
          { class: "claude-account key-card" },
          h(
            "div",
            { class: "row" },
            h(
              "div",
              { class: "who" },
              h("b", null, title),
              h("span", null, facts.filter(Boolean).join(" · ")),
            ),
            h("span", { class: "spacer" }),
            state,
          ),
          subscription
            ? quotaBars(info.usage) || h("p", { class: "sub" }, "额度暂时读不到")
            : h(
                "p",
                { class: "sub" },
                "普通 API Key 官方不提供余额和用量查询，账单在 console.anthropic.com 查看。",
              ),
          info.valid === false
            ? h("p", { class: "warn-text" }, "Anthropic 不接受这个 Key / 令牌了，请换一个新的。")
            : null,
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn sm", type: "button", onclick: () => keyForm() }, "换一个"),
          ),
        ),
      );
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

    loadKey();
    load();
  }

  /* ---------- 其他助手 ---------- */
  function others(root, alive) {
    const grid = h("div", { class: "grid compact" });
    root.append(
      h(
        "div",
        { class: "row page-head" },
        h(
          "span",
          { class: "sub" },
          "这些助手在自己的终端里登录官方账号。也可以不登录，直接在「AI 助手」页选中转站。",
        ),
      ),
      grid,
    );
    call("agents.list")
      .catch(() => null)
      .then((result) => {
        if (!alive()) return;
        const agents = ((result && result.agents) || []).filter(
          (agent) => agent.id !== "claude-code" && agent.installed && agent.canOpenLogin,
        );
        put(
          grid,
          agents.length
            ? agents.map((agent) =>
                h(
                  "section",
                  { class: "m span-3 agent-login-card" },
                  h(
                    "div",
                    { class: "row" },
                    logo(agent),
                    h(
                      "div",
                      { class: "who" },
                      h("b", null, agent.name),
                      h("span", null, agent.vendor),
                    ),
                  ),
                  h(
                    "div",
                    { class: "row" },
                    h(
                      "button",
                      {
                        class: "btn paper sm",
                        type: "button",
                        onclick: () => terminalLogin(agent),
                      },
                      "登录官方账号",
                    ),
                    h("span", { class: "spacer" }),
                    h(
                      "button",
                      {
                        class: "btn quiet sm",
                        type: "button",
                        onclick: () => call("links.agentDocs", { agent: agent.id }).catch(failed),
                      },
                      "官方说明",
                    ),
                  ),
                ),
              )
            : h(
                "div",
                { class: "empty span-6" },
                "还没有装其他助手。",
                h(
                  "button",
                  { class: "btn sm", type: "button", onclick: () => go("agents") },
                  "去 AI 助手解锁",
                ),
              ),
        );
      });
  }

  function terminalLogin(agent) {
    const steps = TERMINAL_LOGIN_STEPS[agent.id] || [
      "在打开的终端窗口里按提示登录。",
      "登录完成后关闭终端窗口。",
    ];
    const ui = window.HubUI.dialog({
      title: `登录 ${agent.name} 官方账号`,
      sub: "会打开一个终端窗口，在里面完成登录",
    });
    put(
      ui.body,
      h(
        "ol",
        { class: "login-steps" },
        steps.map((step) => h("li", null, step)),
      ),
      h(
        "p",
        { class: "sub" },
        "更简单的办法：不用登录，在「AI 助手」页把“使用”选成零号中转或其他中转站。",
      ),
    );
    put(
      ui.foot,
      h("span", { class: "spacer" }),
      h("button", { class: "btn quiet", type: "button", onclick: () => ui.close() }, "取消"),
      h(
        "button",
        {
          class: "btn paper",
          type: "button",
          onclick: () => {
            ui.close();
            call("agents.openLogin", { agent: agent.id }).then(
              (r) => toast(r.ok ? "已打开终端，按说明登录" : "没能打开终端"),
              failed,
            );
          },
        },
        "打开终端",
      ),
    );
  }

  return { claude, others };
};
