"use strict";
// 首页: a 零号中转 banner on top (the screen's one brand-red module, with 阿零 hopping and data
// packets flying out), then Codex status and quota, account / proxy / AI agents, and relays.
window.registerHubHome = (api) => {
  const {
    pages,
    h,
    call,
    toast,
    failed,
    explain,
    svg,
    go,
    resetText,
    accountName,
    pollers,
    relayStrip,
    moneyBadge,
    rateBadge,
  } = api;
  const put = (element, ...items) =>
    element.replaceChildren(
      ...items
        .flat(Infinity)
        .filter((item) => item !== null && item !== undefined && item !== false),
    );
  const LOGOS = {
    "claude-code": "svg",
    antigravity: "svg",
    grok: "png",
    opencode: "png",
    pi: "svg",
    hermes: "png",
    "cursor-cli": "svg",
    "kiro-cli": "svg",
  };

  // Pixel scene for the banner: a pixel grid, twinkling pixels, an equalizer of "traffic" bars
  // and a pixel track that packets travel along. 阿零 (the official IP, moved only as a whole)
  // leans toward the pointer and hops with a pixel burst when clicked.
  function pixelScene() {
    const sparkles = h("div", { class: "px-sparkles", "aria-hidden": "true" });
    for (let i = 0; i < 26; i += 1) {
      const dot = h("i");
      dot.style.setProperty("left", `${Math.round(Math.random() * 100)}%`);
      dot.style.setProperty("top", `${Math.round(Math.random() * 100)}%`);
      dot.style.setProperty("animation-delay", `${(Math.random() * 3).toFixed(2)}s`);
      dot.style.setProperty("--s", `${[4, 4, 6, 8][i % 4]}px`);
      sparkles.append(dot);
    }
    const equalizer = h("div", { class: "px-eq", "aria-hidden": "true" });
    for (let i = 0; i < 40; i += 1) {
      const bar = h("i");
      bar.style.setProperty("animation-delay", `${(Math.random() * 1.6).toFixed(2)}s`);
      bar.style.setProperty("--h", `${6 + Math.round(Math.random() * 5) * 6}px`);
      equalizer.append(bar);
    }
    return [
      h("div", { class: "px-grid", "aria-hidden": "true" }),
      h("div", { class: "px-scan", "aria-hidden": "true" }),
      sparkles,
      equalizer,
    ];
  }

  function mascot() {
    const ip = h("img", { class: "mascot", src: "brand/rly0-ip-on-dark.svg", alt: "阿零" });
    const burst = h("div", { class: "px-burst", "aria-hidden": "true" });
    const stage = h(
      "button",
      { class: "mascot-stage", type: "button", "aria-label": "和阿零打个招呼" },
      h("span", { class: "mascot-halo", "aria-hidden": "true" }),
      h("span", { class: "mascot-pad", "aria-hidden": "true" }),
      ip,
      burst,
      h(
        "span",
        { class: "px-track", "aria-hidden": "true" },
        h("i", { class: "packet p1" }),
        h("i", { class: "packet p2" }),
        h("i", { class: "packet p3" }),
      ),
    );
    stage.addEventListener("click", () => {
      stage.classList.remove("jump");
      void stage.offsetWidth;
      stage.classList.add("jump");
      burst.replaceChildren();
      for (let i = 0; i < 14; i += 1) {
        const px = h("i");
        const angle = (Math.PI * 2 * i) / 14;
        px.style.setProperty(
          "--dx",
          `${Math.round(Math.cos(angle) * (46 + Math.random() * 26))}px`,
        );
        px.style.setProperty(
          "--dy",
          `${Math.round(Math.sin(angle) * (40 + Math.random() * 22)) - 18}px`,
        );
        burst.append(px);
      }
    });
    return stage;
  }

  // 阿零 leans toward the pointer while it is over the banner.
  function followPointer(banner) {
    banner.addEventListener("pointermove", (event) => {
      const box = banner.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      banner.style.setProperty("--lean-x", `${(x * 14).toFixed(1)}px`);
      banner.style.setProperty("--lean-r", `${(x * 8).toFixed(1)}deg`);
      banner.style.setProperty("--lean-y", `${(y * 6).toFixed(1)}px`);
      banner.style.setProperty("--mx", `${Math.round(event.clientX - box.left)}px`);
      banner.style.setProperty("--my", `${Math.round(event.clientY - box.top)}px`);
    });
    banner.addEventListener("pointerleave", () => {
      banner.style.setProperty("--lean-x", "0px");
      banner.style.setProperty("--lean-r", "0deg");
      banner.style.setProperty("--lean-y", "0px");
    });
  }

  // Module header: icon tile, a plain-language title and what the module answers.
  const ICONS = {
    work: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M12 15h5"/>',
    people:
      '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.6 3.4-5.4 6.5-5.4s5.5 1.8 6.5 5.4M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.5.8 2.5 2.5 3 5.2"/>',
    agents:
      '<rect x="3" y="3" width="8" height="8" rx="2.5"/><rect x="13" y="3" width="8" height="8" rx="2.5"/><rect x="3" y="13" width="8" height="8" rx="2.5"/><path d="M17 14v6M14 17h6"/>',
    route:
      '<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M7.5 6H15a3.5 3.5 0 0 1 0 7H9a3.5 3.5 0 0 0 0 7h7.5"/>',
  };
  const icon24 = (markup) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    element.setAttribute("viewBox", "0 0 24 24");
    element.setAttribute("aria-hidden", "true");
    element.innerHTML = markup; // fixed markup
    return element;
  };
  const modHead = (icon, title, hint, extra) =>
    h(
      "div",
      { class: "mod-head" },
      h("span", { class: "mod-icon" }, icon24(ICONS[icon])),
      h("div", { class: "mod-title" }, h("b", null, title), h("span", null, hint)),
      h("span", { class: "spacer" }),
      extra || null,
    );
  const agentLogo = (agent, size) =>
    h(
      "span",
      {
        class: `agent-logo ${agent.installed ? "" : "dim"}`,
        style: { width: `${size}px`, height: `${size}px` },
      },
      LOGOS[agent.id]
        ? h("img", { src: `agents/${agent.id}.${LOGOS[agent.id]}`, alt: agent.name })
        : agent.name.slice(0, 2),
    );
  const quotaTiles = (windows) =>
    h(
      "div",
      { class: "reset-cards" },
      windows.map((w) => {
        const left = Math.max(0, Math.round(100 - w.usedPercent));
        return h(
          "div",
          { class: `reset-card ${left <= 15 ? "low" : ""}` },
          h(
            "div",
            { class: "row" },
            h("span", { class: "reset-kind" }, w.kind === "primary" ? "5 小时额度" : "每周额度"),
            h("span", { class: "spacer" }),
            h("b", { class: "tabular" }, `剩 ${left}%`),
          ),
          h("div", { class: "bar" }, h("i", { style: { width: `${left}%` } })),
          h(
            "span",
            { class: "reset-when" },
            w.resetsAt
              ? `${api.countdown(w.resetsAt)}重置 · ${resetText(w.resetsAt)}`
              : "重置时间未知",
          ),
        );
      }),
    );

  pages.home = (root, alive) => {
    const promo = h("section", { class: "m promo span-6" });
    followPointer(promo);
    const work = h("section", { class: "m panel work span-4" });
    const people = h("section", { class: "m panel paper-panel span-2" });
    const agentsModule = h("section", { class: "m panel span-3" });
    const lines = h("section", { class: "m panel span-3" });
    root.append(h("div", { class: "grid home-grid" }, promo, work, people, agentsModule, lines));

    async function loadPromo() {
      const result = await call("balance.get").catch((error) => ({
        configured: true,
        ok: false,
        error: error.message,
      }));
      if (!alive()) return;
      const text = h(
        "div",
        { class: "promo-text" },
        h("span", { class: "label" }, "RLY/0 零号中转 · 作者自营"),
        h(
          "h2",
          null,
          "一个密钥，调用所有模型",
          h("span", { class: "px-cursor", "aria-hidden": "true" }),
        ),
        h("p", null, "Claude、GPT、Gemini、Grok，Codex 和各家 AI 助手都能直接用。"),
      );
      let side;
      if (!result.configured) {
        side = h(
          "div",
          { class: "promo-side" },
          h(
            "button",
            {
              class: "btn promo-cta",
              type: "button",
              onclick: () => go("relays", { preset: "rly0" }),
            },
            "接入零号",
          ),
          h(
            "button",
            {
              class: "btn ghost",
              type: "button",
              onclick: () => call("links.open", { target: "site" }).catch(failed),
            },
            "注册领 $3",
          ),
        );
      } else {
        side = h(
          "div",
          { class: "promo-side" },
          result.ok
            ? h(
                "div",
                { class: "promo-balance" },
                moneyBadge(result.balance, result.unit, "large"),
                typeof result.rate === "number" ? rateBadge(result.rate, "on-red") : null,
              )
            : h("p", { class: "promo-note" }, explain(result.error)),
          h(
            "button",
            {
              class: "btn promo-cta",
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
      put(promo, pixelScene(), mascot(), text, side);
    }

    async function load() {
      const [summary, agents, accounts] = await Promise.all([
        call("home.summary").catch(() => null),
        call("agents.list").catch(() => null),
        call("accounts.list").catch(() => null),
      ]);
      if (!alive()) return;
      renderWork(summary);
      renderPeople(summary, accounts);
      renderAgents(agents);
      renderLines(summary);
    }

    /* Codex 工作台: can I work now, as whom, and how much is left. */
    function renderWork(summary) {
      const codex = summary && summary.codex;
      const running = Boolean(codex && codex.running);
      const account = summary && summary.currentAccount;
      const quota = h("div", { class: "work-quota" });
      put(
        work,
        modHead(
          "work",
          "Codex 工作台",
          "现在能不能开工",
          h(
            "span",
            { class: `state-pill ${running ? "ok" : ""}` },
            h("span", { class: `pulse ${running ? "" : "off"}` }),
            running ? "运行中" : "未启动",
          ),
        ),
        h(
          "p",
          { class: "work-say" },
          running ? "Codex 正在运行，可以开工了。" : "Codex 还没打开，点下面一键启动。",
        ),
        account
          ? h(
              "div",
              { class: "work-account" },
              h("span", { class: "avatar" }, accountName(account).slice(0, 1).toUpperCase()),
              h(
                "div",
                { class: "who" },
                h("b", null, accountName(account)),
                h(
                  "span",
                  null,
                  [
                    account.plan ? account.plan.toUpperCase() : "当前登录",
                    account.saved ? null : "未保存",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ),
              ),
              h("span", { class: "spacer" }),
              h(
                "button",
                { class: "btn sm", type: "button", onclick: () => go("accounts") },
                "切换账号",
              ),
            )
          : h(
              "div",
              { class: "work-account" },
              h("span", { class: "sub" }, "Codex 还没登录账号。"),
              h("span", { class: "spacer" }),
              h(
                "button",
                { class: "btn sm", type: "button", onclick: () => go("accounts") },
                "去添加",
              ),
            ),
        quota,
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
      if (!account) return;
      put(quota, h("span", { class: "sub" }, "额度读取中…"));
      call("accounts.usageCurrent")
        .catch(() => null)
        .then((result) => {
          if (!alive()) return;
          const windows = result && result.available ? result.usage.windows : [];
          put(
            quota,
            windows.length ? quotaTiles(windows) : h("span", { class: "sub" }, "暂时读不到额度"),
          );
        });
    }

    /* 账号额度: which saved account still has room (the one light module). */
    function renderPeople(summary, result) {
      const accounts = (result && result.available && result.accounts) || [];
      const rows = accounts.slice(0, 4).map((account) => {
        const window5h = account.lastUsage
          ? account.lastUsage.windows.find((w) => w.kind === "primary")
          : null;
        const left = window5h ? Math.max(0, Math.round(100 - window5h.usedPercent)) : null;
        return h(
          "div",
          { class: `peek-row ${account.current ? "current" : ""}` },
          h(
            "div",
            { class: "row" },
            h("b", { class: "peek-name" }, accountName(account)),
            h("span", { class: "spacer" }),
            h(
              "span",
              { class: "peek-left tabular" },
              account.current ? "使用中 · " : "",
              left === null ? "未知" : `剩 ${left}%`,
            ),
          ),
          h("div", { class: "bar" }, h("i", { style: { width: `${left === null ? 0 : left}%` } })),
        );
      });
      put(
        people,
        modHead("people", "账号额度", "哪个账号还有余量"),
        rows.length
          ? h("div", { class: "peek-list" }, rows)
          : h("p", { class: "sub" }, "还没有保存的账号。保存后，这里能看到每个账号还剩多少。"),
        h(
          "div",
          { class: "row" },
          h("span", { class: "spacer" }),
          h(
            "button",
            { class: "btn sm", type: "button", onclick: () => go("accounts") },
            accounts.length > 4 ? `全部 ${accounts.length} 个账号` : "管理账号",
          ),
        ),
      );
    }

    /* AI 助手: which agents are ready to call from Codex. */
    function renderAgents(list) {
      const agents = (list && list.agents) || [];
      const installed = agents.filter((a) => a.installed);
      const locked = agents.length - installed.length;
      put(
        agentsModule,
        modHead(
          "agents",
          "AI 助手",
          "装好的都能在 Codex 里直接调用",
          h("span", { class: "count-pill tabular" }, `${installed.length} / ${agents.length}`),
        ),
        installed.length
          ? h(
              "div",
              { class: "chip-grid" },
              installed.map((agent) =>
                h(
                  "button",
                  { class: "agent-chip", type: "button", onclick: () => go("agents") },
                  agentLogo(agent, 32),
                  h(
                    "span",
                    { class: "who" },
                    h("b", null, agent.name),
                    h("span", null, agent.category === "official" ? "官方" : "第三方"),
                  ),
                ),
              ),
              locked
                ? h(
                    "button",
                    { class: "agent-chip more", type: "button", onclick: () => go("agents") },
                    h("span", { class: "more-plus" }, "+"),
                    h(
                      "span",
                      { class: "who" },
                      h("b", null, `${locked} 个可解锁`),
                      h("span", null, "去 AI 助手"),
                    ),
                  )
                : null,
            )
          : h(
              "div",
              { class: "empty-cta" },
              h(
                "div",
                { class: "logo-stack" },
                agents.slice(0, 4).map((agent) => agentLogo(agent, 32)),
              ),
              h("p", { class: "sub" }, "还没有装 AI 助手。滑动解锁一个，就能在 Codex 里让它帮忙。"),
              h(
                "button",
                { class: "btn paper sm", type: "button", onclick: () => go("agents") },
                "去解锁",
              ),
            ),
      );
    }

    /* 线路与余额: where requests go and whether the balance holds. */
    function renderLines(summary) {
      const proxy = summary && summary.proxy;
      const running = Boolean(proxy && proxy.running);
      const list = h("div", { class: "line-list" }, h("span", { class: "sub" }, "读取中…"));
      put(
        lines,
        modHead(
          "route",
          "线路与余额",
          "请求走哪条线，余额够不够",
          h(
            "span",
            {
              class: `state-pill ${running ? "ok" : ""}`,
              "data-tip": running ? `本地代理 127.0.0.1:${proxy.port}` : "有启用的中转站时自动开启",
            },
            h("span", { class: `pulse ${running ? "" : "off"}` }),
            running ? "代理在线" : "代理未开",
          ),
        ),
        list,
      );
      call("relay.list")
        .catch(() => null)
        .then((result) => {
          if (!alive()) return;
          const relays = ((result && result.relays) || []).filter(
            (r) => r.enabled && !api.isOfficialKey(r),
          );
          if (!relays.length) {
            put(
              list,
              h(
                "div",
                { class: "empty-cta" },
                h(
                  "p",
                  { class: "sub" },
                  "还没有接入中转站。接入零号后，Codex 和各家 AI 都能用一个密钥。",
                ),
                h(
                  "button",
                  {
                    class: "btn paper sm",
                    type: "button",
                    onclick: () => go("relays", { preset: "rly0" }),
                  },
                  "接入零号",
                ),
              ),
            );
            return;
          }
          put(
            list,
            relays.slice(0, 4).map((relay) => {
              const money = h("span", { class: "line-money sub" }, "…");
              call("relay.balance", { id: relay.id })
                .catch(() => null)
                .then((b) => {
                  if (!alive()) return;
                  if (b && b.available && b.ok)
                    put(
                      money,
                      moneyBadge(b.balance, b.unit),
                      typeof b.rate === "number" ? rateBadge(b.rate) : null,
                    );
                  else money.textContent = "余额未知";
                });
              return h(
                "button",
                { class: "line-row", type: "button", onclick: () => go("relays") },
                api.relayLogo(relay, 30),
                h(
                  "span",
                  { class: "who" },
                  h("b", null, relay.name),
                  h(
                    "span",
                    null,
                    relay.models.length ? `${relay.models.length} 个模型` : "全部模型",
                  ),
                ),
                h("span", { class: "spacer" }),
                money,
              );
            }),
          );
        });
    }

    loadPromo();
    load();
    const timer = setInterval(() => {
      if (!document.hidden) {
        load();
        loadPromo();
      }
    }, 60000);
    pollers.add(timer);
  };
};
