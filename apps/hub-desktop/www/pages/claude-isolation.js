"use strict";

window.renderClaudeIsolation = ({ h, call, toast, reload, status, applyToCodex }) => {
  const box = h("details", { class: "isolation-panel", open: Boolean(status?.settings) });
  const settings = status?.settings;
  const errors = {
    ISOLATION_CONFIG_INVALID: "隔离配置无法读取，请检查配置文件后重试。",
    ISOLATION_DOCKER_MISSING: "请先安装 Docker Sandboxes。",
    ISOLATION_DOCKER_UNAVAILABLE: "Docker 尚未就绪，请完成 Docker 登录后重试。",
    ISOLATION_DOCKER_COMMAND_FAILED: "Docker 操作未完成，请检查登录、虚拟化支持和网络后重试。",
    ISOLATION_PROXY_UNAVAILABLE: "代理连接不上，隔离任务已停止。请恢复代理后重试。",
    ISOLATION_PROXY_CHANGED: "Docker 的代理设置已变化，请重新保存环境设置。",
    ISOLATION_PROJECT_TOO_BROAD: "请选择单个项目文件夹，不能共享整个磁盘、用户目录或隔离数据目录。",
    ISOLATION_PROJECT_INVALID: "请输入本机项目文件夹的完整路径。",
    ISOLATION_WORKSPACE_MISMATCH:
      "沙箱共享目录不匹配。只能接管使用同一项目且没有额外共享目录的 Claude 沙箱。",
    ISOLATION_PROJECT_REQUIRED: "先添加一个项目，再开启隔离保护。",
    ISOLATION_RUNTIME_HAS_PROJECTS: "已有项目使用这个数据目录。请先移除项目授权，再修改目录。",
    ISOLATION_BUSY: "正在处理上一项操作，请稍候。",
    ISOLATION_SANDBOX_NOT_FOUND: "找不到所选沙箱，请刷新后重试。",
    ISOLATION_LOGIN_BUSY: "请先完成或取消正在进行的登录。",
    ISOLATION_LOGIN_TIMEOUT: "登录已超时，请点击一键登录重新授权。",
    ISOLATION_LOGIN_START_FAILED: "授权未能发起，请检查沙箱和代理后重试。",
    ISOLATION_LOGIN_FAILED: "登录没有完成，请重新发起授权。",
    ISOLATION_LOGIN_NOT_CONFIRMED: "沙箱还没有确认登录，请重新发起授权。",
    ISOLATION_LOGIN_CODE_INVALID: "请粘贴官方页面给出的完整授权码。",
    ISOLATION_LOGIN_CODE_MISMATCH: "授权码不属于这次登录，请使用当前授权页面的授权码。",
    ISOLATION_LOGIN_STALE: "这次登录已结束，请重新点击一键登录。",
    ISOLATION_LOGIN_SUBMIT_FAILED: "授权码未能提交到沙箱，请重新发起登录。",
  };
  const message = (error) => errors[error] || "操作未完成，请检查 Docker、代理和项目目录后重试。";
  const summary = settings?.enabled ? "已选择隔离模式" : "未开启";
  box.append(h("summary", null, `隔离保护 · ${summary}`));
  if (!status) {
    box.append(h("p", { class: "sub" }, "隔离状态暂时无法读取。"));
    return box;
  }
  if (!status.supported) {
    box.append(h("p", { class: "sub" }, "隔离保护目前支持 Windows＋Docker Sandboxes。"));
    return box;
  }

  const job = status.job || {};
  const login = status.login || { phase: "idle" };
  const loginActive = ["starting", "waitingForCode", "authorizing"].includes(login.phase);
  const busy = ["installing", "preparing"].includes(job.phase) || loginActive;
  // `applies`: the Claude adapter reads isolation once when Codex starts, so a successful switch
  // reopens Codex by itself (codex-apply.js) instead of asking the person to restart it.
  const action = (
    label,
    method,
    params = {},
    success = "操作已完成",
    allowWhileBusy = false,
    applies = false,
  ) =>
    h(
      "button",
      {
        class: "btn sm",
        type: "button",
        disabled: busy && !allowWhileBusy,
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const result = await call(
              `agents.isolation.${method}`,
              typeof params === "function" ? params() : params,
            );
            if (applies && result?.phase !== "failed" && applyToCodex)
              await applyToCodex("window", success);
            else
              toast(
                result?.phase === "failed"
                  ? message(result.error)
                  : result?.opened === false
                    ? "窗口没有打开，请重试。"
                    : success,
              );
          } catch (error) {
            toast(message(error?.message));
          } finally {
            reload();
          }
        },
      },
      label,
    );
  box.append(h("p", { class: "sub" }, "只共享选中的项目。隔离不保证账号不被封。"));
  box.append(
    h(
      "p",
      { class: "sub" },
      status.localClaudeInstalled
        ? "本地 Claude 已安装，可以保留。"
        : "本地没有 Claude，也可以直接使用沙箱内的 Claude。",
    ),
  );
  if (status.error) box.append(h("p", { class: "sub" }, message(status.error)));
  if (busy)
    box.append(
      h(
        "p",
        { role: "status", class: "sub" },
        job.phase === "installing"
          ? "正在安装 Docker Sandboxes…"
          : "正在准备项目，首次下载可能需要几分钟…",
      ),
    );
  if (job.phase === "failed")
    box.append(h("p", { role: "alert", class: "sub" }, message(job.error)));
  if (job.phase === "cancelled")
    box.append(
      h("p", { class: "sub" }, "已取消项目授权；Docker 可能仍在下载，完成后可刷新并接管。"),
    );
  if (job.phase === "preparing") {
    const cancel = action("取消授权准备", "cancel", {}, "已取消授权；不会自动共享项目");
    cancel.disabled = false;
    box.append(cancel);
  }
  if (!status.dockerInstalled) {
    box.append(action("安装 Docker Sandboxes", "install", {}, "开始安装，完成后会重新检测"));
    return box;
  }

  const runtime = h("input", {
    class: "input",
    value: settings?.runtimeRoot || status.defaultRuntimeRoot,
    "aria-label": "隔离数据目录",
  });
  const proxy = h("input", {
    class: "input",
    value: settings?.proxy || status.suggestedProxy || "",
    placeholder: "例如 socks5h://127.0.0.1:端口",
    "aria-label": "本机代理地址",
  });
  const save = action(
    "保存环境设置",
    "configure",
    () => ({
      enabled: settings?.enabled || false,
      runtimeRoot: runtime.value.trim(),
      proxy: proxy.value.trim(),
    }),
    "已保存并检查代理；如 Codex 已运行，请重新加载助手后使用",
  );
  box.append(
    h("label", { class: "isolation-field" }, "隔离数据目录", runtime),
    h("label", { class: "isolation-field" }, "沿用的本机代理", proxy),
    save,
  );
  box.append(h("p", { class: "sub" }, "隔离环境用的代理"));
  if (!settings) return box;
  box.append(action("登录 Docker", "dockerLogin", {}, "请在新窗口完成 Docker 登录，再刷新状态"));
  if (status.networkError)
    box.append(h("p", { role: "alert", class: "sub" }, message(status.networkError)));

  const project = h("input", {
    class: "input",
    placeholder: "粘贴单个项目文件夹的完整路径",
    "aria-label": "授权项目目录",
  });
  const existing = h(
    "select",
    { class: "input", "aria-label": "新建或接管沙箱" },
    h("option", { value: "" }, "为项目新建沙箱"),
    (status.sandboxes || []).map((item) => h("option", { value: item.name }, `接管 ${item.name}`)),
  );
  const prepare = action(
    "授权项目并准备",
    "prepare",
    () => ({ project: project.value.trim(), ...(existing.value ? { name: existing.value } : {}) }),
    "开始准备项目；完成后在沙箱内登录 Claude",
  );
  box.append(
    h("label", { class: "isolation-field" }, "允许 Claude 读写的项目", project),
    existing,
    prepare,
  );
  const projects = status.projects || settings.projects.map((p) => ({ ...p, loggedIn: null }));
  for (const item of projects) {
    box.append(
      h(
        "div",
        { class: "isolation-project" },
        h("b", null, item.project),
        h(
          "p",
          { class: "sub" },
          `${item.name} · ${item.error ? "沙箱不可用" : item.loggedIn === true ? "Claude 已登录" : item.loggedIn === false ? "Claude 待登录" : "登录待检测"}`,
        ),
        action(
          item.loggedIn ? "重新授权 Claude" : "一键登录 Claude",
          "login",
          { project: item.project },
          "已发起官方授权，请在浏览器完成后回到 Hub",
        ),
        action(
          "移除项目授权",
          "forget",
          { project: item.project },
          "已移除新任务的授权；已有会话请手动结束，项目文件保留",
        ),
      ),
    );
    if (login.project === item.project) {
      if (login.phase === "starting")
        box.append(h("p", { role: "status", class: "sub" }, "正在发起 Claude 官方授权…"));
      if (login.phase === "authorizing")
        box.append(h("p", { role: "status", class: "sub" }, "正在确认沙箱登录，成功后会自动更新…"));
      if (login.phase === "failed")
        box.append(h("p", { role: "alert", class: "sub" }, message(login.error)));
      if (login.phase === "cancelled") box.append(h("p", { class: "sub" }, "已取消本次登录。"));
      if (login.phase === "waitingForCode") {
        const code = h("input", {
          class: "input",
          type: "password",
          autocomplete: "off",
          maxlength: 4096,
          "aria-label": "Claude 授权码",
          placeholder: "粘贴官方授权页面给出的完整授权码",
        });
        box.append(
          h("p", { class: "sub" }, "在浏览器完成授权后，把授权码粘贴到这里"),
          h("label", { class: "isolation-field" }, "Claude 授权码", code),
          action(
            "完成登录",
            "loginSubmit",
            () => {
              const value = code.value.trim();
              code.value = "";
              return { id: login.id, code: value };
            },
            "已提交到当前沙箱，正在确认登录",
            true,
          ),
          action("重新打开授权页", "loginOpen", { id: login.id }, "已请求打开官方授权页", true),
        );
      }
      if (loginActive)
        box.append(action("取消本次登录", "loginCancel", { id: login.id }, "已取消登录", true));
    }
  }
  box.append(
    settings.enabled
      ? action("关闭隔离，恢复本地模式", "disable", {}, "已恢复本地模式", false, true)
      : action(
          "开启隔离保护",
          "configure",
          { enabled: true, runtimeRoot: settings.runtimeRoot, proxy: settings.proxy },
          "已开启隔离保护",
          false,
          true,
        ),
  );
  box.append(action("刷新状态", "status", {}, "已刷新"));
  box.append(
    h("p", { class: "sub" }, "开关隔离会让 Codex 重新打开一次；沙箱会话暂不支持分叉和回滚"),
  );
  return box;
};
