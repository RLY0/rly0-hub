"use strict";
// "AI 助手" page: official agents of the model vendors, then third-party agents. Each card shows
// the vendor's logo, installs with a slide-to-unlock control and a progress bar, and lets the
// person pick how the agent connects: its own account, 零号中转, or another relay.
window.registerHubAgents = ({ pages, h, call, toast, failed, explain, money, isRly0, pollers }) => {
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
  const STEPS = {
    installingNode: ["正在安装 Node.js", 20],
    installingGit: ["正在安装 Git", 35],
    officialInstaller: ["正在运行官方安装程序", 60],
    npm: ["正在通过 npm 安装", 60],
    npmMirror: ["正在通过备用源安装", 75],
  };
  const INSTALL_ERRORS = {
    NETWORK: "网络不通，换个网络或开代理再试",
    PERMISSION: "没有权限，试试以管理员身份运行 Hub",
    NODE_MISSING: "缺少 Node.js，可以先手动安装",
    GIT_MISSING: "缺少 Git，可以先手动安装",
    MANUAL: "需要手动安装",
    UNSUPPORTED: "暂不支持自动安装",
  };
  const KEY_PLACEHOLDER = "<你的密钥>";
  // DOM replaceChildren turns null into the text "null"; skip empty slots instead.
  const put = (element, ...items) =>
    element.replaceChildren(
      ...items
        .flat(Infinity)
        .filter((item) => item !== null && item !== undefined && item !== false),
    );

  const logo = (agent, size = 48) =>
    h(
      "span",
      { class: "agent-logo", style: { width: `${size}px`, height: `${size}px` } },
      LOGOS[agent.id]
        ? h("img", { src: LOGOS[agent.id], alt: `${agent.name} 图标` })
        : agent.name.slice(0, 2),
    );

  function copy(text) {
    const done = () => toast("已复制");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const area = h("textarea", { class: "copy-buffer", readonly: true });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
      toast("复制没有成功，请手动选中");
    }
    area.remove();
  }
  const codeBlock = (title, text) =>
    h(
      "div",
      { class: "code-block" },
      h(
        "div",
        { class: "row" },
        h("span", { class: "label" }, title),
        h("span", { class: "spacer" }),
        h("button", { class: "btn quiet sm", type: "button", onclick: () => copy(text) }, "复制"),
      ),
      h("pre", null, text),
    );

  /* ---------- Relay snippets, the same methods the relay's own "使用密钥" page offers ---------- */
  function relayRoot(relay) {
    return relay.baseUrl.replace(/\/v1\/?$/u, "").replace(/\/+$/u, "");
  }
  function snippets(agent, relay) {
    const root = relayRoot(relay);
    const v1 = `${root}/v1`;
    if (agent.id === "claude-code") {
      return [
        [
          "PowerShell（只对当前窗口生效）",
          `$env:ANTHROPIC_BASE_URL="${root}"\n$env:ANTHROPIC_AUTH_TOKEN="${KEY_PLACEHOLDER}"\n$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
        ],
        [
          "%USERPROFILE%\\.claude\\settings.json（长期生效）",
          JSON.stringify(
            {
              env: {
                ANTHROPIC_BASE_URL: root,
                ANTHROPIC_AUTH_TOKEN: KEY_PLACEHOLDER,
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              },
            },
            null,
            2,
          ),
        ],
      ];
    }
    if (agent.id === "opencode") {
      return [
        [
          "%USERPROFILE%\\.config\\opencode\\opencode.json",
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              provider: { anthropic: { options: { baseURL: v1, apiKey: KEY_PLACEHOLDER } } },
            },
            null,
            2,
          ),
        ],
      ];
    }
    if (agent.id === "grok") {
      return [
        [
          "PowerShell（只对当前窗口生效）",
          `$env:GROK_MODELS_BASE_URL="${v1}"\n$env:XAI_API_KEY="${KEY_PLACEHOLDER}"`,
        ],
      ];
    }
    return [];
  }

  /* ---------- Slide to unlock ---------- */
  const LOCK =
    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
  const UNLOCK =
    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>';
  function slideToUnlock(label, onUnlock) {
    const icon = () => {
      const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      s.setAttribute("viewBox", "0 0 24 24");
      s.setAttribute("aria-hidden", "true");
      s.innerHTML = LOCK; // fixed markup
      return s;
    };
    const glyph = icon();
    const knob = h(
      "button",
      { class: "unlock-knob", type: "button", "aria-label": `${label}（按回车也可以）` },
      glyph,
    );
    const text = h("span", { class: "unlock-text" }, label);
    const track = h("div", { class: "unlock" }, text, knob);
    let startX = 0;
    let dragging = false;
    let done = false;
    const max = () => track.clientWidth - knob.offsetWidth - 8;
    const place = (x) => {
      const offset = Math.max(0, Math.min(max(), x));
      knob.style.transform = `translateX(${offset}px)`;
      track.style.setProperty("--unlock", `${max() > 0 ? offset / max() : 0}`);
      return offset;
    };
    const finish = () => {
      done = true;
      place(max());
      glyph.innerHTML = UNLOCK;
      track.classList.add("unlocked");
      onUnlock();
    };
    knob.addEventListener("pointerdown", (event) => {
      if (done) return;
      dragging = true;
      startX = event.clientX;
      knob.setPointerCapture(event.pointerId);
      track.classList.add("dragging");
    });
    knob.addEventListener("pointermove", (event) => {
      if (dragging) place(event.clientX - startX);
    });
    const release = (event) => {
      if (!dragging) return;
      dragging = false;
      track.classList.remove("dragging");
      if (place(event.clientX - startX) >= max() * 0.85) finish();
      else place(0);
    };
    knob.addEventListener("pointerup", release);
    knob.addEventListener("pointercancel", release);
    knob.addEventListener("keydown", (event) => {
      if (!done && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        finish();
      }
    });
    return track;
  }

  function progressBar() {
    const fill = h("i");
    const label = h("span", { class: "sub" });
    const percent = h("span", { class: "sub tabular" });
    const element = h(
      "div",
      {
        class: "install-progress",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
      },
      h("div", { class: "row" }, label, h("span", { class: "spacer" }), percent),
      h("div", { class: "bar" }, fill),
    );
    return {
      element,
      set(text, value) {
        label.textContent = text;
        percent.textContent = `${value}%`;
        fill.style.width = `${value}%`;
        element.setAttribute("aria-valuenow", String(value));
      },
    };
  }

  /* ---------- Page ---------- */
  pages.agents = (root, alive) => {
    const ready = h("section", { class: "m tone span-6 ready-strip" });
    const official = h("div", { class: "grid compact" });
    const community = h("div", { class: "grid compact" });
    root.append(
      h("div", { class: "grid compact" }, ready),
      h(
        "h2",
        { class: "section-title" },
        "官方 Agent",
        h("span", { class: "sub" }, "模型厂商自家的编程助手"),
      ),
      official,
      h(
        "h2",
        { class: "section-title" },
        "第三方 Agent",
        h("span", { class: "sub" }, "开源在前，闭源在后"),
      ),
      community,
    );
    let relays = [];
    let claudeRelay = null;
    let claudeAuth = null;
    const balances = new Map();

    async function load() {
      const [list, relayList, selection, auth] = await Promise.all([
        call("agents.list").catch(() => null),
        call("relay.list").catch(() => null),
        call("agents.relays.get").catch(() => ({ claudeCode: null })),
        call("agents.claudeCode.status").catch(() => null),
      ]);
      if (!alive()) return;
      relays = ((relayList && relayList.relays) || []).filter((relay) => relay.hasKey);
      claudeRelay = selection.claudeCode;
      claudeAuth = auth;
      const agents = (list && list.agents) || [];
      renderReady(agents);
      put(official, ...agents.filter((a) => a.category === "official").map(card));
      put(
        community,
        ...agents
          .filter((a) => a.category === "community")
          .sort((a, b) => Number(b.openSource) - Number(a.openSource))
          .map(card),
      );
    }

    function accessText(agent) {
      if (agent.id === "claude-code") {
        const relay = relays.find((r) => r.id === claudeRelay);
        if (relay) return `通过 ${relay.name}`;
        return claudeAuth && claudeAuth.loggedIn ? `官方账号 ${claudeAuth.email || ""}` : "未登录";
      }
      return "已安装";
    }

    function renderReady(agents) {
      const installed = agents.filter((a) => a.installed);
      put(
        ready,
        h("span", { class: "label" }, "Ready on this PC"),
        installed.length
          ? h(
              "div",
              { class: "ready-list" },
              installed.map((agent) =>
                h(
                  "div",
                  { class: "ready-item" },
                  logo(agent, 28),
                  h(
                    "div",
                    { class: "who" },
                    h("b", null, agent.name),
                    h("span", null, accessText(agent)),
                  ),
                ),
              ),
            )
          : h("p", { class: "sub" }, "这台电脑还没有装 AI 助手，从下面选一个解锁。"),
      );
    }

    async function balanceOf(relay) {
      if (!balances.has(relay.id))
        balances.set(
          relay.id,
          call("relay.balance", { id: relay.id }).catch(() => null),
        );
      return balances.get(relay.id);
    }

    function card(agent) {
      const element = h("section", { class: "m agent-card span-3" });
      const body = h("div", { class: "agent-body" });
      element.append(
        h(
          "div",
          { class: "row agent-head" },
          logo(agent),
          h(
            "div",
            { class: "who" },
            h("b", null, agent.name),
            h(
              "span",
              null,
              `${agent.vendor} · ${agent.category === "official" ? "官方" : agent.openSource ? "开源" : "闭源"}`,
            ),
          ),
          h(
            "span",
            { class: `tag ${agent.installed ? "ok" : ""}` },
            agent.installed ? "Installed" : "Locked",
          ),
        ),
        body,
      );
      if (agent.installed) renderAccess(agent, body);
      else renderLocked(agent, body);
      return element;
    }

    function manualHelp(agent) {
      return h(
        "details",
        { class: "manual" },
        h("summary", null, "手动安装"),
        agent.manualCommand
          ? codeBlock("在 PowerShell 里运行", agent.manualCommand)
          : h("p", { class: "sub" }, "这个助手需要从官网下载安装。"),
        h(
          "button",
          {
            class: "btn quiet sm",
            type: "button",
            onclick: () => call("links.agentDocs", { agent: agent.id }).catch(failed),
          },
          "打开官方安装说明",
        ),
      );
    }

    function renderLocked(agent, body) {
      const progress = progressBar();
      const status = h("p", { class: "sub" });
      const start = async () => {
        put(body, progress.element, status);
        progress.set("准备安装", 5);
        let state = await call("agents.installStart", { agent: agent.id }).catch(() => ({
          state: "failed",
          error: "FAILED",
        }));
        const begun = Date.now();
        const tick = async () => {
          if (!alive()) return;
          if (state.state === "running") {
            const [text, value] = STEPS[state.step] || ["正在安装", 10];
            const seconds = Math.round((Date.now() - begun) / 1000);
            progress.set(`${text}… ${seconds}s`, value);
            return;
          }
          clearInterval(timer);
          pollers.delete(timer);
          if (state.state === "succeeded") {
            progress.set("安装完成", 100);
            toast(`${agent.name} 已解锁`);
            setTimeout(() => alive() && load(), 800);
          } else {
            put(
              body,
              h("p", { class: "warn-text" }, INSTALL_ERRORS[state.error] || "安装没有成功"),
              h(
                "div",
                { class: "row" },
                state.error === "NODE_MISSING"
                  ? h(
                      "button",
                      {
                        class: "btn sm",
                        type: "button",
                        onclick: () => call("links.open", { target: "nodejs" }).catch(failed),
                      },
                      "下载 Node.js",
                    )
                  : null,
                h(
                  "button",
                  { class: "btn sm", type: "button", onclick: () => renderLocked(agent, body) },
                  "再试一次",
                ),
              ),
              manualHelp(agent),
            );
          }
        };
        const timer = setInterval(async () => {
          state =
            (await call("agents.installStatus", { agent: agent.id }).catch(() => null)) || state;
          tick();
        }, 1200);
        pollers.add(timer);
        tick();
      };
      put(
        body,
        agent.automatic
          ? slideToUnlock("滑动解锁 · 一键安装", start)
          : h("p", { class: "sub" }, "需要从官网手动安装。"),
        manualHelp(agent),
      );
      // An install still running from before keeps showing its progress.
      call("agents.installStatus", { agent: agent.id }).then(
        (s) => {
          if (alive() && s && s.state === "running") start();
        },
        () => undefined,
      );
    }

    function renderAccess(agent, body) {
      const zero = relays.find((relay) => isRly0(relay));
      const others = relays.filter((relay) => !isRly0(relay));
      const supports = agent.relay !== "none" && relays.length > 0;
      let mode = "official";
      let relay = null;
      if (agent.id === "claude-code" && claudeRelay) {
        relay = relays.find((r) => r.id === claudeRelay) || null;
        mode = relay ? (isRly0(relay) ? "rly0" : "other") : "official";
      }
      const detail = h("div", { class: "access-detail" });
      const quota = h("div", { class: "quota-line" });
      const segment = h("div", { class: "segment", role: "radiogroup", "aria-label": "接入方式" });

      const choose = async (nextMode, nextRelay) => {
        mode = nextMode;
        relay = nextRelay;
        if (agent.relay === "auto") {
          await call("agents.relays.set", {
            claudeCode: mode === "official" ? null : relay.id,
          }).then(
            () =>
              toast(
                mode === "official"
                  ? "已改为官方账号"
                  : `已接入 ${relay.name}，Codex 里新开的对话生效`,
              ),
            failed,
          );
          claudeRelay = mode === "official" ? null : relay.id;
        }
        draw();
      };

      function draw() {
        const option = (key, label, disabled, onclick) =>
          h(
            "button",
            {
              type: "button",
              role: "radio",
              "aria-checked": String(mode === key),
              class: mode === key ? "on" : "",
              disabled,
              onclick,
            },
            label,
          );
        put(
          segment,
          option("official", "官方账号", false, () => choose("official", null)),
          supports && zero ? option("rly0", "零号中转", false, () => choose("rly0", zero)) : null,
          supports && others.length
            ? option("other", others.length === 1 ? others[0].name : "其他中转", false, () =>
                choose("other", relay && !isRly0(relay) ? relay : others[0]),
              )
            : null,
        );
        if (mode === "official") drawOfficial();
        else drawRelay();
      }

      function drawOfficial() {
        put(quota);
        if (agent.id === "claude-code") {
          const auth = claudeAuth;
          put(
            detail,
            auth && auth.loggedIn
              ? h(
                  "div",
                  { class: "row" },
                  h(
                    "span",
                    { class: "sub" },
                    `已登录 ${auth.email || ""}${auth.plan ? ` · ${auth.plan}` : ""}`,
                  ),
                  h("span", { class: "spacer" }),
                  h(
                    "button",
                    {
                      class: "btn quiet sm",
                      type: "button",
                      onclick: () =>
                        call("agents.claudeCode.logout").then(() => {
                          toast("已退出登录");
                          load();
                        }, failed),
                    },
                    "退出登录",
                  ),
                )
              : h(
                  "div",
                  { class: "row" },
                  h(
                    "button",
                    { class: "btn paper sm", type: "button", onclick: () => login("claudeai") },
                    "用 Claude 账号登录",
                  ),
                  h(
                    "button",
                    { class: "btn sm", type: "button", onclick: () => login("console") },
                    "用 API Console 登录",
                  ),
                ),
          );
          return;
        }
        put(
          detail,
          h(
            "div",
            { class: "row" },
            agent.canOpenLogin
              ? h(
                  "button",
                  {
                    class: "btn sm",
                    type: "button",
                    onclick: () =>
                      call("agents.openLogin", { agent: agent.id }).then(
                        (r) => toast(r.ok ? "已打开终端，按提示登录" : "没能打开终端"),
                        failed,
                      ),
                  },
                  "登录官方账号",
                )
              : null,
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
        );
      }

      async function login(kind) {
        const result = await call("agents.claudeCode.login", { mode: kind }).catch(() => null);
        toast(result && result.started ? "已在浏览器打开登录页" : "没能开始登录");
        const timer = setInterval(async () => {
          const status = await call("agents.claudeCode.status").catch(() => null);
          if (status && status.loggedIn) {
            clearInterval(timer);
            pollers.delete(timer);
            if (alive()) load();
          }
        }, 3000);
        pollers.add(timer);
      }

      async function drawRelay() {
        const picker =
          mode === "other" && others.length > 1
            ? h(
                "select",
                {
                  class: "input",
                  "aria-label": "选择中转站",
                  onchange: (event) =>
                    choose(
                      "other",
                      others.find((r) => r.id === event.target.value),
                    ),
                },
                others.map((r) =>
                  h("option", { value: r.id, selected: relay && r.id === relay.id }, r.name),
                ),
              )
            : null;
        const auto = agent.relay === "auto";
        put(
          detail,
          picker,
          auto
            ? h(
                "p",
                { class: "sub" },
                "已自动接入：Codex 里新开的对话会通过这个中转站运行，不改你电脑上的配置。",
              )
            : h(
                "details",
                { class: "manual", open: true },
                h("summary", null, "接入方法"),
                h("p", { class: "sub" }, `把 ${KEY_PLACEHOLDER} 换成你在中转站后台复制的密钥。`),
                snippets(agent, relay).map(([title, text]) => codeBlock(title, text)),
                isRly0(relay)
                  ? h(
                      "button",
                      {
                        class: "btn quiet sm",
                        type: "button",
                        onclick: () => call("links.open", { target: "keys" }).catch(failed),
                      },
                      "打开零号「API 密钥」页",
                    )
                  : null,
              ),
        );
        put(quota, h("span", { class: "sub" }, "额度读取中…"));
        const balance = await balanceOf(relay);
        if (!alive()) return;
        if (balance && balance.available && balance.ok) {
          put(
            quota,
            h("span", { class: "label" }, relay.name),
            h("b", { class: "tabular" }, money(balance.balance, balance.unit)),
            typeof balance.rate === "number"
              ? h("span", { class: "sub tabular" }, `倍率 ×${balance.rate}`)
              : null,
          );
        } else {
          put(quota, h("span", { class: "sub" }, balance ? explain(balance.error) : "读不到余额"));
        }
      }

      put(body, h("span", { class: "label" }, "接入方式"), segment, quota, detail);
      draw();
    }

    load();
  };
};
