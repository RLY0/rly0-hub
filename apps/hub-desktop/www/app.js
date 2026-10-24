"use strict";
// RLY/0 Hub window. Talks only to the bundled hub service through the WebView bridge; every
// method name below is checked again by the shell and by the service. Text from the service is
// always set as text, never as HTML.
(() => {
  const webview = window.chrome && window.chrome.webview;

  /* ---------- Recent errors, kept in memory for "反馈问题" (only saved when asked) ---------- */
  const recentErrors = [];
  function noteError(kind, detail) {
    const text = `${new Date().toISOString()} ${kind}: ${String(detail)}`;
    recentErrors.push(text.slice(0, 500));
    if (recentErrors.length > 50) recentErrors.shift();
  }
  window.addEventListener("error", (event) =>
    noteError("error", (event.error && event.error.stack) || event.message),
  );
  window.addEventListener("unhandledrejection", (event) =>
    noteError("unhandledrejection", (event.reason && event.reason.stack) || event.reason),
  );

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
        noteError(`call ${method}`, "TIMEOUT");
        reject(new Error("TIMEOUT"));
      }, 180000);
      const failCall = (error) => {
        noteError(`call ${method}`, error && error.message);
        reject(error);
      };
      pending.set(id, { resolve, reject: failCall, timer });
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
    RLY0_CORE_BUSY: "后台正在完成上次改动，请稍后重试",
    TIMEOUT: "等太久了，稍后再试",
    INVALID_PARAMS: "填写的内容不对",
    RELAY_BASEURL_REJECTED: "地址格式不对",
    RELAY_NAME_REJECTED: "名称需要 1–40 个字",
    RELAY_KEY_REJECTED: "密钥里不能有空格",
    MCP_OPERATION_FAILED: "MCP 操作失败，请检查文件权限",
    MCP_SERVER_ALREADY_EXISTS: "这个 MCP 名称已存在",
    MCP_SERVER_NOT_FOUND: "这个 MCP 服务已不存在，请刷新",
    SKILL_OPERATION_FAILED: "Skills 操作失败，请检查文件权限",
    SKILL_SOURCE_INVALID: "文件夹里没有 SKILL.md",
    SKILL_ALREADY_EXISTS: "同名 Skill 已存在",
    SKILL_NOT_FOUND: "这个 Skill 已不存在，请刷新",
    THREAD_OPERATION_FAILED: "线程操作失败，请稍后重试",
    MAINTENANCE_OPERATION_FAILED: "维护操作失败，请检查文件权限",
    UPDATE_CHECK_FAILED: "检查更新失败，请稍后重试",
    UPDATE_RATE_LIMITED: "GitHub 暂时限制了查询次数，几分钟后再试",
    UPDATE_NETWORK: "连不上 GitHub，检查网络或在 设置→网络代理 配置代理",
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
  // "2 小时 13 分后" / "3 天后" until a quota window refills.
  function countdown(seconds) {
    const left = Math.max(0, seconds * 1000 - Date.now());
    const minutes = Math.round(left / 60000);
    if (minutes < 1) return "马上";
    if (minutes < 60) return `${minutes} 分钟后`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时 ${minutes % 60} 分后`;
    return `${Math.round(hours / 24)} 天后`;
  }
  // Icons for the three ways to sign in (fixed markup).
  const LOGIN_ICONS = {
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
    file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M12 10v7M9 14l3 3 3-3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  };
  /** A vendor's official API key, stored by rly0-core like a relay (managed on 账号, not 中转站). */
  const OFFICIAL_KEY_HOSTS = [
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "api.x.ai",
  ];
  const isOfficialKey = (relay) => {
    try {
      return OFFICIAL_KEY_HOSTS.includes(new URL(relay.baseUrl).hostname.toLowerCase());
    } catch {
      return false;
    }
  };
  function resetCardTile(count, options = {}) {
    return h(
      "div",
      { class: `reset-card cards ${count ? "" : "none"}` },
      h(
        "div",
        { class: "row" },
        h("span", { class: "reset-kind" }, "额度重置卡"),
        h("span", { class: "spacer" }),
        h(
          "b",
          { class: "tabular" },
          options.status || (Number.isInteger(count) ? `× ${count}` : "待核实"),
        ),
      ),
      h(
        "span",
        { class: "reset-when" },
        options.reason ||
          (count ? "OpenAI 官方赠送，可到账号页核实和使用" : "暂时没有官方赠送的重置卡"),
      ),
      options.onUse
        ? h("button", { class: "btn sm", type: "button", onclick: options.onUse }, options.action)
        : null,
    );
  }
  const accountName = (account) => account.alias || account.email || "Codex 账号";
  const isRly0 = (relay) => {
    try {
      return /(^|\.)rly0\.com$/i.test(new URL(relay.baseUrl).hostname);
    } catch {
      return false;
    }
  };

  /* ---------- Navigation ---------- */
  const titles = {
    home: "首页",
    agents: "AI 助手",
    relays: "中转站",
    accounts: "账号",
    backup: "备份",
    support: "支持",
    settings: "设置",
    general: "通用",
    instructions: "自定义指令",
    network: "网络代理",
    wizard: "开始使用",
    mcp: "MCP 管理",
    skills: "Skills 管理",
    threads: "线程管理",
    maintenance: "维护工具",
    updates: "更新",
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
    const railPage = SETTINGS_SECTIONS.some(([id]) => id === name) ? "settings" : name;
    document.querySelectorAll(".rail button").forEach((button) => {
      button.classList.toggle("on", button.dataset.page === railPage);
      if (button.dataset.page === railPage) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    titleEl.textContent = titles[name];
    document.body.classList.toggle("guided", name === "wizard");
    pageEl.replaceChildren();
    const alive = () => mine === generation;
    if (railPage === "settings") settingsFrame(name, alive, options || {});
    else pages[name](pageEl, alive, options || {});
    pageEl.scrollTop = 0;
    showLoading(mine);
  }

  document
    .querySelectorAll(".rail button[data-page]")
    .forEach((button) => button.addEventListener("click", () => go(button.dataset.page)));

  /* ---------- Open Codex: a floating button at the top and a rail entry ---------- */
  const fabText = document.getElementById("codexFabText");
  const fabDot = document.getElementById("codexFabDot");
  const fabEl = document.getElementById("codexFab");
  let codexRunning = false;
  // Not running: open Codex. Running (green dot): restart it, after a confirmation tap.
  let restartArmed = false;
  const confirmRestart = window.HubUI.armable(fabEl, {
    armedText: "再点一次确认重启",
    textEl: fabText,
    onExpire: () => {
      restartArmed = false;
      refreshCodexState();
    },
  });
  function openCodex() {
    if (codexRunning) {
      restartArmed = !confirmRestart();
      if (restartArmed) return;
      fabText.textContent = "正在重启…";
      call("codex.restart").then((r) => {
        toast(r.ok ? "Codex 正在重启" : "没能重启 Codex，请手动关闭后再点这里打开");
        setTimeout(refreshCodexState, 5000);
      }, failed);
      return;
    }
    call("codex.open").then((r) => {
      toast(r.ok ? "正在打开 Codex" : "没有找到 Codex 启动器");
      setTimeout(refreshCodexState, 4000);
    }, failed);
  }
  async function refreshCodexState() {
    if (restartArmed) return;
    const status = await call("codex.status").catch(() => null);
    codexRunning = Boolean(status && status.running);
    fabText.textContent = codexRunning ? "重启 Codex" : "打开 Codex";
    fabDot.classList.toggle("off", !codexRunning);
    fabEl.classList.toggle("running", codexRunning);
    fabEl.title = codexRunning ? "Codex 正在运行，点一下重启" : "打开 Codex";
  }
  document.getElementById("codexFab").addEventListener("click", openCodex);
  setTimeout(refreshCodexState, 600);
  setInterval(() => document.hidden || refreshCodexState(), 5000);
  document
    .getElementById("ad")
    .addEventListener("click", () => call("links.open", { target: "site" }).catch(failed));
  document
    .getElementById("star")
    .addEventListener("click", () => call("links.open", { target: "github" }).catch(failed));

  /* ---------- Updates: checked in the background, shown as a dot on 设置 and a prompt ---------- */
  let updateInfo = null;
  let updatePromptShown = false;
  const skippedVersion = () => {
    try {
      return localStorage.getItem("rly0.update.skip");
    } catch {
      return null;
    }
  };
  function markUpdate() {
    const available = Boolean(updateInfo && updateInfo.updateAvailable);
    const rail = document.querySelector('.rail button[data-page="settings"]');
    if (rail) {
      rail.classList.toggle("has-update", available);
      rail.title = available ? `有新版本 ${updateInfo.latestVersion}` : "";
    }
    document
      .querySelectorAll(".settings-menu button")
      .forEach((button) =>
        button.classList.toggle("has-update", available && button.textContent === "更新"),
      );
  }
  function showUpdatePrompt(force) {
    if (!updateInfo || !updateInfo.updateAvailable) return;
    if (!force && (updatePromptShown || skippedVersion() === updateInfo.latestVersion)) return;
    updatePromptShown = true;
    const ui = window.HubUI.dialog({
      title: `发现新版本 ${updateInfo.latestVersion}`,
      sub: `当前 ${updateInfo.currentVersion}，更新后功能和修复会立即生效`,
    });
    const notes = (updateInfo.releaseNotes || "").trim();
    ui.body.append(
      h(
        "div",
        { class: "update-hero" },
        h("img", { src: "brand/rly0-ip-tight.svg", alt: "" }),
        h(
          "div",
          { class: "who" },
          h("b", null, "RLY/0 Hub 有更新了"),
          h("span", null, `${updateInfo.currentVersion} → ${updateInfo.latestVersion}`),
        ),
      ),
      notes
        ? h(
            "pre",
            { class: "update-notes" },
            notes.length > 1200 ? `${notes.slice(0, 1200)}…` : notes,
          )
        : h("p", { class: "sub" }, "这次更新的说明在发布页里。"),
    );
    ui.foot.append(
      h(
        "button",
        {
          class: "btn quiet",
          type: "button",
          onclick: () => {
            try {
              localStorage.setItem("rly0.update.skip", updateInfo.latestVersion);
            } catch {
              // Remembering the skip is a convenience only.
            }
            ui.close();
          },
        },
        "跳过这个版本",
      ),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: () => ui.close() }, "稍后"),
      h(
        "button",
        {
          class: "btn paper",
          type: "button",
          onclick: () => installUpdate(ui, false),
        },
        "立即更新",
      ),
    );
  }

  /* One-click update: download in the window, verify, then the installer replaces the files and
     opens the Hub again. Codex holds the runtime open, so it is closed first (after asking). */
  const UPDATE_ERRORS = {
    UPDATE_NONE: "已经是最新版本了。",
    UPDATE_ASSET_MISSING: "这个版本的发布页里没有安装包。",
    UPDATE_ASSET_UNVERIFIED: "安装包缺少校验信息，为了安全没有安装。",
    UPDATE_VERIFY_FAILED: "下载的文件校验不通过，可能下载出错了，请重试。",
    UPDATE_DOWNLOAD_FAILED: "下载中断了，点“重试”会接着已下载的部分继续。",
    UPDATE_RATE_LIMITED: "GitHub 暂时限制了查询次数，几分钟后再试。",
    UPDATE_NETWORK: "连不上 GitHub，检查网络或在 设置→网络代理 配置代理。",
    UPDATE_CHECK_FAILED: "暂时查不到新版本的信息，请稍后重试。",
    UPDATE_UNSUPPORTED: "这个系统不支持自动更新。",
  };
  function megabytes(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  async function installUpdate(ui, closeCodex) {
    let first;
    try {
      first = await call("updates.install", closeCodex ? { closeCodex: true } : {});
    } catch (error) {
      failed(error);
      return;
    }
    if (first.needsCodexClose) {
      ui.body.replaceChildren(
        h(
          "div",
          { class: "update-hero" },
          h("img", { src: "brand/rly0-ip-tight.svg", alt: "" }),
          h(
            "div",
            { class: "who" },
            h("b", null, "需要先关闭 Codex"),
            h("span", null, "更新会替换 Codex 正在用的文件。装好后会自动重新打开 Codex。"),
          ),
        ),
      );
      ui.foot.replaceChildren(
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => ui.close() }, "稍后"),
        h(
          "button",
          { class: "btn paper", type: "button", onclick: () => installUpdate(ui, true) },
          "关闭 Codex 并更新",
        ),
      );
      return;
    }
    const bar = h("i");
    const label = h("b", null, "正在准备…");
    const detail = h("span", null, "");
    ui.body.replaceChildren(
      h(
        "div",
        { class: "update-hero" },
        h("img", { src: "brand/rly0-ip-tight.svg", alt: "" }),
        h("div", { class: "who" }, label, detail),
      ),
      h("div", { class: "update-progress" }, bar),
    );
    ui.foot.replaceChildren(h("span", { class: "spacer" }));
    const show = (state) => {
      if (state.phase === "downloading") {
        const total = state.totalBytes || 0;
        const ratio = total ? Math.min(1, state.downloadedBytes / total) : 0;
        label.textContent = `正在下载 ${state.version || ""}`.trim();
        detail.textContent = total
          ? `${megabytes(state.downloadedBytes)} / ${megabytes(total)}`
          : megabytes(state.downloadedBytes);
        bar.style.width = `${Math.round(ratio * 100)}%`;
      } else if (state.phase === "verifying") {
        label.textContent = "正在校验安装包";
        detail.textContent = "确认文件和发布页上的一致";
        bar.style.width = "100%";
      } else if (state.phase === "installing") {
        label.textContent = "正在安装";
        detail.textContent = "Hub 会关闭片刻，装好后自动重新打开";
        bar.style.width = "100%";
        bar.parentElement.classList.add("done");
      }
    };
    show(first);
    const timer = setInterval(async () => {
      const state = await call("updates.progress").catch(() => null);
      if (!state) return;
      show(state);
      if (state.phase === "error") {
        clearInterval(timer);
        label.textContent = "更新没有完成";
        detail.textContent = UPDATE_ERRORS[state.error] || "出了点问题，请重试。";
        ui.foot.replaceChildren(
          h(
            "button",
            {
              class: "btn quiet",
              type: "button",
              onclick: () => {
                call("links.open", { target: "releases" }).catch(failed);
                ui.close();
              },
            },
            "去下载页手动下载",
          ),
          h("span", { class: "spacer" }),
          h("button", { class: "btn", type: "button", onclick: () => ui.close() }, "关闭"),
          h(
            "button",
            { class: "btn paper", type: "button", onclick: () => installUpdate(ui, closeCodex) },
            "重试",
          ),
        );
      } else if (state.phase === "installing") {
        clearInterval(timer);
      }
    }, 400);
  }
  async function checkUpdates(force) {
    const result = await call("updates.status", force ? { force: true } : {}).catch(() => null);
    if (!result || result.error) return result;
    updateInfo = result;
    markUpdate();
    if (!document.hidden) showUpdatePrompt(false);
    return result;
  }
  window.rly0Updates = {
    check: checkUpdates,
    prompt: () => showUpdatePrompt(true),
    mark: markUpdate,
  };
  setTimeout(() => checkUpdates(false), 4000);
  setInterval(() => checkUpdates(false), 30 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && updateInfo && updateInfo.updateAvailable) showUpdatePrompt(false);
  });

  /* ---------- Loading: 阿零 on a dark screen until the page's first answers arrive ---------- */
  const bootEl = document.getElementById("boot");
  let loadingSince = 0;
  function showLoading(mine) {
    loadingSince = Date.now();
    bootEl.classList.add("show");
    const check = () => {
      if (mine !== generation) return;
      const accountsReady = current === "accounts" && pageEl.querySelector("[data-account-ready]");
      const settled =
        serviceReady && (accountsReady || pending.size === 0 || Date.now() - loadingSince > 2500);
      if (settled && Date.now() - loadingSince > 250) bootEl.classList.remove("show");
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  /* ---------- Pages ---------- */
  const pages = {};

  /* Settings: one rail entry with its own second-level menu. */
  const SETTINGS_SECTIONS = [
    ["general", "通用"],
    ["instructions", "自定义指令"],
    ["network", "网络代理"],
    ["backup", "备份"],
    ["mcp", "MCP"],
    ["skills", "Skills"],
    ["threads", "线程"],
    ["updates", "更新"],
  ];
  function settingsFrame(name, alive, options) {
    const section = name === "settings" ? "general" : name;
    titleEl.textContent = "设置";
    const content = h("div", { class: "settings-content" });
    const menu = h(
      "nav",
      { class: "settings-menu", "aria-label": "设置分类" },
      SETTINGS_SECTIONS.map(([id, label]) =>
        h(
          "button",
          {
            type: "button",
            class: id === section ? "on" : "",
            "aria-current": id === section ? "page" : null,
            onclick: () => go(id),
          },
          label,
        ),
      ),
    );
    pageEl.append(h("div", { class: "settings-layout" }, menu, content));
    if (window.rly0Updates) window.rly0Updates.mark();
    pages[section](content, alive, options);
  }

  /* ---------- Small graphics shared by pages ---------- */
  // Balance as a coin badge, multiplier as a ring gauge (1 = list price; less = cheaper).
  function moneyBadge(value, unit, size) {
    const coin = svg(
      '<ellipse cx="32" cy="46" rx="20" ry="7" fill="none" stroke="currentColor" stroke-width="4"/><path d="M12 46v-8M52 46v-8" stroke="currentColor" stroke-width="4"/><ellipse cx="32" cy="38" rx="20" ry="7" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="4"/><path d="M12 38v-10M52 38v-10" stroke="currentColor" stroke-width="4"/><ellipse cx="32" cy="27" rx="20" ry="7" fill="currentColor" fill-opacity=".35" stroke="currentColor" stroke-width="4"/>',
    );
    // Crop to the coins so they read as large as the rate ring next to them.
    coin.setAttribute("viewBox", "6 12 52 52");
    return h(
      "span",
      { class: `money-badge ${size || ""}` },
      coin,
      h("b", { class: "tabular" }, money(value, unit)),
    );
  }
  function rateBadge(rate, tone) {
    const length = 163.4;
    const fill = Math.max(0.04, Math.min(1, rate));
    const saving =
      rate < 1
        ? `省 ${Math.round((1 - rate) * 100)}%`
        : rate > 1
          ? `贵 ${Math.round((rate - 1) * 100)}%`
          : "官方价";
    return h(
      "span",
      { class: `rate-badge ${tone || ""}`, title: `价格倍率 ×${rate}（相对官方价）` },
      svg(
        `<circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width="8"/><circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(fill * length).toFixed(1)} ${length}" transform="rotate(-90 32 32)"/>`,
      ),
      h(
        "span",
        { class: "rate-text" },
        h("b", { class: "tabular" }, `×${rate}`),
        h("small", null, saving),
      ),
    );
  }

  const pageApi = {
    pages,
    h,
    call,
    recentErrors: () => recentErrors.slice(),
    toast,
    failed,
    explain,
    money,
    isRly0,
    isOfficialKey,
    pollers,
    svg,
    go,
    resetText,
    countdown,
    resetCardTile,
    LOGIN_ICONS,
    accountName,
    moneyBadge,
    rateBadge,
  };
  pageApi.applyToCodex = window.registerHubCodexApply(pageApi).apply;
  Object.assign(pageApi, window.registerHubResources(pageApi));
  window.registerHubSystem(pageApi);
  Object.assign(pageApi, window.registerHubDiscovery(pageApi));
  window.registerHubAgents(pageApi);
  const relayModule = window.registerHubRelays(pageApi);
  pageApi.relayStrip = relayModule.relayStrip;
  pageApi.relayLogo = relayModule.relayLogo;
  window.registerHubHome(pageApi);
  window.registerHubInstructions(pageApi);
  const cards = window.registerHubAccountCards(pageApi);
  pageApi.accountCards = cards;
  pageApi.agentAccounts = window.registerHubAgentAccounts(pageApi);

  const STEP = {
    installingNode: "正在安装 Node.js",
    installingGit: "正在安装 Git",
    officialInstaller: "正在用官方安装器安装",
    installerWindow: "请在弹出的安装窗口里完成安装",
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

  const REQUIREMENT_REASONS = {
    WINGET_UNAVAILABLE: "系统没有可用的 winget，请手动安装 Node.js 后重试",
    NETWORK: "下载 Node.js 失败，请检查网络后重试",
    PERMISSION: "安装 Node.js 没有获得权限，请手动安装后重试",
    INSTALL_FAILED: "winget 没能装好 Node.js，请手动安装后重试",
    NOT_DETECTED: "安装后仍找不到 npm，请安装含 npm 的 Node.js 后重试",
  };

  // 账号: one tab per provider, all in the same layout (pages/account-cards.js).
  const ACCOUNT_TABS = [
    ["codex", "openai", "OpenAI", "Codex"],
    ["claude", "anthropic", "Anthropic", "Claude"],
    ["gemini", "google", "Google", "Gemini"],
    ["grok", "xai", "xAI", "Grok"],
  ];
  let accountTab = "codex";
  pages.accounts = (root, alive, options) => {
    if (options && options.tab) accountTab = options.tab;
    const body = h("div", { class: "account-tab-body" });
    root.append(
      h(
        "nav",
        { class: "settings-menu account-tabs", "aria-label": "账号分类" },
        ACCOUNT_TABS.map(([id, mark, provider, product]) =>
          h(
            "button",
            {
              type: "button",
              class: `provider-tab ${id === accountTab ? "on" : ""}`,
              "aria-current": id === accountTab ? "page" : null,
              "aria-label": `${provider} · ${product}`,
              onclick: () => go("accounts", { tab: id }),
            },
            h(
              "span",
              { class: "provider-mark" },
              cards.icon(`<path d="${window.HubProviderMarks[mark]}"/>`),
            ),
            h(
              "span",
              { class: "provider-name" },
              h("b", null, provider),
              h("small", null, product),
            ),
          ),
        ),
      ),
      pageApi.discoveryBanner(alive, () => go("accounts", { tab: accountTab })),
      body,
    );
    if (accountTab === "claude") pageApi.agentAccounts.claude(body, alive);
    else if (accountTab === "gemini") pageApi.agentAccounts.gemini(body, alive);
    else if (accountTab === "grok") pageApi.agentAccounts.grok(body, alive);
    else codexAccountsPage(body, alive);
  };

  function codexAccountsPage(root, alive) {
    const list = h("div", { class: "grid compact" });
    // Browser sign-in into a throw-away Codex home; the live Codex login is never touched.
    const LOGIN_ERRORS = {
      CODEX_NOT_FOUND: "没找到 Codex，请先安装官方 Codex 桌面版",
      CODEX_START_FAILED: "Codex 没能启动，请稍后再试",
      RLY0_CORE_UNAVAILABLE: "后台服务还没准备好，请稍后再试",
      AUTH_FILE_INVALID: "这个文件不是有效的 JSON",
      AUTH_FILE_NOT_A_LOGIN:
        "文件里没有 Codex 登录（支持 Codex 的 auth.json 和 Sub2API 导出的账号文件）",
      API_KEY_INVALID: "API Key 格式不对，应以 sk- 开头",
      AUTH_IDENTITY_UNKNOWN: "读不出这个登录属于哪个账号",
    };
    const loginFailed = (error) =>
      toast(LOGIN_ERRORS[error && error.message] || explain(error && error.message));
    // The OpenAI platform key, for agents other than Codex (Pi, Hermes, OpenCode…).
    const key = cards.keyCard("openai", { alive, saveFailed: loginFailed });
    let failures = new Map();
    let accountCount = 0;
    const refresh = cards.refresher({
      alive,
      run: async () => {
        failures = cards.usageFailures(await call("accounts.usageAll"));
        await load();
        return failures.size;
      },
    });
    const head = cards.pageHead({
      intro: "保存多个 Codex 登录，一键切换。",
      refresh: refresh.element,
      saveCurrent: {
        onClick: () =>
          call("accounts.importCurrent", {}).then((r) => {
            toast(r.available ? "已保存当前登录" : "没有找到当前登录");
            load();
          }, failed),
      },
      addItems: [
        {
          icon: LOGIN_ICONS.web,
          title: "网页登录",
          desc: "在浏览器里登录另一个 ChatGPT 账号",
          onSelect: () => addAccount(),
        },
        {
          icon: LOGIN_ICONS.file,
          title: "导入登录文件",
          desc: "Codex 的 auth.json，或 Sub2API 导出的账号 JSON",
          onSelect: () => filePicker.click(),
        },
        {
          icon: LOGIN_ICONS.key,
          title: "官方 API Key",
          desc: "填 OpenAI 的 sk- Key，按用量计费；Pi、Hermes 等助手也能用",
          onSelect: () => showApiKeyForm(),
        },
      ],
    });
    const addStatus = h("div");

    // A Codex auth.json picked from disk (e.g. copied from another computer).
    const filePicker = h("input", { type: "file", accept: ".json,application/json", hidden: true });
    filePicker.addEventListener("change", () => {
      const file = filePicker.files && filePicker.files[0];
      filePicker.value = "";
      if (!file) return;
      if (file.size > 256 * 1024) {
        toast("文件太大，不像是 auth.json");
        return;
      }
      file.text().then((content) =>
        call("accounts.importAuthFile", { content }).then((result) => {
          toast(
            result && result.count > 1 ? `已导入 ${result.count} 个账号` : "已导入并保存这个账号",
          );
          load();
        }, loginFailed),
      );
    });

    // An OpenAI API key, saved as an API-key login (and as the OpenAI key for other agents).
    function showApiKeyForm() {
      const input = h("input", {
        class: "input",
        type: "password",
        placeholder: "sk-…",
        autocomplete: "off",
        spellcheck: "false",
        "aria-label": "OpenAI API Key",
      });
      const name = h("input", {
        class: "input",
        maxlength: "40",
        placeholder: "名称（可不填）",
        "aria-label": "账号名称",
      });
      const save = () =>
        call("accounts.addApiKey", {
          apiKey: input.value.trim(),
          ...(name.value.trim() ? { alias: name.value.trim() } : {}),
        }).then(() => {
          // The same key also serves other agents (Pi, Hermes, OpenCode) as the OpenAI key.
          call("agents.officialKeys.set", { vendor: "openai", apiKey: input.value.trim() })
            .then(() => key.reload())
            .catch(() => undefined);
          toast("API Key 已保存：切换到它后 Codex 用它，Pi、Hermes 等助手也能选它");
          addStatus.replaceChildren();
          load();
        }, loginFailed);
      addStatus.replaceChildren(
        h(
          "section",
          { class: "m tone add-login" },
          h(
            "div",
            { class: "row" },
            h("b", null, "用 OpenAI API Key 登录"),
            h("span", { class: "spacer" }),
            h(
              "button",
              { class: "btn quiet sm", type: "button", onclick: () => addStatus.replaceChildren() },
              "取消",
            ),
          ),
          h(
            "p",
            { class: "sub" },
            "保存为一个账号，切换到它后 Codex 按用量从这个 Key 扣费；Pi、Hermes、OpenCode 等助手也能用它。Key 加密保存在本机，不会显示出来。",
          ),
          h(
            "div",
            { class: "form" },
            input,
            name,
            h(
              "div",
              { class: "row" },
              h("button", { class: "btn paper", type: "button", onclick: save }, "保存"),
            ),
          ),
        ),
      );
      input.focus();
    }
    async function addAccount() {
      let started;
      try {
        started = await call("accounts.addLoginStart", {});
      } catch (error) {
        toast(LOGIN_ERRORS[error.message] || explain(error.message));
        return;
      }
      const cancel = h(
        "button",
        {
          class: "btn quiet sm",
          type: "button",
          onclick: () => call("accounts.addLoginCancel", { id: started.id }).catch(() => undefined),
        },
        "取消",
      );
      addStatus.replaceChildren(
        h(
          "section",
          { class: "m tone add-login" },
          h(
            "div",
            { class: "row" },
            h("span", { class: "pulse" }),
            h("b", null, "已在浏览器打开 ChatGPT 登录页"),
            h("span", { class: "spacer" }),
            cancel,
          ),
          h(
            "p",
            { class: "sub" },
            "用要添加的账号登录，完成后这里会自动保存。你当前在 Codex 里的登录不受影响。",
          ),
          started.url ? h("p", { class: "sub tabular login-url" }, started.url) : null,
        ),
      );
      const timer = setInterval(async () => {
        const status = await call("accounts.addLoginStatus", { id: started.id }).catch(() => null);
        if (!alive() || !status || status.state === "pending") return;
        clearInterval(timer);
        pollers.delete(timer);
        addStatus.replaceChildren();
        if (status.state === "completed") {
          toast("新账号已保存");
          load().then(() => refresh.refresh());
        } else if (status.state === "failed") toast(LOGIN_ERRORS[status.error] || "登录没有完成");
      }, 2000);
      pollers.add(timer);
    }
    root.append(
      head,
      filePicker,
      addStatus,
      h("div", { class: "grid compact account-auto" }, cards.autoSwitchCard({ alive })),
      list,
    );

    async function load() {
      const [result, live] = await Promise.all([
        call("accounts.list").catch(() => null),
        call("accounts.current").catch(() => null),
      ]);
      if (!alive()) return;
      const accounts = (result && result.available && result.accounts) || [];
      accountCount = accounts.length;
      refresh.setReason(accountCount ? null : "还没有保存的 Codex 账号，没有额度可刷新");
      const unsaved =
        live && live.loggedIn && !live.saved
          ? cards.accountCard({
              name: live.email || "当前 Codex 登录",
              facts: [live.plan ? live.plan.toUpperCase() : "当前登录"],
              current: true,
              quota: cards.quotaCards(null, { reason: "保存后会读取它的额度" }),
              notes: [h("p", { class: "sub" }, "还没保存。保存后可以和其他账号一键切换。")],
              actions: [
                h(
                  "button",
                  {
                    class: "btn paper sm",
                    type: "button",
                    onclick: () =>
                      call("accounts.importCurrent", {}).then(() => {
                        toast("已保存");
                        load();
                      }, failed),
                  },
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
                "还没有保存的 Codex 账号。先在 Codex 里登录，再点“保存当前登录”。",
              ),
            ]),
        key.element,
      );
      list.dataset.accountReady = "true";
    }

    function card(account) {
      return cards.accountCard({
        name: accountName(account),
        onRename: (alias) =>
          call("accounts.rename", { id: account.id, alias }).then((result) => {
            if (!result || !result.available || !result.ok)
              throw new Error("RLY0_CORE_UNAVAILABLE");
            return load();
          }),
        facts: [
          account.email && account.alias ? account.email : null,
          account.plan ? account.plan.toUpperCase() : null,
        ],
        current: account.current,
        quota: cards.quotaCards(account.lastUsage, {
          reset: {
            vendor: account.plan === "api-key" ? "api-key" : "openai",
            account,
            refreshed: async () => {
              await call("accounts.usage", { id: account.id });
              await load();
            },
          },
          reason: "额度未知：切换到这个账号后会读取",
          stale: failures.get(account.id),
        }),
        actions: account.current
          ? []
          : [
              h(
                "button",
                {
                  class: "btn paper sm",
                  type: "button",
                  onclick: async () => {
                    // Switch, then reload Codex's backend in place (no window restart).
                    toast("正在切换…");
                    const r = await call("accounts.switchAndRestart", { id: account.id }).catch(
                      () => null,
                    );
                    if (!r || !r.switched) {
                      toast("切换没有成功");
                      return;
                    }
                    toast(
                      r.reloaded === "reloaded"
                        ? "已切换，Codex 不用重启，接着发消息就是新账号"
                        : r.reloaded === "deferred"
                          ? "已切换，Codex 正在回复，回复完自动换成新账号"
                          : r.restarted
                            ? "已切换，Codex 正在重启"
                            : "已切换，下次打开 Codex 生效",
                    );
                    load();
                  },
                },
                "切换到这个",
              ),
            ],
        onRemove: () => call("accounts.remove", { id: account.id }).then(() => load()),
      });
    }
    load().then(() => {
      if (alive() && accountCount) refresh.refresh();
    });
  }

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
      let confirmTap = () => true;
      const restore = h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: async () => {
            if (!confirmTap()) return;
            const result = await call("backup.restore").catch(() => null);
            load();
            if (result && result.ok) await pageApi.applyToCodex("backend", "已恢复到安装前的设置");
            else toast("恢复没有成功");
          },
        },
        "恢复到安装前",
      );
      confirmTap = window.HubUI.armable(restore, { armedText: "确认恢复" });
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

  pages.general = (root, alive) => {
    // Tray-notice thresholds: when to warn about 零号's balance and the Codex 5-hour quota.
    const alertCard = h("section", { class: "m span-6" });
    call("alerts.settingsGet")
      .then((settings) => {
        if (!alive() || !settings) return;
        const choose = (label, value, options) =>
          h(
            "select",
            { class: "input compact-select", "aria-label": label },
            options.map(([v, text]) =>
              h("option", { value: String(v), selected: v === value }, text),
            ),
          );
        const balance = choose("余额提醒", settings.balanceUsd, [
          [0, "不提醒"],
          [1, "低于 $1"],
          [5, "低于 $5"],
          [10, "低于 $10"],
          [20, "低于 $20"],
        ]);
        const quota = choose("额度提醒", settings.quotaUsedPercent, [
          [80, "用掉 80%"],
          [90, "用掉 90%"],
          [95, "用掉 95%"],
          [100, "不提醒"],
        ]);
        const save = () =>
          call("alerts.settingsSet", {
            balanceUsd: Number(balance.value),
            quotaUsedPercent: Number(quota.value),
          }).then(() => toast("已保存"), failed);
        balance.addEventListener("change", save);
        quota.addEventListener("change", save);
        alertCard.append(
          h(
            "div",
            { class: "who" },
            h("b", null, "托盘提醒"),
            h("span", null, "到这里时，右下角弹一次提醒"),
          ),
          h(
            "div",
            { class: "row auto-switch-fields" },
            h("label", { class: "field" }, h("span", null, "零号余额"), balance),
            h("label", { class: "field" }, h("span", null, "Codex 5 小时额度"), quota),
          ),
        );
      })
      .catch(() => undefined);
    // Interface size: the window's zoom (also Ctrl + wheel, Ctrl +/-/0), remembered by the shell.
    const sizeCard = h("section", { class: "m span-6" });
    const SIZES = [
      [0.9, "小"],
      [1, "标准"],
      [1.1, "大"],
      [1.25, "较大"],
      [1.4, "特大"],
    ];
    const drawSizes = (zoom) => {
      sizeCard.replaceChildren(
        h(
          "div",
          { class: "who" },
          h("b", null, "界面大小"),
          h(
            "span",
            null,
            `当前 ${Math.round(zoom * 100)}%，只对这次有效；重开 Hub 会回到默认的“大”（110%）`,
          ),
        ),
        h(
          "div",
          { class: "zoom-steps", role: "radiogroup", "aria-label": "界面大小" },
          SIZES.map(([value, label]) =>
            h(
              "button",
              {
                type: "button",
                role: "radio",
                class: Math.abs(zoom - value) < 0.01 ? "on" : "",
                "aria-checked": String(Math.abs(zoom - value) < 0.01),
                onclick: () =>
                  call("window.zoomSet", { zoom: value }).then(
                    (r) => alive() && drawSizes(r.zoom),
                    failed,
                  ),
              },
              h("b", null, label),
              h("span", null, `${Math.round(value * 100)}%`),
            ),
          ),
        ),
      );
    };
    call("window.zoomGet")
      .then((r) => alive() && r && drawSizes(r.zoom))
      .catch(() => undefined);
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
    root.append(
      h(
        "div",
        { class: "grid compact" },
        sizeCard,
        autostart,
        about,
        alertCard,
        h(
          "section",
          { class: "m span-6" },
          h("h3", null, "Codex 内工具"),
          h(
            "p",
            { class: "sub" },
            "在 Codex 里右键 RLY/0 图标：自定义启动命令、浏览器添加账号、导入会话、界面和额度提示。",
          ),
        ),
      ),
    );
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

  pages.support = (root) => {
    const qr = (src, label) =>
      h(
        "figure",
        { class: "qr" },
        h("img", { src, alt: `${label}赞赏码`, width: "180", height: "180" }),
        h("figcaption", null, label),
      );
    root.append(
      h(
        "div",
        { class: "grid compact" },
        h(
          "section",
          { class: "m tone span-3" },
          h("div", { class: "row" }, githubMark(28), h("span", { class: "label" }, "Open source")),
          h("h3", { class: "big" }, "Star 支持"),
          h("p", { class: "sub" }, "RLY/0 Hub 免费开源。觉得有用，就去 GitHub 点个 Star。"),
          h(
            "div",
            { class: "row" },
            h(
              "button",
              {
                class: "btn paper",
                type: "button",
                onclick: () => call("links.open", { target: "github" }).catch(failed),
              },
              "去 GitHub 点 Star",
            ),
          ),
        ),
        h(
          "section",
          { class: "m span-3" },
          h("span", { class: "label" }, "Author-run relay"),
          h("h3", { class: "big" }, "RLY/0 零号中转"),
          h("p", { class: "sub" }, "作者自营。用零号中转，也是在支持这个项目。"),
          h(
            "div",
            { class: "row" },
            h(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: () => call("links.open", { target: "site" }).catch(failed),
              },
              "rly0.com",
            ),
          ),
        ),
        h(
          "section",
          { class: "m span-6" },
          h("span", { class: "label" }, "Buy me a coffee"),
          h("h3", { class: "big" }, "请作者喝杯咖啡"),
          h("p", { class: "sub" }, "自愿赞助，不影响任何功能。"),
          h(
            "div",
            { class: "row qrs" },
            qr("support/sponsor-wechat.jpg", "微信"),
            qr("support/sponsor-alipay.jpg", "支付宝"),
          ),
        ),
      ),
    );
  };

  function githubMark(size) {
    const mark = svg(
      '<path fill="currentColor" d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.467-1.334-5.467-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.405c1.02.005 2.045.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
    );
    mark.setAttribute("viewBox", "0 0 24 24");
    mark.setAttribute("width", String(size));
    mark.setAttribute("height", String(size));
    return mark;
  }

  /* ---------- First-run guide ---------- */
  const RLY0_BASE_URL = "https://api.rly0.com/v1";

  pages.wizard = (root, alive) => {
    let step = 0;
    const state = { relayId: null };
    const body = h("section", { class: "m wizard-card" });
    const dots = h("div", { class: "steps", "aria-hidden": "true" });
    root.append(h("div", { class: "wizard" }, dots, body));

    const finish = async (openCodex) => {
      await call("hub.finishOnboarding").catch(() => undefined);
      if (openCodex) call("codex.open").catch(() => undefined);
      go("home");
    };
    const skip = () =>
      h("button", { class: "btn quiet", type: "button", onclick: () => finish(false) }, "跳过引导");
    const next = () => {
      step += 1;
      render();
    };

    function frame(label, title, text, ...content) {
      dots.replaceChildren(
        ...[0, 1, 2, 3].map((i) => h("i", { class: i === step ? "on" : i < step ? "done" : "" })),
      );
      body.replaceChildren(
        h("span", { class: "label" }, label),
        h("h2", { class: "big" }, title),
        text ? h("p", { class: "sub" }, text) : null,
        ...content,
      );
    }

    async function relayStep() {
      const relays = await call("relay.list").catch(() => null);
      if (!alive()) return;
      const existing = ((relays && relays.relays) || []).find((r) => r.hasKey && isRly0(r));
      if (existing) {
        state.relayId = existing.id;
        frame(
          "RLY/0 零号中转",
          "零号中转已接入",
          `已在用「${existing.name}」。`,
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn paper", type: "button", onclick: next }, "下一步"),
          ),
        );
        return;
      }
      const key = h("input", {
        class: "input",
        type: "password",
        placeholder: "粘贴零号中转的 API 密钥 sk-…",
        autocomplete: "off",
        spellcheck: "false",
      });
      const connect = h("button", { class: "btn red", type: "button" }, "接入");
      connect.addEventListener("click", async () => {
        const apiKey = key.value.trim();
        if (!apiKey) {
          toast("先粘贴密钥");
          return;
        }
        connect.disabled = true;
        connect.textContent = "接入中…";
        try {
          const added = await call("relay.add", {
            name: "零号中转",
            baseUrl: RLY0_BASE_URL,
            apiKey,
          });
          if (!added.available) throw new Error("HUB_ERROR");
          const test = await call("relay.test", { id: added.id }).catch(() => null);
          if (test && test.available && !test.ok)
            toast(`已保存，但测试没通过：${explain(test.error)}`);
          state.relayId = added.id;
          next();
        } catch (error) {
          failed(error);
          connect.disabled = false;
          connect.textContent = "接入";
        }
      });
      frame(
        "RLY/0 零号中转",
        "接入零号中转",
        "一个密钥，Claude、GPT 等模型都能用。没有账号可以先注册。",
        h("div", { class: "row wide" }, key, connect),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => call("links.open", { target: "site" }).catch(failed),
            },
            "注册零号中转",
          ),
          h("button", { class: "btn quiet", type: "button", onclick: next }, "暂时不用"),
        ),
      );
    }

    async function claudeStep() {
      const agents = await call("agents.list").catch(() => null);
      if (!alive()) return;
      const claude = agents && agents.agents.find((a) => a.id === "claude-code");
      if (claude && claude.installed) {
        const useRelay = async () => {
          await call("agents.relays.set", { claudeCode: state.relayId }).catch(() => undefined);
          toast("Claude Code 会通过零号中转运行");
          next();
        };
        frame(
          "Claude Code",
          "Claude Code 已安装",
          state.relayId
            ? "让它用零号中转，不用另外登录 Claude 账号。"
            : "之后可以在 AI 助手里登录。",
          h(
            "div",
            { class: "row" },
            state.relayId
              ? h(
                  "button",
                  { class: "btn paper", type: "button", onclick: useRelay },
                  "用零号中转运行",
                )
              : null,
            h(
              "button",
              { class: state.relayId ? "btn quiet" : "btn paper", type: "button", onclick: next },
              state.relayId ? "我用自己的账号" : "下一步",
            ),
          ),
        );
        return;
      }
      const status = h("p", { class: "sub" });
      const install = h("button", { class: "btn paper", type: "button" }, "一键安装 Claude Code");
      install.addEventListener("click", async () => {
        install.disabled = true;
        install.textContent = "安装中…";
        await call("agents.installStart", { agent: "claude-code" }).catch(() => undefined);
        const timer = setInterval(async () => {
          const s = await call("agents.installStatus", { agent: "claude-code" }).catch(() => null);
          if (!alive() || !s) return;
          if (s.state === "running") {
            status.textContent = STEP[s.step] || "安装中…";
            return;
          }
          clearInterval(timer);
          pollers.delete(timer);
          if (s.state === "succeeded") {
            toast("Claude Code 装好了");
            claudeStep();
          } else {
            status.textContent = INSTALL_ERRORS[s.error] || "安装没有成功，稍后可在 AI 助手里重试";
            install.disabled = false;
            install.textContent = "重试";
          }
        }, 1500);
        pollers.add(timer);
      });
      frame(
        "Claude Code",
        "装上 Claude Code",
        "Anthropic 官方编程助手，装好就能在 Codex 里用。需要几分钟。",
        status,
        h(
          "div",
          { class: "row" },
          install,
          h("button", { class: "btn quiet", type: "button", onclick: next }, "暂时不装"),
        ),
      );
    }

    function render() {
      if (!alive()) return;
      if (step === 0) {
        frame(
          "Welcome",
          "一个窗口，管好所有 AI",
          "Codex、Claude Code、Grok 等 AI 助手，接入、登录、额度都在这里。",
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn paper", type: "button", onclick: next }, "开始"),
            skip(),
          ),
        );
      } else if (step === 1) relayStep();
      else if (step === 2) claudeStep();
      else
        frame(
          "Done",
          "准备好了",
          "关掉窗口后它在托盘里待命，从托盘图标随时打开。",
          h(
            "div",
            { class: "row" },
            h(
              "button",
              { class: "btn paper", type: "button", onclick: () => finish(true) },
              "打开 Codex",
            ),
            h("button", { class: "btn", type: "button", onclick: () => finish(false) }, "进入首页"),
          ),
        );
    }
    render();
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
          saved: true,
        },
      },
      "agents.list": {
        agents: [
          ["claude-code", "Claude Code", "Anthropic", "official", false, "auto", true],
          ["antigravity", "Antigravity", "Google", "official", false, "none", false],
          ["grok", "Grok", "xAI", "official", false, "manual", false],
          ["opencode", "OpenCode", "OpenCode", "community", true, "manual", true],
          ["pi", "Pi", "Pi", "community", true, "manual", true],
          ["hermes", "Hermes", "Nous Research", "community", true, "none", true],
          ["cursor-cli", "Cursor", "Cursor", "community", false, "none", false],
          ["kiro-cli", "Kiro", "AWS", "community", false, "none", false],
        ].map(([id, name, vendor, category, openSource, relay, installed]) => ({
          id,
          name,
          vendor,
          category,
          openSource,
          relay,
          installed,
          automatic: true,
          canOpenLogin: true,
          manualCommand: "npm install -g opencode-ai",
          // Only the Antigravity desktop app is installed here, not agy.
          ...(id === "antigravity" ? { desktopOnly: true } : {}),
        })),
      },
      "balance.get": {
        configured: true,
        available: true,
        ok: true,
        valid: true,
        balance: 86.4,
        unit: "USD",
        todayCost: 3.12,
        totalCost: 214.6,
        rate: 0.3,
      },
      "accounts.usage": {
        available: true,
        usage: {
          windows: [
            { kind: "primary", usedPercent: 36, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
            {
              kind: "secondary",
              usedPercent: 19,
              resetsAt: Math.floor(Date.now() / 1000) + 500000,
            },
          ],
          resetCredits: 2,
          source: "live",
        },
      },
      "relay.list": {
        available: true,
        relays: [
          {
            id: "aaaaaaaaaaaa",
            name: "零号中转",
            baseUrl: "https://api.rly0.com/v1",
            protocol: "responses",
            models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
            enabled: true,
            hasKey: true,
            keyMask: "****9Zq1",
            addedAt: "",
            updatedAt: "",
          },
        ],
      },
      "proxy.status": { available: true, running: true, port: 25917 },
      "codex.status": { running: true, canOpen: true },
      "window.zoomGet": { zoom: 1.1, steps: [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6] },
      "window.zoomSet": { zoom: 1.1, steps: [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6] },
      "updates.install": {
        phase: "downloading",
        version: "0.11.1",
        downloadedBytes: 0,
        totalBytes: 27338348,
        error: null,
        needsCodexClose: false,
      },
      "updates.progress": {
        phase: "downloading",
        version: "0.11.1",
        downloadedBytes: 11534336,
        totalBytes: 27338348,
        error: null,
      },
      "updates.status": {
        currentVersion: "0.10.2",
        latestVersion: "0.11.0",
        updateAvailable: true,
        installation: null,
        installationAvailable: false,
        status: null,
        releaseNotes: [
          "· 首页阿零会眨眼、看鼠标了",
          "· 后台自动检查更新",
          "· 托盘菜单重新设计",
        ].join(String.fromCharCode(10)),
        releaseNotesUrl: null,
        error: null,
      },
      "agents.officialKeys.list": {
        keys: [
          {
            vendor: "xai",
            id: "bbbbbbbbbbbb",
            keyMask: "****Ab12",
            models: ["grok-4", "grok-4-fast"],
          },
        ],
      },
      "agents.claudeCode.keyInfo": {
        info: {
          kind: "subscription",
          last4: "ab12",
          email: "me@example.com",
          plan: "max",
          valid: true,
          usage: {
            windows: [
              { kind: "primary", usedPercent: 20, resetsAt: Math.floor(Date.now() / 1000) + 6000 },
              {
                kind: "secondary",
                usedPercent: 55,
                resetsAt: Math.floor(Date.now() / 1000) + 300000,
              },
            ],
          },
        },
      },
      "relay.balance": { available: true, ok: true, balance: 86.4, unit: "USD", rate: 0.3 },
      "agents.claudeCode.status": { installed: true, loggedIn: false },
      "agents.relays.get": { claudeCode: "aaaaaaaaaaaa" },
      "agents.installStatus": { state: "idle", automatic: true },
      "accounts.current": { loggedIn: true, saved: true, email: "me@example.com", plan: "plus" },
      "accounts.usageCurrent": {
        available: true,
        usage: {
          windows: [
            { kind: "primary", usedPercent: 36, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
            {
              kind: "secondary",
              usedPercent: 19,
              resetsAt: Math.floor(Date.now() / 1000) + 500000,
            },
          ],
          resetCredits: 2,
          source: "live",
        },
      },
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
      "accounts.autoSwitchGet": { enabled: false, remain5h: 15, remainWeekly: 10, mode: "ask" },
      "alerts.settingsGet": { balanceUsd: 1, quotaUsedPercent: 90 },
      "instructions.state": {
        filePath: "C:/Users/me/.codex/AGENTS.md",
        fileExists: true,
        managed: true,
        protected: false,
        content: "始终用简体中文回答和写说明；代码、命令、文件名和报错原文保持原样。",
        otherBlocks: [],
        templates: [
          {
            id: "chinese",
            name: "用中文交流",
            content: "始终用简体中文回答和写说明；代码、命令、文件名和报错原文保持原样。",
          },
          { id: "concise", name: "简洁直接", content: "回答先给结论，再给必要的理由。" },
          {
            id: "plan-first",
            name: "先计划再动手",
            content: "改动超过一个文件时，先列出要改的文件和步骤。",
          },
        ],
        history: [
          {
            id: "001792150000-abc",
            at: 1792150000,
            action: "apply",
            template: "chinese",
            preview: "始终用简体中文回答和写说明",
          },
          { id: "001792140000-def", at: 1792140000, action: "clear", preview: "" },
        ],
      },
      "instructions.preview": {
        current: "始终用简体中文回答。",
        next: "始终用简体中文回答。\n回答先给结论。",
      },
      "relay.noAccountStatus": {
        enabled: false,
        configPath: "C:/Users/me/.codex/config.toml",
        models: ["gpt-6.1-sol", "gpt-5.5"],
      },
      "relay.noAccountPreview": {
        configPath: "C:/Users/me/.codex/config.toml",
        changes: [
          '[model_providers.rly0] base_url = "http://127.0.0.1:25917/v1"',
          "[model_providers.rly0] requires_openai_auth = false",
          'model_provider = "rly0" （原来没有）',
          'model = "gpt-6.1-sol" （原来是 "gpt-5.5"）',
        ],
      },
      "hub.state": { onboarded: !/[?&]wizard/.test(location.search) },
      "discovery.scan": {
        coreAvailable: true,
        items: [
          {
            id: "0123456789abcdef",
            kind: "officialKey",
            vendor: "anthropic",
            name: "Claude 订阅令牌",
            baseUrl: null,
            keyMask: "····QwAA",
            source: "环境变量 CLAUDE_CODE_OAUTH_TOKEN",
            agent: "claude",
            model: null,
            state: "new",
          },
          {
            id: "1123456789abcdef",
            kind: "relay",
            vendor: "openai",
            name: "api.shuaiapi.com",
            baseUrl: "https://api.shuaiapi.com/v1",
            keyMask: "····7777",
            source: "~/.codex/config.toml（custom）",
            agent: "codex",
            model: "gpt-5.5",
            state: "new",
          },
          {
            id: "2123456789abcdef",
            kind: "relay",
            vendor: "anthropic",
            name: "relay.example.com",
            baseUrl: "https://relay.example.com",
            keyMask: "····9999",
            source: "~/.claude/settings.json",
            agent: "claude",
            model: null,
            state: "differs",
          },
        ],
      },
      "discovery.import": {
        results: [{ id: "0123456789abcdef", ok: true }],
        imported: 3,
      },
    };
    // The mock answers { __error: CODE } to exercise a failed call.
    const result = window.hubManagementMock(message) || data[message.method] || { ok: true };
    setTimeout(
      () =>
        onMessage(
          result.__error
            ? { id: message.id, error: { message: result.__error } }
            : { id: message.id, result },
        ),
      result.__delay || 120,
    );
  }

  if (!webview) onMessage({ event: "ready" });
  go("home");
  call("hub.state")
    .then((state) => {
      if (!state.onboarded) go("wizard");
    })
    .catch(() => undefined);
})();
