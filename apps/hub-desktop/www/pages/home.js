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

  // 阿零 drawn inline so the eyes can move (blink, follow the pointer, smile). Same artwork as
  // brand/rly0-ip-on-dark.svg, with the eyes as their own layer over a solid body.
  const IP_MARKUP =
    '<g class="ip-led"><polygon fill="#321D1A" points="208.019,67.971 192.122,67.973 192.105,55.416 208.058,55.401"/><polygon fill="#7B2D21" points="206.926,67.971 192.121,67.973 192.105,55.416 206.963,55.401"/><polygon fill="#FE4C2E" points="205.192,67.971 192.119,67.973 192.105,55.416 205.224,55.401"/></g><g class="ip-body"><path fill="#E8E7E2" d="M140.209,185.084l-30.428-0.008l-0.014,4.978l4.053,0.027l-0.028,4.518l-10.271-0.038l0.007-9.484 l-16.996,0.004c-6.357-0.246-12.022-3.784-14.713-9.534c-3.168-6.77-1.165-14.588,4.593-19.223l-2.956-0.067 c-5.411-0.124-10.487-2.147-14.089-6.106c-7.474-8.214-5.697-20.863,3.513-26.869c-3.856-1.014-7.058-2.929-9.575-5.786 c-6.502-7.378-5.79-18.433,1.547-24.976c3.31-2.952,7.433-4.695,11.94-4.749l10.335-0.122c-7.811-4.262-11.087-13.515-7-21.504 c2.703-5.285,8.238-8.987,14.383-8.988l80.908-0.001c6.793,0,12.823,4.433,15.167,10.611c2.943,7.757-0.546,16.026-7.763,19.897 l10.056,0.092c5.292,0.049,10.198,2.277,13.716,6.208c4.243,4.741,5.657,11.227,3.658,17.3 c-1.992,6.051-6.925,10.425-13.151,12.013c4.824,3.135,7.898,8.411,8.162,14.081c0.275,5.911-2.371,11.488-7.146,15.086 c-3.245,2.46-7.03,3.698-11.122,3.805l-3.394,0.089c7.849,6.304,8.138,17.935,0.511,24.586c-3.122,2.722-7.028,4.154-11.271,4.154 l-16.344-0.001l-0.023,4.96l4.065,0.058l-0.048,4.477l-10.247,0L140.209,185.084z"/></g><g class="ip-eyes"><path class="ip-eye" fill="#0D0D0B" d="M140.566,114.217c0.007,2.726-2.473,4.448-4.817,4.537c-2.526,0.097-5.218-1.667-5.212-4.358l0.015-6.161 c0.006-2.583,2.573-4.248,4.945-4.263c2.447-0.015,5.046,1.728,5.053,4.363L140.566,114.217z"/><path class="ip-eye" fill="#0D0D0B" d="M119.493,114.179c-0.004,2.726-2.434,4.492-4.818,4.579c-2.514,0.092-5.224-1.66-5.218-4.365l0.014-6.158 c0.006-2.677,2.713-4.352,5.2-4.255c2.427,0.095,4.833,1.934,4.83,4.577L119.493,114.179z"/></g><g class="ip-happy"><path d="M109.8 114 Q114.6 106.5 119.4 114"/><path d="M130.8 114 Q135.6 106.5 140.4 114"/></g>';

  function mascot() {
    const ns = "http://www.w3.org/2000/svg";
    const art = document.createElementNS(ns, "svg");
    // Cropped to the character (see brand/rly0-ip-tight.svg) so it fills its area.
    art.setAttribute("viewBox", "45.67 42.21 165.57 165.57");
    art.setAttribute("class", "mascot-art");
    art.setAttribute("role", "img");
    art.setAttribute("aria-label", "阿零");
    art.innerHTML = IP_MARKUP; // fixed markup
    const burst = h("div", { class: "px-burst", "aria-hidden": "true" });
    const stage = h(
      "button",
      { class: "mascot-stage", type: "button", "aria-label": "和阿零打个招呼" },
      h("span", { class: "mascot-halo", "aria-hidden": "true" }),
      h("span", { class: "mascot-floor", "aria-hidden": "true" }),
      art,
      burst,
    );

    // Every few seconds the eyes put on a little show: blinks most often, and now and then a
    // big exaggerated act (darting, popping wide, rolling, going cross-eyed, dozing off…).
    const ACTS = [
      ["blink", 260, 26],
      ["blink2", 560, 12],
      ["dart", 1500, 10],
      ["pop", 1400, 10],
      ["roll", 1300, 9],
      ["jelly", 950, 9],
      ["cross", 1500, 8],
      ["sleepy", 2600, 7],
      ["squint", 1100, 9],
    ];
    const ACT_CLASSES = ACTS.map(([name]) => `act-${name}`);
    let actTimer = 0;
    let busy = false;
    const play = (name, duration) => {
      art.classList.remove(...ACT_CLASSES, "happy");
      void art.getBoundingClientRect();
      art.classList.add(`act-${name}`);
      busy = true;
      setTimeout(() => {
        art.classList.remove(`act-${name}`);
        busy = false;
      }, duration);
    };
    let last = "";
    const nextAct = () => {
      if (!stage.isConnected) return;
      if (!busy && !document.hidden) {
        const pool = ACTS.filter(([name]) => name !== last || name === "blink");
        let roll = Math.random() * pool.reduce((sum, act) => sum + act[2], 0);
        const act = pool.find((item) => (roll -= item[2]) < 0) || pool[0];
        last = act[0];
        play(act[0], act[1]);
      }
      actTimer = setTimeout(nextAct, 1800 + Math.random() * 2600);
    };
    actTimer = setTimeout(nextAct, 900);

    // Eyes follow the pointer anywhere over the banner; they drift back to centre after a while.
    let idle = 0;
    const look = (x, y) => {
      art.style.setProperty("--eye-x", `${x.toFixed(2)}px`);
      art.style.setProperty("--eye-y", `${y.toFixed(2)}px`);
    };
    stage.lookAt = (clientX, clientY) => {
      const box = art.getBoundingClientRect();
      const dx = clientX - (box.left + box.width * 0.55);
      const dy = clientY - (box.top + box.height * 0.42);
      const distance = Math.max(1, Math.hypot(dx, dy));
      const reach = Math.min(1, distance / 260);
      look((dx / distance) * 7 * reach, (dy / distance) * 4.5 * reach);
      clearTimeout(idle);
      idle = setTimeout(() => look(0, 0), 2600);
    };

    // A click: a happy squint and a little hop, with a pixel burst.
    let clicks = [];
    stage.addEventListener("click", () => {
      const now = Date.now();
      clicks = clicks.filter((t) => now - t < 1200).concat(now);
      if (clicks.length >= 3) {
        clicks = [];
        play("dizzy", 1900);
        return;
      }
      stage.classList.remove("jump");
      art.classList.remove(...ACT_CLASSES);
      art.classList.add("happy");
      void stage.offsetWidth;
      stage.classList.add("jump");
      setTimeout(() => art.classList.remove("happy"), 1100);
      burst.replaceChildren();
      for (let i = 0; i < 16; i += 1) {
        const px = h("i");
        const angle = (Math.PI * 2 * i) / 16;
        px.style.setProperty(
          "--dx",
          `${Math.round(Math.cos(angle) * (70 + Math.random() * 40))}px`,
        );
        px.style.setProperty(
          "--dy",
          `${Math.round(Math.sin(angle) * (60 + Math.random() * 30)) - 30}px`,
        );
        burst.append(px);
      }
    });
    stage.addEventListener("pointerenter", () => art.classList.add("curious"));
    stage.addEventListener("pointerleave", () => art.classList.remove("curious"));
    void actTimer;
    return stage;
  }

  // 阿零 leans toward the pointer and watches it while it is over the banner.
  function followPointer(banner) {
    banner.addEventListener("pointermove", (event) => {
      const box = banner.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      banner.style.setProperty("--lean-x", `${(x * 10).toFixed(1)}px`);
      banner.style.setProperty("--lean-r", `${(x * 5).toFixed(1)}deg`);
      banner.style.setProperty("--lean-y", `${(y * 4).toFixed(1)}px`);
      banner.style.setProperty("--mx", `${Math.round(event.clientX - box.left)}px`);
      banner.style.setProperty("--my", `${Math.round(event.clientY - box.top)}px`);
      const stage = banner.querySelector(".mascot-stage");
      if (stage && stage.lookAt) stage.lookAt(event.clientX, event.clientY);
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
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
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
  // Quota windows, plus the reset cards OpenAI gave the account (官方赠送的额度重置卡).
  // `reset`: the saved current account, so the tile can offer 使用 (pages/reset-credits.js).
  const quotaTiles = (windows, resetCredits, reset) =>
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
      resetCredits === undefined
        ? null
        : reset && api.accountCards
          ? api.accountCards.resetTile(resetCredits, reset)
          : api.resetCardTile(resetCredits),
    );

  pages.home = (root, alive) => {
    let repaintQuota = null;
    const promo = h("section", { class: "m promo span-6" });
    followPointer(promo);
    const people = h("section", { class: "m panel span-6 accounts-panel" });
    const agentsModule = h("section", { class: "m panel span-3" });
    const lines = h("section", { class: "m panel span-3" });
    // Same switch as 中转站 and 账号 (pages/no-account.js).
    // Codex 概况: what the in-Codex 仪表盘 showed (sessions, MCP, Skills, 12-week activity).
    const overview = h("section", { class: "m panel span-6 codex-overview" });
    root.append(
      h("div", { class: "grid home-grid" }, promo, people, agentsModule, lines, overview),
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
      const [summary, agents, accounts] = await Promise.all([
        call("home.summary").catch(() => null),
        call("agents.list").catch(() => null),
        call("accounts.list").catch(() => null),
      ]);
      if (!alive()) return;
      renderAccounts(summary, accounts);
      renderAgents(agents);
      renderLines(summary);
    }

    /* 账号额度: the current Codex account with its quota and reset cards, then the saved ones. */
    function renderAccounts(summary, result) {
      const account = summary && summary.currentAccount;
      const saved = ((result && result.available && result.accounts) || []).filter(
        (a) => !a.current,
      );
      const quota = h("div", { class: "work-quota" });
      const savedCurrent = ((result && result.available && result.accounts) || []).find(
        (a) => a.current,
      );
      const current = account
        ? h(
            "div",
            { class: "acct-current" },
            h(
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
                    "正在使用",
                    account.plan ? account.plan.toUpperCase() : null,
                    account.saved ? null : "未保存",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ),
              ),
            ),
            quota,
          )
        : h(
            "div",
            { class: "acct-current empty-cta" },
            h("p", { class: "sub" }, "Codex 还没登录账号。添加后这里显示额度和重置卡。"),
            h(
              "button",
              { class: "btn paper sm", type: "button", onclick: () => go("accounts") },
              "添加账号",
            ),
          );
      const others = h(
        "div",
        { class: "acct-others" },
        h("span", { class: "label" }, `其他账号 · ${saved.length}`),
        saved.length
          ? saved.slice(0, 5).map((other) => {
              const window5h = other.lastUsage
                ? other.lastUsage.windows.find((w) => w.kind === "primary")
                : null;
              const left = window5h ? Math.max(0, Math.round(100 - window5h.usedPercent)) : null;
              const cards = other.lastUsage && other.lastUsage.resetCredits;
              return h(
                "div",
                { class: "peek-row" },
                h(
                  "div",
                  { class: "row" },
                  h("b", { class: "peek-name" }, accountName(other)),
                  h("span", { class: "spacer" }),
                  cards ? h("span", { class: "card-chip" }, `重置卡 ×${cards}`) : null,
                  h("span", { class: "peek-left tabular" }, left === null ? "未知" : `剩 ${left}%`),
                ),
                h(
                  "div",
                  { class: "bar" },
                  h("i", { style: { width: `${left === null ? 0 : left}%` } }),
                ),
              );
            })
          : h("p", { class: "sub" }, "只有一个账号。额度用完时可以切到别的账号继续用。"),
      );
      put(
        people,
        modHead(
          "people",
          "账号额度",
          "当前账号还剩多少、什么时候重置",
          h(
            "button",
            { class: "btn sm", type: "button", onclick: () => go("accounts") },
            "管理账号",
          ),
        ),
        h("div", { class: "acct-grid" }, current, others),
      );
      if (!account) {
        repaintQuota = null;
        return;
      }
      // Same store as 账号 (pages/quota-live.js): a reply's newer numbers win and repaint here
      // without a request; the freshness line says how old the numbers are and where from.
      const liveId = savedCurrent ? savedCurrent.id : null;
      let read = null;
      const paint = () => {
        if (!alive()) return;
        const fresh =
          api.quotaLive && liveId
            ? api.quotaLive.pick("codex", liveId, read)
            : { usage: read, at: read && read.fetchedAt ? read.fetchedAt * 1000 : 0 };
        const shown = fresh && fresh.usage;
        const windows = shown ? shown.windows : [];
        put(
          quota,
          windows.length || (shown && shown.resetCredits !== undefined)
            ? [
                quotaTiles(
                  windows,
                  shown.resetCredits,
                  savedCurrent
                    ? {
                        vendor: savedCurrent.plan === "api-key" ? "api-key" : "openai",
                        account: { ...savedCurrent, lastUsage: shown },
                        refreshed: () => load(),
                      }
                    : null,
                ),
                api.quotaLive ? api.quotaLive.freshLine(fresh) : null,
              ]
            : h("span", { class: "sub" }, "暂时读不到额度"),
        );
      };
      repaintQuota = (id) => {
        if (!id || id === liveId) paint();
      };
      const pushedRecently =
        api.quotaLive &&
        liveId &&
        Date.now() - api.quotaLive.pushedAt("codex", liveId) < api.quotaLive.CURRENT_MS;
      if (pushedRecently) {
        read = savedCurrent.lastUsage || null;
        paint();
        return;
      }
      if (!quota.childNodes.length) put(quota, h("span", { class: "sub" }, "额度读取中…"));
      call("accounts.usageCurrent")
        .catch(() => null)
        .then((usage) => {
          read = usage && usage.available ? usage.usage : null;
          paint();
        });
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
      const list = h("div", { class: "line-list" }, h("span", { class: "sub" }, "读取中…"));
      put(
        lines,
        modHead("route", "中转站", "接入的中转站和余额"),
        list,
        h(
          "div",
          { class: "row" },
          h("span", { class: "spacer" }),
          h(
            "button",
            { class: "btn sm", type: "button", onclick: () => go("relays", { preset: "add" }) },
            "+ 添加中转站",
          ),
          h(
            "button",
            { class: "btn paper sm", type: "button", onclick: () => go("relays") },
            "管理中转站",
          ),
        ),
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

    const size = (bytes) =>
      bytes >= 1024 ** 3
        ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
        : bytes >= 1024 ** 2
          ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
          : `${Math.max(0, Math.round(bytes / 1024))} KB`;
    async function loadOverview() {
      const [threads, mcp, skills] = await Promise.all([
        call("dashboard.threadStats").catch(() => null),
        call("mcp.list").catch(() => null),
        call("skills.list").catch(() => null),
      ]);
      if (!alive()) return;
      const stat = (label, value, page) =>
        h(
          "button",
          { class: "overview-stat", type: "button", onclick: () => go(page) },
          h("b", { class: "tabular" }, value),
          h("span", null, label),
        );
      // 活跃: GitHub-style pixel squares, 7 rows (Sunday–Saturday), one column per week, as many
      // recent weeks as fit the card at ~13–18 px per square (up to 105 from `history`).
      const allDays = (threads && (threads.history || threads.activity)) || [];
      const md = (date) => {
        const [, m, d] = String(date).split("-");
        return m && d ? `${Number(m)}/${Number(d)}` : String(date);
      };
      const heat = h("div", { class: "activity" });
      function drawHeat(width) {
        const CELL = 15;
        const GAP = 3;
        const weeksAvailable = Math.ceil(allDays.length / 7);
        const weeks = Math.max(
          4,
          Math.min(weeksAvailable, Math.floor((width + GAP) / (CELL + GAP))),
        );
        // Last `weeks` columns ending with today's week; pad the first column to its weekday.
        const today = allDays[allDays.length - 1];
        const todayDow = today ? new Date(`${today.date}T00:00:00`).getDay() : 6;
        const count = Math.min(allDays.length, (weeks - 1) * 7 + todayDow + 1);
        const days = allDays.slice(allDays.length - count);
        const firstDow = days[0] ? new Date(`${days[0].date}T00:00:00`).getDay() : 0;
        const peak = Math.max(1, ...days.map((day) => day.count));
        const total = days.reduce((sum, day) => sum + day.count, 0);
        const active = days.filter((day) => day.count > 0).length;
        heat.style.setProperty("--weeks", String(weeks));
        heat.replaceChildren(
          h(
            "div",
            { class: "activity-head" },
            h("b", null, `最近 ${weeks} 周`),
            h(
              "span",
              { class: "tabular" },
              `${total} 个会话 · 活跃 ${active} 天 · 单日最多 ${total === 0 ? 0 : peak}`,
            ),
          ),
          h(
            "div",
            {
              class: "activity-grid",
              role: "img",
              "aria-label": `最近 ${weeks} 周共 ${total} 个会话`,
            },
            Array.from({ length: firstDow }, () =>
              h("span", { class: "heat-cell pad", "aria-hidden": "true" }),
            ),
            days.map((day) =>
              h("span", {
                class: `heat-cell l${day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / peak) * 4))}`,
                "data-tip": `${md(day.date)} · ${day.count} 个会话`,
              }),
            ),
          ),
          h(
            "div",
            { class: "activity-foot", "aria-hidden": "true" },
            h("span", { class: "tabular" }, `${md(days[0] && days[0].date)} — 今天`),
            h(
              "span",
              { class: "heat-legend" },
              "少",
              [0, 1, 2, 3, 4].map((level) => h("i", { class: `heat-cell l${level}` })),
              "多",
            ),
          ),
        );
      }
      // Redraw only when the number of weeks that fit changes.
      let drawnFor = -1;
      const fit = () => {
        const inner = heat.clientWidth - 36;
        const weeks = Math.floor((inner + 3) / 18);
        if (inner > 0 && weeks !== drawnFor) {
          drawnFor = weeks;
          drawHeat(inner);
        }
      };
      if (allDays.length) {
        const observer = new ResizeObserver(() => (alive() ? fit() : observer.disconnect()));
        observer.observe(heat);
        drawHeat(1000);
      }
      put(
        overview,
        modHead("chart", "Codex 概况", "会话、MCP、Skills 和每天的活跃"),
        h(
          "div",
          { class: "overview-stats" },
          stat(
            threads ? `会话 · ${size(threads.stats.totalBytes)}` : "会话",
            threads ? String(threads.stats.totalThreads) : "—",
            "threads",
          ),
          stat(
            "MCP 启用 / 总数",
            mcp ? `${mcp.enabledCount} / ${mcp.totalCount ?? mcp.servers.length}` : "—",
            "mcp",
          ),
          stat(
            "Skills",
            skills ? String(skills.installedCount ?? skills.installed.length) : "—",
            "skills",
          ),
          stat("活跃天数", threads ? String(threads.stats.activeDays) : "—", "threads"),
        ),
        allDays.length ? heat : null,
      );
    }

    loadPromo();
    load();
    loadOverview();
    // Every minute while the window is visible (paused when hidden or minimized).
    const visible = () => (api.quotaLive ? api.quotaLive.visible() : !document.hidden);
    const timer = setInterval(() => {
      if (visible()) {
        load();
        loadPromo();
      }
    }, 60000);
    pollers.add(timer);
    if (api.quotaLive) {
      const stop = api.quotaLive.subscribe((event) => {
        if (!alive()) return stop();
        if (event.type === "quota" && event.provider === "codex" && repaintQuota)
          repaintQuota(event.id);
        if (event.type === "balance") loadPromo();
      });
    }
  };
};
