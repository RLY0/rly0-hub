"use strict";
// 账号 → “+ 添加” → 网页登录: add another account without signing the current one out. The Hub
// runs the agent's official login command in a throw-away config folder (Claude Code: `claude auth
// login` in its own CLAUDE_CONFIG_DIR, claude-add-login.ts; Grok: `grok login` in its own
// GROK_HOME, grok-add-login.ts); the CLI opens the official page in the browser and usually
// finishes on its own. For Claude, a code the page shows can be pasted here and goes straight to
// that CLI; it is never kept or shown.
(() => {
  const COMMON = {
    LOGIN_NOT_COMPLETED: "没有找到这次登录的结果，请重新添加",
    IMPORT_PATH_REJECTED: "临时登录目录不对，请重新添加",
    METHOD_NOT_FOUND: "后台核心版本太旧，请先更新 RLY/0 Hub",
    RLY0_CORE_UNAVAILABLE: "后台服务还没准备好，请稍后再试",
  };
  const flowErrors = (prefix, agent) => ({
    [`${prefix}_TIMEOUT`]: "登录超时了，请重新添加",
    [`${prefix}_START_FAILED`]: `${agent} 没能开始登录，请确认它能正常运行后重试`,
    [`${prefix}_FAILED`]: "登录没有完成，请重新添加",
    [`${prefix}_NOT_CONFIRMED`]: `${agent} 没有确认这次登录，请重新添加`,
    [`${prefix}_STALE`]: "这次登录已经结束，请重新添加",
    [`${prefix}_NOT_WAITING`]: "现在不需要授权码",
  });
  const VENDORS = {
    claude: {
      title: "添加 Claude 账号",
      methods: "agents.claudeAccounts",
      starting: "正在启动 Claude Code 的官方登录…",
      vendorPage: "Claude 官方登录页",
      code: true,
      fallbackName: "Claude 账号",
      errors: {
        ...flowErrors("CLAUDE_ADD_LOGIN", "Claude Code"),
        CLAUDE_NOT_INSTALLED: "这台电脑上还没装 Claude Code，先在「AI 助手」页安装它",
        CLAUDE_ADD_LOGIN_CODE_INVALID: "授权码不完整：请复制页面上的整段授权码（中间带 #）",
        CLAUDE_ADD_LOGIN_CODE_MISMATCH: "这个授权码不是这次登录的，请用刚打开的登录页给出的授权码",
        CLAUDE_ADD_LOGIN_SUBMIT_FAILED: "授权码没能交给 Claude Code，请重新添加",
        CLAUDE_IDENTITY_UNKNOWN: "登录成功了，但读不到这个账号是谁，请重新添加",
      },
    },
    grok: {
      title: "添加 Grok 账号",
      methods: "agents.grokAccounts",
      // The CLI may open the browser before (or without) printing its link.
      starting: "正在启动 Grok 的官方登录（grok login），浏览器会打开 xAI 登录页…",
      vendorPage: "xAI 官方登录页",
      code: false,
      fallbackName: "Grok 账号",
      errors: {
        ...flowErrors("GROK_ADD_LOGIN", "Grok"),
        GROK_NOT_INSTALLED: "这台电脑上还没装 Grok，先在「AI 助手」页安装它",
        GROK_IDENTITY_UNKNOWN: "登录成功了，但 Grok 没写下这个账号是谁，暂时无法保存",
        GROK_NOT_LOGGED_IN: "没有找到这次登录的结果，请重新添加",
      },
    },
  };

  function openAddLogin(vendor, { h, call, toast, explain, onAdded }) {
    const spec = VENDORS[vendor];
    const message = (code) => spec.errors[code] || COMMON[code] || explain(code);
    const ACTIVE = ["starting", "waitingForCode", "authorizing"];
    const method = (name) => `${spec.methods}.${name}`;

    let status = null;
    let shownPhase = null;
    let timer = null;
    let closed = false;
    const ui = window.HubUI.dialog({
      title: spec.title,
      sub: "当前登录不受影响",
      onClose: () => {
        closed = true;
        clearTimeout(timer);
        if (status && status.id && ACTIVE.includes(status.phase))
          call(method("addLoginCancel"), { id: status.id }).catch(() => undefined);
      },
    });
    const busyLine = (text) =>
      h(
        "p",
        { class: "row sub", role: "status" },
        h("span", { class: "pulse" }),
        h("span", null, text),
      );
    const button = (text, cls, onclick) =>
      h("button", { class: `btn ${cls}`, type: "button", onclick }, text);

    function codeField() {
      const code = h("input", {
        class: "input",
        type: "password",
        autocomplete: "off",
        spellcheck: "false",
        maxlength: "4096",
        "aria-label": "Claude 授权码",
        placeholder: "粘贴登录页给出的授权码",
      });
      const submit = button("提交授权码", "paper", async (event) => {
        const value = code.value.trim();
        if (!value) {
          code.focus();
          return;
        }
        const self = event.currentTarget;
        self.disabled = true;
        code.value = "";
        try {
          status = await call(method("addLoginSubmit"), { id: status.id, code: value });
          render();
        } catch (error) {
          toast(message(error && error.message));
          self.disabled = false;
        }
      });
      code.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit.click();
      });
      return { code, submit };
    }

    function render() {
      const phase = status ? status.phase : "starting";
      // Keep the code field (and what is typed in it) while polling says nothing changed.
      if (phase === shownPhase) return;
      shownPhase = phase;
      const body = [];
      const foot = [];
      if (phase === "starting") {
        body.push(busyLine(spec.starting));
      } else if (phase === "waitingForCode") {
        const field = spec.code ? codeField() : null;
        body.push(
          h(
            "ol",
            { class: "login-steps" },
            h(
              "li",
              null,
              `浏览器里已打开${spec.vendorPage}，用`,
              h("b", null, "要添加的账号"),
              "登录。",
            ),
            h("li", null, "登录完成后这里会自动保存，不用做别的。"),
            field ? h("li", null, "如果页面显示了一段授权码，复制后粘贴到下面。") : null,
          ),
          busyLine("等待你在浏览器里完成登录…"),
          ...(field
            ? [h("label", { class: "field" }, h("span", null, "授权码（可选）"), field.code), null]
            : []),
        );
        foot.push(
          button("重开登录页", "quiet", () =>
            call(method("addLoginOpen"), { id: status.id }).then(
              (next) =>
                toast(next && next.browserOpened === false ? "没能打开浏览器" : "已打开登录页"),
              (error) => toast(message(error && error.message)),
            ),
          ),
          h("span", { class: "spacer" }),
          field ? field.submit : null,
        );
      } else if (phase === "authorizing") {
        body.push(busyLine("正在确认登录并保存这个账号…"));
      } else if (phase === "failed") {
        body.push(h("p", { class: "warn-text", role: "alert" }, message(status.error)));
        foot.push(
          h("span", { class: "spacer" }),
          button("重新添加", "paper", () => start()),
        );
      } else if (phase === "cancelled") {
        body.push(h("p", { class: "sub" }, "已取消这次登录。"));
        foot.push(
          h("span", { class: "spacer" }),
          button("重新添加", "paper", () => start()),
        );
      }
      if (ACTIVE.includes(phase)) foot.unshift(button("取消", "quiet", () => ui.close()));
      ui.body.replaceChildren(...body.filter(Boolean));
      ui.foot.replaceChildren(...foot.filter(Boolean));
    }

    function poll() {
      clearTimeout(timer);
      if (closed || !status || !ACTIVE.includes(status.phase)) return;
      timer = setTimeout(async () => {
        const next = await call(method("addLoginStatus")).catch(() => null);
        if (closed) return;
        if (next && (next.id === status.id || !status.id)) status = next;
        if (status.phase === "succeeded") {
          const who =
            (status.result && (status.result.email || status.result.id)) || spec.fallbackName;
          toast(`已添加 ${who}，可以在列表里切换`);
          closed = true;
          ui.close();
          onAdded();
          return;
        }
        render();
        poll();
      }, 1500);
    }

    async function start() {
      shownPhase = null;
      status = null;
      render();
      try {
        status = await call(method("addLoginStart"), {});
      } catch (error) {
        status = { phase: "failed", error: error && error.message };
      }
      if (closed) return;
      render();
      poll();
    }
    start();
  }

  window.openClaudeAddLogin = (deps) => openAddLogin("claude", deps);
  window.openGrokAddLogin = (deps) => openAddLogin("grok", deps);
})();
