"use strict";
// "AI 助手" page: official agents of the model vendors, then third-party agents. Each card shows
// the vendor's logo, installs with a slide-to-unlock control and a progress bar, and once
// installed only chooses what it uses (an account, the official key, or a relay). Logins and
// relays are added on the 账号 and 中转站 pages.
window.registerHubAgents = ({
  pages,
  h,
  call,
  toast,
  failed,
  explain,
  isRly0,
  isOfficialKey,
  go,
  countdown,
  resetText,
  pollers,
  moneyBadge,
  rateBadge,
  applyToCodex,
  resourceSharing,
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

  // Small "go manage it" chips under an agent's choice: icon, label, chevron.
  const LINK_ICONS = {
    account: '<circle cx="12" cy="8" r="3.5"/><path d="M5 19.5c1.3-3.3 3.7-5 7-5s5.7 1.7 7 5"/>',
    relay: '<path d="M5 8h12l-3-3M19 16H7l3 3"/>',
  };
  function linkChip(icon, label, onclick) {
    const glyph = (markup, cls) => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("class", cls);
      svg.innerHTML = markup; // fixed markup
      return svg;
    };
    return h(
      "button",
      { class: "link-chip", type: "button", onclick },
      glyph(icon, "link-chip-icon"),
      h("span", null, label),
      glyph('<path d="M9 6l6 6-6 6"/>', "link-chip-arrow"),
    );
  }

  const VENDOR_LABELS = { openai: "OpenAI", anthropic: "Anthropic", google: "Gemini", xai: "xAI" };

  // Official agents and the model family they are built for.
  const NATIVE_MODELS = {
    "claude-code": { family: "Claude", pattern: /^(?:anthropic\/)?claude/iu },
    grok: { family: "Grok", pattern: /^(?:xai\/)?grok/iu },
    antigravity: { family: "Gemini", pattern: /^(?:google\/)?gemini/iu },
  };

  /* ---------- Page ---------- */
  const sectionHead = (kind, title, hint, count) =>
    h(
      "div",
      { class: `agent-section-head ${kind}` },
      h("span", { class: "section-badge" }, kind === "official" ? "OFFICIAL" : "THIRD-PARTY"),
      h("div", { class: "mod-title" }, h("b", null, title), h("span", null, hint)),
      h("span", { class: "spacer" }),
      h("span", { class: "count-pill tabular" }, count),
    );

  // What a failed connection check means, in plain words (the raw message stays below it). The
  // Hub service attaches `entry.hint` (agent-connection-hint.ts); this is the fallback.
  function connectionHint(agent, entry) {
    if (entry.hint) return entry.hint;
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
    const sharingCard = h("section", { class: "m span-6 share-card" });
    resourceSharing.mount(sharingCard, alive);
    root.append(
      h("section", { class: "agent-section official" }, officialHead, official),
      h("section", { class: "agent-section community" }, communityHead, community),
      h(
        "section",
        { class: "agent-section sharing" },
        h("div", { class: "grid compact" }, sharingCard),
      ),
    );
    let relays = [];
    let claudeRelay = null;
    // Third-party agents RLY/0 Hub routes itself: { agentId: { relayId, model } }.
    let agentRelays = {};
    let claudeAccounts = {};
    let officialKeys = [];
    let isolation = null;
    let isolationTimer = null;
    let loadGeneration = 0;
    function scheduleIsolationPoll() {
      if (isolationTimer) {
        clearTimeout(isolationTimer);
        pollers.delete(isolationTimer);
      }
      const active = ["starting", "waitingForCode", "authorizing"].includes(
        isolation?.login?.phase,
      );
      if (!active && !["installing", "preparing"].includes(isolation?.job?.phase)) return;
      const generation = loadGeneration;
      isolationTimer = setTimeout(async () => {
        pollers.delete(isolationTimer);
        isolationTimer = null;
        if (!alive() || generation !== loadGeneration) return;
        const next = await call("agents.isolation.status").catch(() => null);
        if (!alive() || generation !== loadGeneration) return;
        // Keep the code input mounted while the person is typing/pasting an authorization code.
        if (
          isolation?.login?.phase === "waitingForCode" &&
          next?.login?.phase === "waitingForCode" &&
          isolation.login.id === next.login.id
        ) {
          isolation = next;
          scheduleIsolationPoll();
        } else load();
      }, 2500);
      pollers.add(isolationTimer);
    }
    // Agents whose relay is set up by hand (snippets): remembered for this page only.
    const manualChoice = new Map();
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
      const generation = ++loadGeneration;
      const [list, relayList, selection, auth, status, keys, isolationStatus] = await Promise.all([
        call("agents.list").catch(() => null),
        call("relay.list").catch(() => null),
        call("agents.relays.get").catch(() => ({ claudeCode: null })),
        call("agents.claudeAccounts.list").catch(() => null),
        call("agents.connectionStatus").catch(() => null),
        call("agents.officialKeys.list").catch(() => null),
        call("agents.isolation.status").catch(() => null),
      ]);
      if (!alive() || generation !== loadGeneration) return;
      isolation = isolationStatus;
      officialKeys = (keys && keys.keys) || [];
      if (!alive()) return;
      scheduleIsolationPoll();
      connections = status && status.report;
      const all = ((relayList && relayList.relays) || []).filter((relay) => relay.hasKey);
      // Claude Code's own key is the Anthropic one; the other vendors' keys serve other agents.
      relays = all.filter((relay) => relay.enabled && !isOfficialKey(relay));
      claudeRelay = selection.claudeCode;
      agentRelays = selection.agents || {};
      claudeAccounts = auth || {};
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
      const isolated = agent.id === "claude-code" && isolation?.settings?.enabled;
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
            agent.id === "claude-code"
              ? agent.installed
                ? "本地已安装"
                : "本地未安装"
              : agent.installed
                ? "已安装"
                : "未解锁",
          ),
        ),
        body,
      );
      if (agent.id === "claude-code")
        body.append(
          window.renderClaudeIsolation({
            h,
            call,
            toast,
            reload: load,
            status: isolation,
            applyToCodex,
          }),
        );
      const access = h("div");
      body.append(access);
      if (isolated) {
        access.append(
          h(
            "p",
            { class: "sub" },
            "CodexHost 将使用授权项目的沙箱登录。请重新加载助手后检测连接；沙箱失败会停止任务。",
          ),
        );
      } else if (agent.installed) {
        renderAccess(agent, access);
        access.prepend(connectionLine(agent));
      } else renderLocked(agent, access, element);
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
        // An old report may predate an install: say when it was made.
        connections.checkedAt && Date.now() - connections.checkedAt > 10 * 60_000
          ? h(
              "p",
              { class: "sub" },
              `这是 ${new Date(connections.checkedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 的检测结果，点“检测连接”重新检测`,
            )
          : null,
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
        agent.desktopOnly
          ? h(
              "p",
              { class: "warn-text" },
              "桌面版 Antigravity 已装，但命令行版 agy 没装：Codex 需要 agy，滑动下面的按钮装上它。",
            )
          : null,
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

    // "使用": one choice per installed agent: a saved account, the official key, its own login,
    // or a relay. Logins and relays are added on the 账号 and 中转站 pages; this only switches.
    function renderAccess(agent, body) {
      const native = NATIVE_MODELS[agent.id];
      const fits = (relay) => !native || relay.models.some((model) => native.pattern.test(model));
      const isClaude = agent.id === "claude-code";
      const thirdParty = !isClaude && agent.relay === "auto";
      const canRelay = agent.relay !== "none";
      const options = [];
      if (isClaude) {
        for (const account of claudeAccounts.accounts || [])
          options.push({
            value: `acct:${account.id}`,
            label: `Claude 账号 · ${account.alias}`,
            account,
          });
        if (claudeAccounts.liveUnsaved)
          options.push({
            value: "live",
            label: `Claude 账号 · ${(claudeAccounts.live && claudeAccounts.live.email) || "当前登录"}（未保存）`,
          });
        for (const key of officialKeys.filter((entry) => entry.vendor === "anthropic"))
          options.push({
            value: `key:${key.id}`,
            label: `${key.name || "官方 API Key / 订阅令牌"} · ${key.keyMask || key.id.slice(-4)}`,
            key,
          });
      } else {
        options.push({ value: "own", label: "自己的登录（官方账号）" });
        // Third-party agents can run on any vendor's official API key saved on 账号.
        if (thirdParty)
          for (const key of officialKeys)
            options.push({
              value: `relay:${key.id}`,
              label: `${VENDOR_LABELS[key.vendor] || key.vendor} 官方 API Key`,
              relay: {
                id: key.id,
                name: VENDOR_LABELS[key.vendor] || key.vendor,
                models: key.models,
                baseUrl: "",
              },
              official: true,
            });
      }
      const sortedRelays = [...relays].sort((a, b) => Number(isRly0(b)) - Number(isRly0(a)));
      if (canRelay)
        for (const relay of sortedRelays)
          options.push({
            value: `relay:${relay.id}`,
            label: `${isRly0(relay) ? "零号中转" : relay.name}${fits(relay) ? "" : `（没有 ${native.family} 模型）`}`,
            relay,
            disabled: !fits(relay),
          });

      // What is in use now.
      let current = null;
      if (isClaude) {
        if (
          claudeRelay &&
          officialKeys.some((key) => key.vendor === "anthropic" && key.id === claudeRelay)
        )
          current = `key:${claudeRelay}`;
        else if (claudeRelay) current = `relay:${claudeRelay}`;
        else {
          const live = (claudeAccounts.accounts || []).find((a) => a.current);
          current = live ? `acct:${live.id}` : claudeAccounts.liveUnsaved ? "live" : null;
        }
      } else if (thirdParty && agentRelays[agent.id])
        current = `relay:${agentRelays[agent.id].relayId}`;
      else current = manualChoice.get(agent.id) || "own";
      if (current && !options.some((o) => o.value === current)) current = null;

      const detail = h("div", { class: "access-detail" });
      const select = h(
        "select",
        { class: "input use-select", "aria-label": `${agent.name} 使用` },
        current ? null : h("option", { value: "", selected: true }, "还没有可用的登录"),
        options.map((o) =>
          h(
            "option",
            { value: o.value, selected: o.value === current, disabled: o.disabled },
            o.label,
          ),
        ),
      );
      select.addEventListener("change", () => choose(select.value));

      // A default model for agents that need one; the relay's first model when none is saved.
      const defaultModel = (target) => {
        const saved = agentRelays[agent.id];
        if (saved && saved.relayId === target.id && saved.model) return saved.model;
        const usable = target.models.filter((m) => !m.endsWith("*"));
        return usable.find((m) => /^gpt-5/iu.test(m)) || usable[0] || null;
      };

      async function choose(value) {
        const option = options.find((o) => o.value === value);
        if (!option) return;
        try {
          if (value.startsWith("acct:")) {
            const r = await call("agents.claudeAccounts.switch", { id: option.account.id });
            toast(
              r && r.switched
                ? `已切换到 ${option.account.alias}，新开的 Claude Code 对话生效`
                : "已经是这个账号",
            );
          } else if (value === "live") {
            await call("agents.relays.set", { claudeCode: null });
            toast("已改用当前的 Claude 登录");
          } else if (value.startsWith("key:")) {
            await call("agents.officialKeys.select", { vendor: "anthropic", id: value.slice(4) });
            toast("已改用官方 API Key / 订阅令牌");
          } else if (value === "own") {
            if (thirdParty)
              await call("agents.relays.setAgent", { agent: agent.id, relayId: null });
            manualChoice.set(agent.id, "own");
            toast(`${agent.name} 改用自己的登录`);
          } else if (value.startsWith("relay:")) {
            const relay = option.relay;
            if (isClaude) await call("agents.relays.set", { claudeCode: relay.id });
            else if (thirdParty)
              await call("agents.relays.setAgent", {
                agent: agent.id,
                relayId: relay.id,
                model: defaultModel(relay),
              });
            else manualChoice.set(agent.id, value);
            toast(
              agent.relay === "manual"
                ? `按下面的方法把 ${agent.name} 接到 ${relay.name}`
                : `已接入 ${relay.name}，Codex 里新开的 ${agent.name} 对话直接生效`,
            );
          }
        } catch (error) {
          failed(error);
        }
        load();
      }

      async function drawDetail() {
        const option = options.find((o) => o.value === current);
        const links = h(
          "div",
          { class: "use-links" },
          linkChip(LINK_ICONS.account, isClaude ? "管理 Claude 账号" : "管理官方 API Key", () =>
            go("accounts", { tab: isClaude ? "claude" : "codex" }),
          ),
          canRelay ? linkChip(LINK_ICONS.relay, "管理中转站", () => go("relays")) : null,
        );
        if (!option) {
          put(
            detail,
            h(
              "p",
              { class: "sub" },
              isClaude
                ? "还没有 Claude 账号或中转站。先到「账号 → Claude Code」添加账号，或到「中转站」接入零号。"
                : "先登录官方账号，或接入一个中转站。",
            ),
            links,
          );
          return;
        }
        if (option.account) {
          put(
            detail,
            claudeQuota(option.account) || h("p", { class: "sub" }, "额度读取中…"),
            links,
          );
          return;
        }
        if (!option.relay) {
          put(
            detail,
            option.value === "own" && !isClaude
              ? h(
                  "p",
                  { class: "sub" },
                  `用 ${agent.name} 自己登录的服务商。还没登录的话，点下面“登录官方账号”。`,
                )
              : null,
            links,
          );
          return;
        }
        const relay = option.relay;
        const quota = h("div", { class: "quota-line" }, h("span", { class: "sub" }, "额度读取中…"));
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
                  `${relay.name} 还没读出模型，先到「中转站」页点“编辑 / 选模型”`,
                )
              : null;
        put(
          detail,
          quota,
          modelPicker,
          agent.relay === "manual"
            ? h(
                "details",
                { class: "manual", open: true },
                h("summary", null, "接入方法"),
                h("p", { class: "sub" }, `把 ${KEY_PLACEHOLDER} 换成你在中转站后台复制的密钥。`),
                snippets(agent, relay).map(([title, text]) => codeBlock(title, text)),
              )
            : h(
                "p",
                { class: "sub" },
                "已自动接入：新开的对话通过这个中转站运行，不改你电脑上的配置。",
              ),
          links,
        );
        if (option.official) {
          put(
            quota,
            h("span", { class: "sub" }, "官方 API Key · 按用量计费，账单在官方控制台查看"),
          );
          return;
        }
        const balance = await balanceOf(relay);
        if (!alive()) return;
        if (balance && balance.available && balance.ok)
          put(
            quota,
            moneyBadge(balance.balance, balance.unit),
            typeof balance.rate === "number" ? rateBadge(balance.rate) : null,
          );
        else
          put(quota, h("span", { class: "sub" }, balance ? explain(balance.error) : "读不到余额"));
      }

      put(body, h("label", { class: "field use-field" }, h("span", null, "使用"), select), detail);
      drawDetail();
    }

    function claudeQuota(account) {
      const usage = account.lastUsage;
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

    load();
  };
};
