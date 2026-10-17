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
    });
    banner.addEventListener("pointerleave", () => {
      banner.style.setProperty("--lean-x", "0px");
      banner.style.setProperty("--lean-r", "0deg");
      banner.style.setProperty("--lean-y", "0px");
    });
  }

  pages.home = (root, alive) => {
    const promo = h("section", { class: "m promo span-6" });
    followPointer(promo);
    const codexModule = h("section", { class: "m codex span-4" });
    const quotaModule = h("section", { class: "m quota span-2" });
    const accountModule = h("section", { class: "m stat span-2" });
    const proxyModule = h("section", { class: "m tone stat span-2" });
    const agentsModule = h("section", { class: "m stat span-2" });
    root.append(
      h(
        "div",
        { class: "grid home-grid" },
        promo,
        codexModule,
        quotaModule,
        accountModule,
        proxyModule,
        agentsModule,
        relayStrip(alive),
      ),
    );

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
      const [summary, agents] = await Promise.all([
        call("home.summary").catch(() => null),
        call("agents.list").catch(() => null),
      ]);
      if (!alive()) return;
      renderCodex(summary, agents);
      renderAccount(summary);
      renderProxy(summary);
      renderAgents(agents);
      loadQuota(summary);
    }

    function renderCodex(summary, agents) {
      const codex = summary && summary.codex;
      const running = Boolean(codex && codex.running);
      const claude = agents && agents.agents.find((a) => a.id === "claude-code");
      put(
        codexModule,
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
            claude && claude.installed ? "Claude Code 已就绪" : "可在 AI 助手里解锁 Claude Code",
          ),
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

    async function loadQuota(summary) {
      const account = summary && summary.currentAccount;
      const label = h("span", { class: "label" }, "Codex · 5H 剩余");
      if (!account) {
        put(quotaModule, label, h("div", { class: "sub" }, "登录 Codex 后显示额度"));
        return;
      }
      put(quotaModule, label, h("div", { class: "sub" }, "读取中…"));
      const result = await call("accounts.usageCurrent").catch(() => null);
      if (!alive()) return;
      const window5h =
        result && result.available ? result.usage.windows.find((w) => w.kind === "primary") : null;
      if (!window5h) {
        put(quotaModule, label, h("div", { class: "sub" }, "暂时读不到额度"));
        return;
      }
      const left = Math.max(0, Math.round(100 - window5h.usedPercent));
      const length = 163.4;
      put(
        quotaModule,
        label,
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

    function renderAccount(summary) {
      const account = summary && summary.currentAccount;
      put(
        accountModule,
        h("span", { class: "label" }, "Account"),
        account
          ? h(
              "div",
              { class: "who" },
              h("b", null, accountName(account)),
              h("span", null, account.plan ? account.plan.toUpperCase() : "当前 Codex 登录"),
            )
          : h("div", { class: "sub" }, "Codex 还没登录"),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            { class: "btn sm", type: "button", onclick: () => go("accounts") },
            account ? "切换账号" : "去看看",
          ),
          account && !account.saved ? h("span", { class: "tag" }, "未保存") : null,
        ),
      );
    }

    function renderProxy(summary) {
      const proxy = summary && summary.proxy;
      const running = Boolean(proxy && proxy.running);
      put(
        proxyModule,
        h("span", { class: "label" }, "Proxy"),
        h(
          "div",
          { class: "num" },
          h("span", { class: `pulse ${running ? "" : "off"}` }),
          running ? "ONLINE" : "OFF",
        ),
        h(
          "span",
          { class: "sub tabular" },
          running ? `127.0.0.1:${proxy.port}` : "有启用的中转站时自动开启",
        ),
      );
    }

    function renderAgents(list) {
      const agents = (list && list.agents) || [];
      const installed = agents.filter((a) => a.installed);
      put(
        agentsModule,
        h("span", { class: "label" }, "AI agents"),
        h(
          "div",
          { class: "logo-stack" },
          (installed.length ? installed : agents.slice(0, 3)).slice(0, 5).map((agent) =>
            h(
              "span",
              {
                class: `agent-logo ${agent.installed ? "" : "dim"}`,
                style: { width: "36px", height: "36px" },
              },
              LOGOS[agent.id]
                ? h("img", { src: `agents/${agent.id}.${LOGOS[agent.id]}`, alt: agent.name })
                : agent.name.slice(0, 2),
            ),
          ),
        ),
        h(
          "div",
          { class: "row" },
          h("span", { class: "sub" }, `已解锁 ${installed.length} / ${agents.length}`),
          h("span", { class: "spacer" }),
          h("button", { class: "btn sm", type: "button", onclick: () => go("agents") }, "管理"),
        ),
      );
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
