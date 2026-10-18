"use strict";
// "AI 助手" page: official agents of the model vendors, then third-party agents. Each card shows
// the vendor's logo, installs with a slide-to-unlock control and a progress bar, and lets the
// person pick how the agent connects: its own account, 零号中转, or another relay.
window.registerHubAgents = ({
  pages,
  h,
  call,
  toast,
  failed,
  explain,
  isRly0,
  isOfficialKey,
  LOGIN_ICONS,
  countdown,
  resetText,
  pollers,
  moneyBadge,
  rateBadge,
}) => {
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
    installerWindow: ["请在弹出的安装窗口里完成安装，有提问直接在窗口里回答", 60],
    npm: ["正在通过 npm 安装", 60],
    npmMirror: ["正在通过备用源安装", 75],
  };
  const INSTALL_ERRORS = {
    NETWORK: "网络不通，换个网络或开代理再试",
    PERMISSION: "安装被系统拒绝了，展开下面的安装日志看具体原因",
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

  // What to do in each agent's own terminal to sign in.
  const TERMINAL_LOGIN_STEPS = {
    pi: [
      "终端里会出现 Pi 的界面，底部有输入框。",
      "输入 /login 然后回车，选一个服务商（如 OpenAI、Anthropic），按提示在浏览器里登录或粘贴 API Key。",
      "看到登录成功后，按 Ctrl+C 两次退出，关闭窗口。",
      "回到 Hub 点「检测连接」，显示连接正常就能在 Codex 里用了。",
    ],
    hermes: [
      "第一次运行 Hermes 会问「Help improve Hermes?」，直接按回车（不发送数据）。",
      "接着选择模型服务商（如 OpenRouter、OpenAI、Anthropic），按提示登录或粘贴 API Key，再选一个模型。",
      "完成后关闭窗口。",
      "回到 Hub 点「检测连接」，显示连接正常就能在 Codex 里用了。",
    ],
    opencode: [
      "终端里会打开 OpenCode。",
      "输入 /connect（或 /login）回车，选服务商并登录。",
      "完成后关闭窗口，回到 Hub 点「检测连接」。",
    ],
  };

  // Official agents and the model family they are built for.
  const NATIVE_MODELS = {
    "claude-code": { family: "Claude", pattern: /^(?:anthropic\/)?claude/iu },
    grok: { family: "Grok", pattern: /^(?:xai\/)?grok/iu },
    antigravity: { family: "Gemini", pattern: /^(?:google\/)?gemini/iu },
  };

  /* ---------- Page ---------- */
  const LOGIN_ERRORS = {
    API_KEY_INVALID: "Key 格式不对，Anthropic 的 Key 以 sk-ant- 开头",
    AUTH_FILE_INVALID: "这个文件不是有效的 JSON",
    AUTH_FILE_NOT_A_LOGIN:
      "文件里没有 Claude 登录（支持 .credentials.json 和 Sub2API 导出的 Claude 账号）",
    RLY0_CORE_UNAVAILABLE: "后台服务还没准备好，请稍后再试",
  };
  const loginFailed = (error) =>
    toast(LOGIN_ERRORS[error && error.message] || explain(error && error.message));

  const sectionHead = (kind, title, hint, count) =>
    h(
      "div",
      { class: `agent-section-head ${kind}` },
      h("span", { class: "section-badge" }, kind === "official" ? "OFFICIAL" : "THIRD-PARTY"),
      h("div", { class: "mod-title" }, h("b", null, title), h("span", null, hint)),
      h("span", { class: "spacer" }),
      h("span", { class: "count-pill tabular" }, count),
    );

  // What a failed connection check means, in plain words (the raw message stays below it).
  function connectionHint(agent, entry) {
    const text = `${entry.code || ""} ${entry.message || ""}`;
    if (entry.status === "notInstalled")
      return "Codex 那边还找不到它。刚装好的话点上面的“检测连接”，还不行就重启一次 Codex";
    if (/AUTH|auth_required|not configured|no provider|No API key|No models available/iu.test(text))
      return "还没有可用的模型来源：接入方式选零号中转或其他中转，或者登录官方账号";
    if (/interpreter not found/iu.test(text))
      return `${agent.name} 的运行环境没找到，可能是安装没完成，点“再装一次”或检测连接重试`;
    return "连接失败，下面是具体原因";
  }

  pages.agents = (root, alive) => {
    const official = h("div", { class: "grid compact agent-grid" });
    const community = h("div", { class: "grid compact agent-grid" });
    const officialHead = h("div");
    const communityHead = h("div");
    root.append(
      h("section", { class: "agent-section official" }, officialHead, official),
      h("section", { class: "agent-section community" }, communityHead, community),
    );
    let relays = [];
    let officialKey = null;
    let claudeRelay = null;
    // Third-party agents RLY/0 Hub routes itself: { agentId: { relayId, model } }.
    let agentRelays = {};
    let claudeAuth = null;
    let connections = null; // last report from the Codex side: { checkedAt, agents: { id: {...} } }
    const balances = new Map();
    const checkButton = h(
      "button",
      { class: "btn sm", type: "button", onclick: () => checkConnections() },
      "检测连接",
    );

    // The Codex side runs each agent's own check (the one its agent picker uses) on request.
    async function checkConnections() {
      checkButton.disabled = true;
      checkButton.textContent = "检测中…";
      const result = await call("agents.checkConnections").catch(() => null);
      checkButton.disabled = false;
      checkButton.textContent = "检测连接";
      if (!alive()) return;
      if (result && result.codexRunning === false) {
        toast("Codex 没在运行，打开 Codex 后再检测");
        return;
      }
      if (!result || !result.report) {
        toast("Codex 没有回应，请确认 Codex 是从 RLY/0 Hub 启动的");
        return;
      }
      const failedCount = Object.values(result.report.agents).filter(
        (entry) => entry.status !== "ready",
      ).length;
      toast(failedCount ? `检测完成，${failedCount} 个助手连不上` : "检测完成，全部正常");
      load();
    }

    async function load() {
      const [list, relayList, selection, auth, status] = await Promise.all([
        call("agents.list").catch(() => null),
        call("relay.list").catch(() => null),
        call("agents.relays.get").catch(() => ({ claudeCode: null })),
        call("agents.claudeCode.status").catch(() => null),
        call("agents.connectionStatus").catch(() => null),
      ]);
      if (!alive()) return;
      connections = status && status.report;
      const all = ((relayList && relayList.relays) || []).filter((relay) => relay.hasKey);
      officialKey = all.find(isOfficialKey) || null;
      relays = all.filter((relay) => relay.enabled && !isOfficialKey(relay));
      claudeRelay = selection.claudeCode;
      agentRelays = selection.agents || {};
      claudeAuth = auth;
      const agents = (list && list.agents) || [];
      // Installed first; within each, the catalogue order (open source before closed).
      const order = (items) =>
        items
          .map((agent, index) => ({ agent, index }))
          .sort(
            (a, b) =>
              Number(b.agent.installed) - Number(a.agent.installed) ||
              Number(b.agent.openSource) - Number(a.agent.openSource) ||
              a.index - b.index,
          )
          .map(({ agent }) => agent);
      const officials = order(agents.filter((a) => a.category === "official"));
      const others = order(agents.filter((a) => a.category === "community"));
      const ready = (items) =>
        `${items.filter((a) => a.installed).length} / ${items.length} 已安装`;
      put(
        officialHead,
        sectionHead("official", "官方 Agent", "模型厂商自家的编程助手", ready(officials)),
      );
      officialHead.firstChild.insertBefore(checkButton, officialHead.firstChild.lastChild);
      put(
        communityHead,
        sectionHead("community", "第三方 Agent", "社区和独立团队做的，开源在前", ready(others)),
      );
      put(official, ...officials.map(card));
      put(community, ...others.map(card));
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
      const element = h("section", {
        class: `m agent-card ${agent.category === "official" ? "span-6 wide" : "span-2"} ${agent.category} ${agent.installed ? "installed" : "dormant"}`,
      });
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
            agent.installed ? "已安装" : "未解锁",
          ),
        ),
        body,
      );
      if (agent.installed) {
        renderAccess(agent, body);
        body.prepend(connectionLine(agent));
      } else renderLocked(agent, body, element);
      return element;
    }

    // Connection state from the last check the Codex side ran (diagnostics live here now).
    function connectionLine(agent) {
      const entry = connections && connections.agents[agent.id];
      if (!entry)
        return h(
          "div",
          { class: "conn-line" },
          h("span", { class: "dot" }),
          h("span", { class: "sub" }, "还没检测连接，点上面的“检测连接”"),
        );
      if (entry.status === "ready")
        return h(
          "div",
          { class: "conn-line ok" },
          h("span", { class: "dot ok" }),
          h("span", null, "连接正常，Codex 里可以直接用"),
        );
      return h(
        "div",
        { class: "conn-line bad" },
        h(
          "div",
          { class: "row" },
          h("span", { class: "dot bad" }),
          h("b", null, connectionHint(agent, entry)),
        ),
        entry.message || entry.code
          ? h(
              "details",
              { class: "manual" },
              h("summary", null, "具体原因"),
              codeBlock(entry.code || "错误", entry.message || entry.code),
            )
          : null,
      );
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

    function renderLocked(agent, body, element) {
      const progress = progressBar();
      const status = h("p", { class: "sub" });
      const start = async () => {
        // The card lights up once it is being unlocked.
        element.classList.add("awake");
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
                  {
                    class: "btn sm",
                    type: "button",
                    onclick: () => renderLocked(agent, body, element),
                  },
                  "再试一次",
                ),
              ),
              state.log
                ? h(
                    "details",
                    { class: "manual", open: true },
                    h("summary", null, "安装日志"),
                    codeBlock("最后几行（截图发给我们排查）", state.log.slice(-3000)),
                  )
                : null,
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
      element.classList.remove("awake");
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

    // A file the person picks, read as text (login files are small).
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

    function renderAccess(agent, body) {
      // An official agent runs only its own vendor's models, so it can use a relay only when the
      // relay offers them (Claude Code → Claude). Third-party agents can use any relay.
      const native = NATIVE_MODELS[agent.id];
      const fits = (relay) => !native || relay.models.some((model) => native.pattern.test(model));
      const nativeTip = (relay) =>
        relay.models.length
          ? `${relay.name} 没有 ${native.family} 模型，${agent.name} 只能用原生的 ${native.family} 模型`
          : `${relay.name} 还没读出模型，先到「中转站」页点“编辑 / 选模型”测试一次`;
      const zero = relays.find((relay) => isRly0(relay) && fits(relay));
      const zeroAny = relays.find((relay) => isRly0(relay));
      const others = relays.filter((relay) => !isRly0(relay) && fits(relay));
      const othersAny = relays.filter((relay) => !isRly0(relay));
      const canRelay = agent.relay !== "none";
      let mode = "official";
      let relay = null;
      const thirdParty = agent.id !== "claude-code" && agent.relay === "auto";
      const savedId =
        agent.id === "claude-code"
          ? claudeRelay && !(officialKey && claudeRelay === officialKey.id)
            ? claudeRelay
            : null
          : thirdParty && agentRelays[agent.id]
            ? agentRelays[agent.id].relayId
            : null;
      if (savedId) {
        relay = relays.find((r) => r.id === savedId) || null;
        mode = relay ? (isRly0(relay) ? "rly0" : "other") : "official";
      }
      // A default model for agents that need one; the relay's first model when none is saved.
      const defaultModel = (target) => {
        const saved = agentRelays[agent.id];
        if (saved && saved.relayId === target.id && saved.model) return saved.model;
        const usable = target.models.filter((m) => !m.endsWith("*"));
        return usable.find((m) => /^gpt-5/iu.test(m)) || usable[0] || null;
      };
      const detail = h("div", { class: "access-detail" });
      const quota = h("div", { class: "quota-line" });
      const segment = h("div", { class: "segment", role: "radiogroup", "aria-label": "接入方式" });

      const choose = async (nextMode, nextRelay) => {
        mode = nextMode;
        relay = nextRelay;
        if (thirdParty) {
          const model = mode === "official" ? null : defaultModel(relay);
          await call("agents.relays.setAgent", {
            agent: agent.id,
            relayId: mode === "official" ? null : relay.id,
            model,
          }).then((next) => {
            agentRelays = (next && next.agents) || {};
            toast(
              mode === "official"
                ? "已改为官方账号"
                : `已接入 ${relay.name}，Codex 里新开的 ${agent.name} 对话直接生效`,
            );
          }, failed);
        } else if (agent.relay === "auto") {
          await call("agents.relays.set", {
            claudeCode: mode === "official" ? null : relay.id,
          }).then(
            () =>
              toast(
                mode === "official"
                  ? "已改为官方账号"
                  : `已接入 ${relay.name}，Codex 里新开的对话直接生效，不用重启`,
              ),
            failed,
          );
          claudeRelay = mode === "official" ? null : relay.id;
        }
        draw();
      };

      function draw() {
        // Every way in is always shown; one that cannot be used yet is grey with a hint.
        const option = (key, label, blocked, onclick) =>
          h(
            "button",
            {
              type: "button",
              role: "radio",
              "aria-checked": String(mode === key),
              "aria-disabled": blocked ? "true" : null,
              "data-tip": blocked || null,
              class: `${mode === key ? "on" : ""} ${blocked ? "off" : ""}`,
              onclick: () => (blocked ? toast(blocked) : onclick()),
            },
            label,
          );
        const unsupported = canRelay ? null : `${agent.name} 暂时不能接中转站，只能用官方账号`;
        put(
          segment,
          option("official", "官方账号", null, () => choose("official", null)),
          option(
            "rly0",
            "零号中转",
            unsupported ||
              (zero
                ? null
                : zeroAny
                  ? nativeTip(zeroAny)
                  : "还没添加零号中转，先去「中转站」页接入"),
            () => choose("rly0", zero),
          ),
          option(
            "other",
            others.length === 1 ? others[0].name : "其他中转",
            unsupported ||
              (others.length
                ? null
                : othersAny.length
                  ? othersAny.length === 1
                    ? nativeTip(othersAny[0])
                    : `已添加的中转站都没有 ${native ? native.family : ""} 模型`
                  : "还没添加其他中转站，可以在「中转站」页添加"),
            () => choose("other", relay && !isRly0(relay) ? relay : others[0]),
          ),
        );
        if (mode === "official") drawOfficial();
        else drawRelay();
      }

      function loginMenu(label, className) {
        const claude = agent.id === "claude-code";
        return window.HubUI.menuButton(
          label,
          [
            {
              icon: LOGIN_ICONS.web,
              title: "网页登录",
              desc: claude
                ? "在浏览器登录 Claude 账号（Pro / Max）"
                : "打开终端，按提示在浏览器里登录",
              onSelect: () =>
                claude ? login("claudeai") : openTerminalLogin("已打开终端，按提示登录"),
            },
            {
              icon: LOGIN_ICONS.file,
              title: "导入登录文件",
              desc: claude ? ".credentials.json 或 Sub2API 导出的 Claude 账号" : "这个助手不支持",
              disabled: !claude,
              tip: `${agent.name} 不支持导入登录文件，用网页登录或 API Key`,
              onSelect: () =>
                pickFile((content) =>
                  call("agents.claudeCode.importCredentials", { content }).then((result) => {
                    toast(
                      result.token
                        ? "已导入 Claude 令牌，Codex 里新开的 Claude Code 对话会用它"
                        : result.backup
                          ? "已导入，原来的登录文件已备份"
                          : "已导入 Claude 登录",
                    );
                    load();
                  }, loginFailed),
                ),
            },
            {
              icon: LOGIN_ICONS.key,
              title: "官方 API Key",
              desc: claude
                ? "API Key 或 claude setup-token 生成的令牌（sk-ant-…）"
                : "在终端里选择 API Key 方式",
              onSelect: () =>
                claude ? showKeyForm() : openTerminalLogin("已打开终端，选择 API Key 方式登录"),
            },
          ],
          { className: className || "btn paper sm" },
        );
      }

      // Third-party agents sign in inside their own terminal UI; say what to do there first.
      function openTerminalLogin(done) {
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
            "更简单的办法：不用登录，直接把接入方式选成「零号中转」或其他中转站，选好默认模型就能用。",
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
                  (r) => toast(r.ok ? done : "没能打开终端"),
                  failed,
                );
              },
            },
            "打开终端",
          ),
        );
      }

      function showKeyForm() {
        const key = h("input", {
          class: "input",
          type: "password",
          placeholder: "sk-ant-api… 或 setup-token 生成的 sk-ant-oat…",
          autocomplete: "off",
          spellcheck: "false",
          "aria-label": "Anthropic API Key",
        });
        const save = () =>
          call("agents.claudeCode.setApiKey", { apiKey: key.value.trim() }).then(() => {
            toast("已保存，Codex 里新开的 Claude Code 对话用这个 Key");
            load();
          }, loginFailed);
        key.addEventListener("keydown", (event) => {
          if (event.key === "Enter") save();
        });
        put(
          detail,
          h(
            "div",
            { class: "key-form" },
            h(
              "p",
              { class: "sub" },
              "API Key 和 claude setup-token 生成的订阅令牌都可以。加密保存在本机，只发给 Anthropic 官方，界面上不会再显示。",
            ),
            h(
              "div",
              { class: "row" },
              key,
              h("button", { class: "btn paper sm", type: "button", onclick: save }, "保存"),
              h(
                "button",
                { class: "btn quiet sm", type: "button", onclick: () => drawOfficial() },
                "取消",
              ),
            ),
          ),
        );
        key.focus();
      }

      function drawOfficial() {
        put(quota);
        if (agent.id === "claude-code") {
          const usingKey = officialKey && claudeRelay === officialKey.id;
          const panel = h("div", { class: "claude-accounts" });
          put(
            detail,
            usingKey
              ? h(
                  "div",
                  { class: "row key-row" },
                  h("span", { class: "sub" }, "正在用官方 API Key / 订阅令牌"),
                  h("span", { class: "spacer" }),
                  h(
                    "button",
                    {
                      class: "btn quiet sm",
                      type: "button",
                      onclick: () =>
                        call("agents.relays.set", { claudeCode: null }).then(() => {
                          toast("已停用 Key，改回账号登录");
                          load();
                        }, failed),
                    },
                    "停用 Key",
                  ),
                )
              : null,
            panel,
          );
          drawClaudeAccounts(panel);
          return;
        }
        put(
          detail,
          h(
            "div",
            { class: "row" },
            agent.canOpenLogin ? loginMenu("登录官方账号") : null,
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
        );
      }

      // Claude Code's sign-in replaces the live login, so the current one is saved first and the
      // new one is saved as soon as it appears: the person ends up with both, one tap apart.
      async function login(kind) {
        const before = await call("agents.claudeCode.status").catch(() => null);
        if (before && before.loggedIn)
          await call("agents.claudeAccounts.importCurrent", {}).catch(() => undefined);
        const previous = before && before.loggedIn ? before.email || "" : null;
        const result = await call("agents.claudeCode.login", { mode: kind }).catch(() => null);
        toast(
          result && result.started
            ? "已在浏览器打开登录页，用要添加的 Claude 账号登录"
            : "没能开始登录",
        );
        if (!result || !result.started) return;
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
            () => toast(`已添加 ${status.email || "Claude 账号"}，并切换到它`),
            () => toast("已登录，但没能保存这个账号，可以点「保存当前登录」"),
          );
          if (alive()) load();
        }, 3000);
        pollers.add(timer);
      }

      // Saved Claude accounts, like the Codex accounts page: quota, switch, remove.
      let claudeUsageRead = false;
      async function drawClaudeAccounts(panel) {
        const listed = await call("agents.claudeAccounts.list").catch(() => null);
        if (!alive()) return;
        const accounts = (listed && listed.accounts) || [];
        const rows = accounts.map((account) => claudeAccountRow(account, panel));
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
                    h(
                      "span",
                      null,
                      [
                        listed.live && listed.live.plan ? listed.live.plan.toUpperCase() : null,
                        "还没保存",
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    ),
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
                          drawClaudeAccounts(panel);
                        }, loginFailedClaude),
                    },
                    "保存",
                  ),
                ),
              )
            : null;
        put(
          panel,
          h(
            "div",
            { class: "row" },
            h("span", { class: "label" }, `Claude 账号 · ${accounts.length}`),
            h("span", { class: "spacer" }),
            loginMenu("+ 添加账号", "btn paper sm"),
          ),
          unsaved,
          rows.length
            ? rows
            : unsaved
              ? null
              : h(
                  "p",
                  { class: "sub" },
                  "还没登录 Claude 账号。点“添加账号”用 Claude Pro / Max 账号登录，可以添加多个，一键切换。",
                ),
        );
        if (!claudeUsageRead && accounts.length) {
          claudeUsageRead = true;
          call("agents.claudeAccounts.usageAll").then(
            () => alive() && drawClaudeAccounts(panel),
            () => undefined,
          );
        }
      }

      const loginFailedClaude = (error) =>
        toast(
          error && error.message === "CLAUDE_IDENTITY_UNKNOWN"
            ? "还读不到这个账号是谁：在 Codex 里用一次 Claude Code 后再保存"
            : explain(error && error.message),
        );

      function claudeAccountRow(account, panel) {
        const usage = account.lastUsage;
        const bars =
          usage && usage.windows && usage.windows.length
            ? h(
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
              )
            : h(
                "p",
                { class: "sub" },
                account.current ? "额度读取中…" : "额度：切换到这个账号后读取",
              );
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
                drawClaudeAccounts(panel);
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
                ]
                  .filter(Boolean)
                  .join(" · ") || " ",
              ),
            ),
            h("span", { class: "spacer" }),
            account.current ? h("span", { class: "tag ok" }, "使用中") : null,
          ),
          bars,
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
                    onclick: () =>
                      call("agents.claudeAccounts.switch", { id: account.id }).then((r) => {
                        toast(
                          r && r.switched
                            ? `已切换到 ${account.alias}，Codex 里新开的 Claude Code 对话就用它，不用重启`
                            : "已经是这个账号",
                        );
                        load();
                      }, failed),
                  },
                  "切换到这个",
                ),
            h("span", { class: "spacer" }),
            remove,
          ),
        );
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
        const usableModels = relay.models.filter((m) => !m.endsWith("*"));
        const modelPicker =
          thirdParty && usableModels.length
            ? h(
                "label",
                { class: "field" },
                h("span", null, "默认模型"),
                h(
                  "select",
                  {
                    class: "input",
                    "aria-label": "默认模型",
                    onchange: (event) =>
                      call("agents.relays.setAgent", {
                        agent: agent.id,
                        relayId: relay.id,
                        model: event.target.value,
                      }).then((next) => {
                        agentRelays = (next && next.agents) || {};
                        toast(`默认模型改为 ${event.target.value}`);
                      }, failed),
                  },
                  usableModels.map((m) =>
                    h("option", { value: m, selected: m === defaultModel(relay) }, m),
                  ),
                ),
              )
            : thirdParty
              ? h(
                  "p",
                  { class: "warn-text" },
                  `${relay.name} 还没读出模型，先到「中转站」页点“编辑 / 选模型”测试一次`,
                )
              : null;
        put(
          detail,
          modelPicker,
          relay && !fits(relay)
            ? h("p", { class: "warn-text" }, `${nativeTip(relay)}。请改回官方账号或换一个中转站。`)
            : null,
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
            moneyBadge(balance.balance, balance.unit),
            typeof balance.rate === "number" ? rateBadge(balance.rate) : null,
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
