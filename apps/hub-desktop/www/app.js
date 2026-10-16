"use strict";
// RLY/0 Hub window. Talks only to the bundled hub service through the WebView bridge; every
// method name below is checked again by the shell and by the service. Text from the service is
// always set as text, never as HTML.
(() => {
  const webview = window.chrome && window.chrome.webview;

  /* ---------- Bridge ---------- */
  const pending = new Map();
  let sequence = 0;
  let serviceReady = false;
  const queue = [];

  function post(message) {
    if (webview) webview.postMessage(message);
    else mockReply(message);
  }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = `w${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("TIMEOUT"));
      }, 180000);
      pending.set(id, { resolve, reject, timer });
      const message = { id, method, params: params || {} };
      if (serviceReady) post(message);
      else queue.push(message);
    });
  }

  function onMessage(data) {
    if (!data || typeof data !== "object") return;
    if (data.event === "ready") {
      if (!serviceReady) {
        serviceReady = true;
        queue.splice(0).forEach(post);
      }
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.error) {
      // The service restarted: hold new calls until the shell says it is ready again.
      if (data.error.message === "SERVICE_STARTING") serviceReady = false;
      entry.reject(new Error(String(data.error.message || "HUB_ERROR")));
    } else entry.resolve(data.result);
  }

  if (webview) webview.addEventListener("message", (event) => onMessage(event.data));

  /* ---------- DOM helpers ---------- */
  function h(tag, props, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") element.className = value;
      else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
      else if (key === "style")
        for (const [name, v] of Object.entries(value)) element.style.setProperty(name, v);
      else if (value === true) element.setAttribute(key, "");
      else element.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
  }
  const svg = (markup) => {
    const holder = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    holder.setAttribute("viewBox", "0 0 64 64");
    holder.setAttribute("aria-hidden", "true");
    holder.innerHTML = markup; // fixed markup only, never service data
    return holder;
  };

  const toastEl = document.getElementById("toast");
  let toastTimer;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2800);
  }

  const ERRORS = {
    RELAY_UNAUTHORIZED: "密钥无效或已过期",
    RELAY_NETWORK: "连不上中转站",
    RELAY_HTTP_ERROR: "中转站返回了错误",
    BALANCE_UNSUPPORTED: "这个中转站不支持查余额",
    RELAY_KEY_MISSING: "还没有填写密钥",
    SERVICE_STARTING: "后台正在启动，稍等几秒",
    TIMEOUT: "等太久了，稍后再试",
    INVALID_PARAMS: "填写的内容不对",
    RELAY_BASEURL_REJECTED: "地址格式不对",
    RELAY_NAME_REJECTED: "名称需要 1–40 个字",
    RELAY_KEY_REJECTED: "密钥里不能有空格",
  };
  const explain = (code) => ERRORS[code] || "操作没有成功";
  const failed = (error) => toast(explain(error && error.message));

  function money(value, unit) {
    if (typeof value !== "number") return "—";
    return `${unit === "CNY" ? "¥" : "$"}${value.toFixed(2)}`;
  }
  function resetText(seconds) {
    if (!seconds) return "";
    const date = new Date(seconds * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const sameDay = date.toDateString() === new Date().toDateString();
    return `${sameDay ? "" : `${date.getMonth() + 1}/${date.getDate()} `}${pad(date.getHours())}:${pad(date.getMinutes())} 重置`;
  }
  const accountName = (account) => account.alias || account.email || "Codex 账号";

  /* ---------- Navigation ---------- */
  const titles = {
    home: "首页",
    agents: "AI 助手",
    relays: "中转站",
    accounts: "Codex 账号",
    backup: "备份",
    settings: "设置",
  };
  const pageEl = document.getElementById("page");
  const titleEl = document.getElementById("title");
  let generation = 0;
  let current = "home";
  let refreshTimer;
  const pollers = new Set();

  function stopPollers() {
    for (const timer of pollers) clearInterval(timer);
    pollers.clear();
    clearInterval(refreshTimer);
  }

  function go(name, options) {
    current = name;
    stopPollers();
    const mine = ++generation;
    document.querySelectorAll(".rail button").forEach((button) => {
      button.classList.toggle("on", button.dataset.page === name);
      if (button.dataset.page === name) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    titleEl.textContent = titles[name];
    pageEl.replaceChildren();
    const alive = () => mine === generation;
    pages[name](pageEl, alive, options || {});
    pageEl.scrollTop = 0;
  }

  document
    .querySelectorAll(".rail button")
    .forEach((button) => button.addEventListener("click", () => go(button.dataset.page)));
  document
    .getElementById("ad")
    .addEventListener("click", () => call("links.open", { target: "site" }).catch(failed));

  /* ---------- Pages ---------- */
  const pages = {};

  pages.home = (root, alive) => {
    const codexModule = h("section", { class: "m codex span-4 rows-2" });
    const balanceModule = h(
      "section",
      { class: "m bal span-2 rows-2" },
      h("span", { class: "label" }, "RLY/0 Balance"),
      h("div", { class: "num" }, "…"),
    );
    const quotaModule = h(
      "section",
      { class: "m quota span-2" },
      h("span", { class: "label" }, "Codex · 5H"),
      h("div", { class: "sub" }, "读取中…"),
    );
    const proxyModule = h(
      "section",
      { class: "m tone stat span-2" },
      h("span", { class: "label" }, "Proxy"),
      h("div", { class: "num" }, "…"),
    );
    const accountModule = h(
      "section",
      { class: "m stat span-2" },
      h("span", { class: "label" }, "Account"),
      h("div", { class: "sub" }, "…"),
    );
    const agentRow = [
      h("section", { class: "m tone agent span-2" }),
      h("section", { class: "m tone agent span-2" }),
      h("section", { class: "m agent span-2" }),
    ];
    root.append(
      h(
        "div",
        { class: "grid" },
        codexModule,
        balanceModule,
        quotaModule,
        proxyModule,
        accountModule,
        agentRow,
      ),
    );

    async function load() {
      const [summary, agents] = await Promise.all([
        call("home.summary").catch(() => null),
        call("agents.list").catch(() => null),
      ]);
      if (!alive()) return;
      renderCodex(summary, agents);
      renderProxy(summary);
      renderAccount(summary);
      renderAgents(agents);
      loadQuota(summary);
    }

    function renderCodex(summary, agents) {
      const codex = summary && summary.codex;
      const running = Boolean(codex && codex.running);
      const claude = agents && agents.agents.find((agent) => agent.id === "claude-code");
      codexModule.classList.toggle("live", running);
      codexModule.replaceChildren(
        h(
          "div",
          { class: "row" },
          h("span", { class: `dot ${running ? "ok" : ""}` }),
          h("span", { class: "label" }, running ? "Codex · Online" : "Codex · Offline"),
        ),
        h(
          "h2",
          null,
          running ? "运行中" : "未启动",
          h(
            "span",
            null,
            claude && claude.installed
              ? "Claude Code 已就绪"
              : "可在 AI 助手里一键安装 Claude Code",
          ),
        ),
        h(
          "div",
          { class: "stack", "aria-hidden": "true" },
          [0, 1, 2, 3].map(() => h("i", null, h("b"))),
        ),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn paper",
              type: "button",
              disabled: codex && !codex.canOpen,
              onclick: () =>
                call("codex.open").then(
                  (r) => toast(r.ok ? "正在打开 Codex" : "没有找到 Codex 启动器"),
                  failed,
                ),
            },
            running ? "切到 Codex" : "打开 Codex",
          ),
          running
            ? h(
                "button",
                {
                  class: "btn",
                  type: "button",
                  onclick: () =>
                    call("codex.restart").then(
                      (r) => toast(r.ok ? "Codex 正在重启" : "重启没有成功"),
                      failed,
                    ),
                },
                "重启 Codex",
              )
            : null,
        ),
      );
    }

    function renderProxy(summary) {
      const proxy = summary && summary.proxy;
      const running = Boolean(proxy && proxy.running);
      proxyModule.replaceChildren(
        h("span", { class: "label" }, "Proxy"),
        h(
          "div",
          { class: "num" },
          h("span", { class: `pulse ${running ? "" : "off"}` }),
          running ? "ONLINE" : "OFF",
        ),
        h(
          "span",
          { class: "sub mono" },
          running ? `127.0.0.1:${proxy.port}` : "有启用的中转站时自动开启",
        ),
      );
    }

    function renderAccount(summary) {
      const account = summary && summary.currentAccount;
      accountModule.replaceChildren(
        h("span", { class: "label" }, "Account"),
        account
          ? h(
              "div",
              { class: "who" },
              h("b", null, accountName(account)),
              h("span", null, account.plan ? account.plan.toUpperCase() : "当前 Codex 登录"),
            )
          : h("div", { class: "sub" }, "还没有保存 Codex 账号"),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            { class: "btn sm", type: "button", onclick: () => go("accounts") },
            account ? "切换账号" : "去保存",
          ),
        ),
      );
    }

    function renderAgents(list) {
      const agents = (list && list.agents) || [];
      const claude = agents.find((agent) => agent.id === "claude-code");
      const installed = agents.filter((agent) => agent.installed && agent.id !== "claude-code");
      agentRow[0].replaceChildren(
        h("div", { class: "logo cc" }, "CC"),
        h(
          "div",
          { class: "who" },
          h("b", null, "Claude Code"),
          h("span", null, claude && claude.installed ? "已安装" : "未安装"),
        ),
        claude && claude.installed
          ? h("span", { class: "tag ok" }, "Ready")
          : h(
              "button",
              { class: "btn paper sm", type: "button", onclick: () => go("agents") },
              "安装",
            ),
      );
      const second = installed[0];
      agentRow[1].replaceChildren(
        h("div", { class: "logo" }, second ? second.name.slice(0, 2).toUpperCase() : "+"),
        h(
          "div",
          { class: "who" },
          h("b", null, second ? second.name : "国产 AI 助手"),
          h("span", null, second ? "已安装" : "Kimi、Qoder、CodeBuddy…"),
        ),
        h(
          "button",
          { class: "btn sm", type: "button", onclick: () => go("agents") },
          second ? "管理" : "看看",
        ),
      );
      agentRow[2].replaceChildren(
        h(
          "div",
          { class: "who" },
          h("b", null, "更多 AI"),
          h("span", null, `已装 ${agents.filter((a) => a.installed).length} 个`),
        ),
        h("span", { class: "num" }, String(agents.length)),
        h(
          "button",
          {
            class: "btn quiet",
            type: "button",
            "aria-label": "打开 AI 助手",
            onclick: () => go("agents"),
          },
          "→",
        ),
      );
    }

    async function loadQuota(summary) {
      const account = summary && summary.currentAccount;
      if (!account) {
        quotaModule.replaceChildren(
          h("span", { class: "label" }, "Codex · 5H"),
          h("div", { class: "sub" }, "保存账号后显示额度"),
        );
        return;
      }
      const result = await call("accounts.usage", { id: account.id }).catch(() => null);
      if (!alive()) return;
      const usage = result && result.available ? result.usage : account.lastUsage;
      const window5h = usage && usage.windows.find((w) => w.kind === "primary");
      if (!window5h) {
        quotaModule.replaceChildren(
          h("span", { class: "label" }, "Codex · 5H"),
          h("div", { class: "sub" }, "暂时读不到额度"),
        );
        return;
      }
      const left = Math.max(0, Math.round(100 - window5h.usedPercent));
      const length = 163.4;
      quotaModule.replaceChildren(
        h("span", { class: "label" }, "Codex · 5H 剩余"),
        h(
          "div",
          { class: "ring" },
          svg(
            `<circle cx="32" cy="32" r="26" fill="none" stroke="#D3D3CC" stroke-width="8"/><circle cx="32" cy="32" r="26" fill="none" stroke="#0D0D0B" stroke-width="8" stroke-linecap="round" stroke-dasharray="${((left / 100) * length).toFixed(1)} ${length}" transform="rotate(-90 32 32)"/>`,
          ),
          h(
            "div",
            null,
            h("div", { class: "num" }, `${left}%`),
            h("div", { class: "sub" }, resetText(window5h.resetsAt)),
          ),
        ),
      );
    }

    async function loadBalance() {
      const result = await call("balance.get").catch((error) => ({
        configured: true,
        ok: false,
        error: error.message,
      }));
      if (!alive()) return;
      if (!result.configured) {
        balanceModule.replaceChildren(
          h("span", { class: "label" }, "RLY/0 零号中转"),
          h("h3", null, "一个密钥，调用所有模型"),
          h(
            "div",
            { class: "row" },
            h(
              "button",
              { class: "btn", type: "button", onclick: () => go("relays", { preset: "rly0" }) },
              "接入零号",
            ),
            h(
              "button",
              {
                class: "btn ghost",
                type: "button",
                onclick: () => call("links.open", { target: "site" }).catch(failed),
              },
              "注册",
            ),
          ),
        );
        return;
      }
      balanceModule.replaceChildren(
        h("span", { class: "label" }, "RLY/0 Balance"),
        result.ok
          ? h(
              "div",
              null,
              h(
                "div",
                { class: "num" },
                h("small", null, result.unit === "CNY" ? "¥" : "$"),
                typeof result.balance === "number" ? result.balance.toFixed(2) : "—",
              ),
              h(
                "div",
                { class: "meta" },
                [
                  typeof result.todayCost === "number"
                    ? `今日 −${result.todayCost.toFixed(2)}`
                    : null,
                  typeof result.totalCost === "number"
                    ? `累计 ${result.totalCost.toFixed(2)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("  ·  "),
              ),
            )
          : h(
              "div",
              null,
              h("div", { class: "num" }, "—"),
              h("div", { class: "meta" }, explain(result.error)),
            ),
        h(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () =>
              call("links.open", { target: "recharge" }).then(
                () => toast("已在浏览器打开充值页"),
                failed,
              ),
          },
          "充值",
        ),
      );
    }

    load();
    loadBalance();
    refreshTimer = setInterval(() => {
      if (!document.hidden) {
        load();
        loadBalance();
      }
    }, 60000);
  };

  const STEP = {
    installingNode: "正在安装 Node.js",
    installingGit: "正在安装 Git",
    officialInstaller: "正在用官方安装器安装",
    npm: "正在通过 npm 安装",
    npmMirror: "正在通过国内镜像安装",
  };
  const INSTALL_ERRORS = {
    NETWORK: "网络不通，换个网络或开代理再试",
    PERMISSION: "没有权限，试试以管理员身份运行",
    NODE_MISSING: "缺少 Node.js",
    GIT_MISSING: "缺少 Git",
    MANUAL: "需要手动安装",
    UNSUPPORTED: "暂不支持自动安装",
  };

  pages.agents = (root, alive) => {
    const claudeModule = h(
      "section",
      { class: "m tone span-6" },
      h("span", { class: "label" }, "Claude Code"),
      h("div", { class: "sub" }, "读取中…"),
    );
    const list = h("div", { class: "grid compact" });
    root.append(
      h("div", { class: "grid compact" }, claudeModule),
      h("h2", { class: "section-title" }, "全部 AI 助手"),
      list,
    );

    async function loadClaude() {
      const [status, relays, selection] = await Promise.all([
        call("agents.claudeCode.status").catch(() => null),
        call("relay.list").catch(() => null),
        call("agents.relays.get").catch(() => ({ claudeCode: null })),
      ]);
      if (!alive()) return;
      if (!status || !status.installed) {
        claudeModule.replaceChildren(
          h("span", { class: "label" }, "Claude Code"),
          h("div", { class: "sub" }, "还没安装，在下面一键安装。"),
        );
        return;
      }
      const choices = ((relays && relays.relays) || []).filter((relay) => relay.hasKey);
      const select = h(
        "select",
        {
          class: "input",
          "aria-label": "Claude Code 运行方式",
          onchange: () =>
            call("agents.relays.set", { claudeCode: select.value || null }).then(
              () => toast("已保存，Codex 里新开的 Claude Code 对话生效"),
              failed,
            ),
        },
        h("option", { value: "" }, "用自己的 Claude 账号"),
        choices.map((relay) =>
          h(
            "option",
            { value: relay.id, selected: selection.claudeCode === relay.id },
            `通过中转：${relay.name}`,
          ),
        ),
      );
      claudeModule.replaceChildren(
        h(
          "div",
          { class: "row" },
          h("div", { class: "logo cc" }, "CC"),
          h(
            "div",
            { class: "who" },
            h("b", null, "Claude Code"),
            h(
              "span",
              null,
              status.loggedIn
                ? `已登录 ${status.email || ""}${status.plan ? ` · ${status.plan}` : ""}`
                : "未登录",
            ),
          ),
          h(
            "span",
            { class: `tag ${status.loggedIn || selection.claudeCode ? "ok" : ""}` },
            status.loggedIn || selection.claudeCode ? "Ready" : "Sign in",
          ),
        ),
        h(
          "div",
          { class: "form" },
          h("label", { class: "field" }, h("span", null, "运行方式"), select),
          h(
            "div",
            { class: "field" },
            h("span", null, "账号"),
            h(
              "div",
              { class: "row" },
              status.loggedIn
                ? h(
                    "button",
                    {
                      class: "btn",
                      type: "button",
                      onclick: () =>
                        call("agents.claudeCode.logout").then(() => {
                          toast("已退出登录");
                          loadClaude();
                        }, failed),
                    },
                    "退出登录",
                  )
                : [
                    h(
                      "button",
                      { class: "btn paper", type: "button", onclick: () => login("claudeai") },
                      "用 Claude 账号登录",
                    ),
                    h(
                      "button",
                      { class: "btn", type: "button", onclick: () => login("console") },
                      "用 API Console 登录",
                    ),
                  ],
            ),
          ),
        ),
      );
    }
    async function login(mode) {
      const result = await call("agents.claudeCode.login", { mode }).catch(() => null);
      toast(result && result.started ? "已在浏览器打开登录页，完成后回到这里" : "没能开始登录");
      const timer = setInterval(async () => {
        const status = await call("agents.claudeCode.status").catch(() => null);
        if (status && status.loggedIn) {
          clearInterval(timer);
          pollers.delete(timer);
          if (alive()) loadClaude();
        }
      }, 3000);
      pollers.add(timer);
    }

    async function loadList() {
      const result = await call("agents.list").catch(() => null);
      if (!alive()) return;
      list.replaceChildren(...((result && result.agents) || []).map(agentCard));
    }
    function agentCard(agent) {
      const card = h("section", { class: "m agent span-3" });
      const progress = h("div");
      function draw(status) {
        const running = status && status.state === "running";
        let action;
        if (agent.installed)
          action = agent.canOpenLogin
            ? h(
                "button",
                {
                  class: "btn sm",
                  type: "button",
                  onclick: () =>
                    call("agents.openLogin", { agent: agent.id }).then(
                      (r) => toast(r.ok ? "已打开终端，按提示登录或设置" : "没能打开终端"),
                      failed,
                    ),
                },
                "登录 / 设置",
              )
            : h("span", { class: "tag ok" }, "已安装");
        else if (!agent.automatic) action = h("span", { class: "tag" }, "需手动安装");
        else
          action = h(
            "button",
            { class: "btn paper sm", type: "button", disabled: running, onclick: () => install() },
            running ? "安装中…" : "一键安装",
          );
        card.replaceChildren(
          h(
            "div",
            { class: "logo" },
            agent.id === "claude-code" ? "CC" : agent.name.slice(0, 2).toUpperCase(),
          ),
          h(
            "div",
            { class: "who" },
            h("b", null, agent.name),
            h(
              "span",
              null,
              running
                ? STEP[status.step] || "安装中"
                : status && status.state === "failed"
                  ? INSTALL_ERRORS[status.error] || "安装没有成功"
                  : status && status.state === "succeeded"
                    ? "装好了"
                    : agent.installed
                      ? "已安装"
                      : agent.installed === null
                        ? "桌面应用"
                        : "未安装",
            ),
          ),
          action,
        );
        if (agent.id === "claude-code") card.classList.add("tone");
        card.append(progress);
      }
      async function install() {
        draw(
          await call("agents.installStart", { agent: agent.id }).catch(() => ({
            state: "failed",
            error: "FAILED",
          })),
        );
        const timer = setInterval(async () => {
          const status = await call("agents.installStatus", { agent: agent.id }).catch(() => null);
          if (!alive() || !status) return;
          if (status.state !== "running") {
            clearInterval(timer);
            pollers.delete(timer);
            if (status.state === "succeeded") {
              toast(`${agent.name} 装好了`);
              agent.installed = true;
              loadClaude();
            }
          }
          draw(status);
        }, 1500);
        pollers.add(timer);
      }
      draw(null);
      call("agents.installStatus", { agent: agent.id }).then(
        (status) => {
          if (alive() && status.state === "running") {
            draw(status);
          }
        },
        () => undefined,
      );
      return card;
    }

    loadClaude();
    loadList();
  };

  pages.relays = (root, alive, options) => {
    const list = h("div", { class: "grid compact" });
    const proxyModule = h("section", { class: "m tone span-6 agent" });
    const name = h("input", { class: "input", maxlength: "40", placeholder: "比如 零号中转" });
    const baseUrl = h("input", {
      class: "input",
      placeholder: "https://api.rly0.com/v1",
      spellcheck: "false",
    });
    const apiKey = h("input", {
      class: "input",
      type: "password",
      placeholder: "sk-…",
      autocomplete: "off",
      spellcheck: "false",
    });
    const fillRly0 = () => {
      name.value = "零号中转";
      baseUrl.value = "https://api.rly0.com/v1";
      apiKey.focus();
    };
    const form = h(
      "section",
      { class: "m span-6" },
      h(
        "div",
        { class: "row" },
        h("span", { class: "label" }, "Add relay"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn sm", type: "button", onclick: fillRly0 }, "填入零号中转"),
      ),
      h(
        "div",
        { class: "form" },
        h("label", { class: "field" }, h("span", null, "名称"), name),
        h("label", { class: "field" }, h("span", null, "地址"), baseUrl),
        h("label", { class: "field" }, h("span", null, "密钥"), apiKey),
        h(
          "div",
          { class: "field" },
          h("span", null, " "),
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn paper", type: "button", onclick: add }, "添加"),
          ),
        ),
      ),
    );
    root.append(
      h("div", { class: "grid compact" }, proxyModule),
      h("h2", { class: "section-title" }, "我的中转站"),
      list,
      h("h2", { class: "section-title" }, "添加"),
      h("div", { class: "grid compact" }, form),
    );
    if (options.preset === "rly0") fillRly0();

    async function add() {
      const params = { name: name.value.trim(), baseUrl: baseUrl.value.trim() };
      if (apiKey.value.trim()) params.apiKey = apiKey.value.trim();
      if (!params.name || !params.baseUrl) {
        toast("名称和地址都要填");
        return;
      }
      try {
        const result = await call("relay.add", params);
        if (!result.available) throw new Error("HUB_ERROR");
        apiKey.value = "";
        name.value = "";
        baseUrl.value = "";
        toast("已添加");
        load();
      } catch (error) {
        failed(error);
      }
    }

    async function load() {
      const [relays, proxy] = await Promise.all([
        call("relay.list").catch(() => null),
        call("proxy.status").catch(() => null),
      ]);
      if (!alive()) return;
      const running = Boolean(proxy && proxy.running);
      proxyModule.replaceChildren(
        h("span", { class: `pulse ${running ? "" : "off"}` }),
        h(
          "div",
          { class: "who" },
          h("b", null, running ? "本地代理运行中" : "本地代理未开启"),
          h(
            "span",
            { class: "mono" },
            running ? `127.0.0.1:${proxy.port}` : "AI 助手通过它使用中转站",
          ),
        ),
        h(
          "button",
          {
            class: "btn sm",
            type: "button",
            onclick: () => call(running ? "proxy.stop" : "proxy.start").then(load, failed),
          },
          running ? "停止" : "开启",
        ),
      );
      const items = (relays && relays.relays) || [];
      list.replaceChildren(
        ...(items.length
          ? items.map(relayCard)
          : [h("p", { class: "empty span-6" }, "还没有中转站。")]),
      );
    }

    function relayCard(relay) {
      const result = h("div", { class: "sub" });
      const toggle = h("button", {
        class: "switch",
        type: "button",
        role: "switch",
        "aria-checked": String(relay.enabled),
        "aria-label": "启用",
        onclick: () =>
          call("relay.setEnabled", { id: relay.id, enabled: !relay.enabled }).then(load, failed),
      });
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
            call("relay.remove", { id: relay.id }).then(() => {
              toast("已删除");
              load();
            }, failed);
          },
        },
        "删除",
      );
      const card = h(
        "section",
        { class: "m span-3" },
        h(
          "div",
          { class: "row" },
          h("span", { class: `dot ${relay.enabled ? "ok" : ""}` }),
          h("b", null, relay.name),
          h("span", { class: "spacer" }),
          toggle,
        ),
        h("div", { class: "sub mono" }, relay.baseUrl),
        h(
          "div",
          { class: "sub" },
          relay.hasKey ? `密钥 ${relay.keyMask || "已保存"}` : "未填写密钥",
        ),
        result,
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn sm",
              type: "button",
              onclick: async () => {
                result.textContent = "测试中…";
                const t = await call("relay.test", { id: relay.id }).catch(() => null);
                if (!alive()) return;
                result.textContent =
                  t && t.available
                    ? t.ok
                      ? `连通 · ${t.latencyMs} ms${t.modelCount ? ` · ${t.modelCount} 个模型` : ""}`
                      : explain(t.error)
                    : "测试没有成功";
              },
            },
            "测试",
          ),
          h(
            "button",
            {
              class: "btn sm",
              type: "button",
              onclick: async () => {
                result.textContent = "查询中…";
                const b = await call("relay.balance", { id: relay.id }).catch(() => null);
                if (!alive()) return;
                result.textContent =
                  b && b.available
                    ? b.ok
                      ? `余额 ${money(b.balance, b.unit)}`
                      : explain(b.error)
                    : "查询没有成功";
              },
            },
            "余额",
          ),
          h("span", { class: "spacer" }),
          remove,
        ),
      );
      return card;
    }
    load();
  };

  pages.accounts = (root, alive) => {
    const list = h("div", { class: "grid compact" });
    const head = h(
      "div",
      { class: "row" },
      h("span", { class: "sub" }, "保存多个 Codex 登录，一键切换。"),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn paper",
          type: "button",
          onclick: () =>
            call("accounts.importCurrent", {}).then((r) => {
              toast(r.available ? "已保存当前登录" : "没有找到当前登录");
              load();
            }, failed),
        },
        "保存当前登录",
      ),
    );
    root.append(head, h("div", { style: { height: "16px" } }), list);

    async function load() {
      const result = await call("accounts.list").catch(() => null);
      if (!alive()) return;
      const accounts = (result && result.available && result.accounts) || [];
      list.replaceChildren(
        ...(accounts.length
          ? accounts.map(card)
          : [
              h(
                "p",
                { class: "empty span-6" },
                "还没有保存的账号。先在 Codex 里登录，再点“保存当前登录”。",
              ),
            ]),
      );
    }
    function usageBars(usage) {
      if (!usage) return h("div", { class: "sub" }, "额度未知");
      return usage.windows.map((w) =>
        h(
          "div",
          { class: "field" },
          h(
            "span",
            null,
            `${w.kind === "primary" ? "5 小时" : "每周"} · 已用 ${Math.round(w.usedPercent)}%${w.resetsAt ? ` · ${resetText(w.resetsAt)}` : ""}`,
          ),
          h(
            "div",
            { class: "bar" },
            h("i", { style: { width: `${Math.min(100, w.usedPercent)}%` } }),
          ),
        ),
      );
    }
    function card(account) {
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
            call("accounts.remove", { id: account.id }).then(() => {
              toast("已删除");
              load();
            }, failed);
          },
        },
        "删除",
      );
      return h(
        "section",
        { class: `m span-3 ${account.current ? "tone" : ""}` },
        h(
          "div",
          { class: "row" },
          h("span", { class: `dot ${account.current ? "ok" : ""}` }),
          h(
            "div",
            { class: "who" },
            h("b", null, accountName(account)),
            h(
              "span",
              null,
              [
                account.email && account.alias ? account.email : null,
                account.plan ? account.plan.toUpperCase() : null,
              ]
                .filter(Boolean)
                .join(" · ") || " ",
            ),
          ),
          account.current ? h("span", { class: "tag ok" }, "Current") : null,
        ),
        usageBars(account.lastUsage),
        h(
          "div",
          { class: "row" },
          account.current
            ? null
            : h(
                "button",
                {
                  class: "btn paper sm",
                  type: "button",
                  onclick: async () => {
                    const r = await call("accounts.switch", { id: account.id }).catch(() => null);
                    if (!r || !r.switched) {
                      toast("切换没有成功");
                      return;
                    }
                    const codex = await call("codex.status").catch(() => null);
                    if (codex && codex.running) {
                      toast("已切换，正在重启 Codex 生效");
                      call("codex.restart").catch(failed);
                    } else toast("已切换，下次打开 Codex 生效");
                    load();
                  },
                },
                "切换到这个",
              ),
          h("span", { class: "spacer" }),
          remove,
        ),
      );
    }
    load();
    call("accounts.usageAll").then(
      () => {
        if (alive()) load();
      },
      () => undefined,
    );
  };

  pages.backup = (root, alive) => {
    const module = h("section", { class: "m span-6" }, h("div", { class: "sub" }, "读取中…"));
    root.append(h("div", { class: "grid compact" }, module));
    async function load() {
      const status = await call("backup.status").catch(() => null);
      if (!alive()) return;
      if (!status || !status.available) {
        module.replaceChildren(
          h("span", { class: "label" }, "Backup"),
          h("p", null, "还没有备份。第一次启动时会自动备份 Codex 的配置。"),
        );
        return;
      }
      let armed = false;
      const restore = h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: async () => {
            if (!armed) {
              armed = true;
              restore.textContent = "确认恢复";
              restore.classList.add("red");
              setTimeout(() => {
                armed = false;
                restore.textContent = "恢复到安装前";
                restore.classList.remove("red");
              }, 4000);
              return;
            }
            const result = await call("backup.restore").catch(() => null);
            toast(result && result.ok ? "已恢复。重启 Codex 后生效" : "恢复没有成功");
            load();
          },
        },
        "恢复到安装前",
      );
      module.replaceChildren(
        h("span", { class: "label" }, "Backup"),
        h(
          "h3",
          null,
          status.createdAt
            ? `安装前的 Codex 配置 · ${new Date(status.createdAt * 1000).toLocaleString("zh-CN")}`
            : "安装前的 Codex 配置",
        ),
        h(
          "div",
          { class: "row" },
          (status.files || []).map((file) =>
            h("span", { class: "tag" }, file.existed ? file.name : `${file.name}（原本没有）`),
          ),
        ),
        h("div", { class: "row" }, restore),
      );
    }
    load();
  };

  pages.settings = (root, alive) => {
    const autostart = h("section", { class: "m tone agent span-3" });
    const about = h(
      "section",
      { class: "m agent span-3" },
      h("img", { src: "brand/rly0-ip-on-dark.svg", alt: "", width: "44", height: "44" }),
      h("div", { class: "who" }, h("b", null, "RLY/0 Hub"), h("span", null, "零号中转出品 · 开源")),
      h(
        "button",
        {
          class: "btn sm",
          type: "button",
          onclick: () => call("links.open", { target: "site" }).catch(failed),
        },
        "rly0.com",
      ),
    );
    root.append(h("div", { class: "grid compact" }, autostart, about));
    async function load() {
      const status = await call("autostart.get").catch(() => null);
      if (!alive()) return;
      const supported = Boolean(status && status.supported);
      const enabled = Boolean(status && status.enabled);
      autostart.replaceChildren(
        h(
          "div",
          { class: "who" },
          h("b", null, "开机自动启动"),
          h("span", null, supported ? "开机后在托盘待命，不弹窗口" : "这个版本不支持"),
        ),
        h("button", {
          class: "switch",
          type: "button",
          role: "switch",
          "aria-checked": String(enabled),
          "aria-label": "开机自动启动",
          disabled: !supported,
          onclick: () => call("autostart.set", { enabled: !enabled }).then(load, failed),
        }),
      );
    }
    load();
  };

  /* ---------- Preview without the shell ---------- */
  function mockReply(message) {
    const data = {
      "home.summary": {
        codex: { running: true, canOpen: true },
        proxy: { available: true, running: true, port: 25917 },
        zeroRelay: { id: "aaaaaaaaaaaa", name: "零号中转", hasKey: true },
        currentAccount: {
          id: "0123456789ab",
          email: "me@example.com",
          plan: "plus",
          current: true,
        },
      },
      "agents.list": {
        agents: [
          {
            id: "claude-code",
            name: "Claude Code",
            installed: true,
            automatic: true,
            canOpenLogin: true,
          },
          {
            id: "kimi-code",
            name: "Kimi Code",
            installed: false,
            automatic: true,
            canOpenLogin: true,
          },
          {
            id: "qoder-cn",
            name: "Qoder 国内版",
            installed: true,
            automatic: true,
            canOpenLogin: true,
          },
          {
            id: "workbuddy",
            name: "WorkBuddy",
            installed: null,
            automatic: false,
            canOpenLogin: false,
          },
        ],
      },
      "balance.get": {
        configured: true,
        available: true,
        ok: true,
        valid: true,
        balance: 86.4,
        unit: "CNY",
        todayCost: 3.12,
        totalCost: 214.6,
      },
      "accounts.usage": {
        available: true,
        usage: {
          windows: [
            { kind: "primary", usedPercent: 36, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
          ],
          source: "live",
        },
      },
      "accounts.list": {
        available: true,
        accounts: [
          {
            id: "0123456789ab",
            email: "me@example.com",
            plan: "plus",
            current: true,
            lastUsage: {
              windows: [
                { kind: "primary", usedPercent: 36 },
                { kind: "secondary", usedPercent: 12 },
              ],
              source: "snapshot",
            },
          },
        ],
      },
      "relay.list": {
        available: true,
        relays: [
          {
            id: "aaaaaaaaaaaa",
            name: "零号中转",
            baseUrl: "https://api.rly0.com/v1",
            protocol: "responses",
            models: [],
            enabled: true,
            hasKey: true,
            keyMask: "****9Zq1",
            addedAt: "",
            updatedAt: "",
          },
        ],
      },
      "proxy.status": { available: true, running: true, port: 25917 },
      "agents.claudeCode.status": { installed: true, loggedIn: false },
      "agents.relays.get": { claudeCode: "aaaaaaaaaaaa" },
      "agents.installStatus": { state: "idle", automatic: true },
      "backup.status": {
        available: true,
        codexHome: "C:/Users/me/.codex",
        createdAt: 1792150000,
        files: [
          { name: "config.toml", existed: true },
          { name: "AGENTS.md", existed: false },
        ],
      },
      "autostart.get": { supported: true, enabled: true },
    };
    setTimeout(
      () => onMessage({ id: message.id, result: data[message.method] || { ok: true } }),
      120,
    );
  }

  if (!webview) onMessage({ event: "ready" });
  go("home");
})();
