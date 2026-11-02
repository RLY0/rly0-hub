"use strict";
// AI 助手 → each installed agent's card → "新对话默认": the permission mode, Model and thinking
// level each new Thread of that agent starts with. The choices are the agent's own catalog, which the Codex side
// reports with its connection check (agents.connectionStatus / agents.checkConnections); the
// values are saved in their own file (prefs.agentDefaultsSet → agent-defaults.json, never in
// codex-preferences.json), and Codex copies them the next time its window gets focus
// (renderer-agent-defaults.ts). Threads already started keep their own settings.
// One collapsed panel per agent card; the summary line shows what a new Thread will use.
// The AI 助手 page rebuilds its cards on every reload (检测连接, relay switch, isolation polling);
// one panel per agent and page visit moves into the new card, keeping its draft and open state.
const agentDefaultsPanels = new WeakMap(); // alive → Map(agentId → panel)
window.renderAgentDefaults = (options) => {
  const panels = agentDefaultsPanels.get(options.alive) || new Map();
  agentDefaultsPanels.set(options.alive, panels);
  if (!panels.has(options.agentId)) panels.set(options.agentId, createAgentDefaultsPanel(options));
  return panels.get(options.agentId);
};
function createAgentDefaultsPanel({ h, call, toast, failed, explain, alive, agentId, agentName }) {
  const card = h("details", { class: "isolation-panel agent-defaults" });
  const summary = h("summary");
  const body = h("div", { class: "agent-defaults-body" });
  card.append(summary, body);
  const put = (element, ...items) =>
    element.replaceChildren(
      ...items
        .flat(Infinity)
        .filter((item) => item !== null && item !== undefined && item !== false),
    );
  const info = (short, full) => window.HubUI.info(short, full);
  // Claude Code without a Hub default keeps the RLY/0 behaviour since 0.11.26 (no prompts).
  const CLAUDE_UNSET_PERMISSION = "bypassPermissions";

  let report = null; // last connection check from the Codex side
  let saved = {}; // agentId → { permissionModeId?, model?: { id }, thinkingOptionId? }
  const current = agentId;
  let draft = {}; // edits for `current`, same shape as one saved entry
  let phase = "loading"; // loading | loadError | ready
  let saving = false;
  let checking = false;
  let saveError = "";

  const zh = (entry) =>
    (entry && entry.localizations && entry.localizations["zh-CN"]) || entry || {};
  const modeLabel = (mode) => zh(mode).label || mode.label || mode.id;
  const configurationOf = (id) => {
    const entry = report && report.agents && report.agents[id];
    return entry && entry.status === "ready" ? entry.configuration || null : null;
  };
  const nameOf = () => agentName || agentId;
  const thinkingFor = (catalog, modelId) => {
    const model = catalog.models.find(
      (m) => m.ref.id === modelId || (m.fastModel || {}).id === modelId,
    );
    const supported = model && model.supportedThinkingOptionIds;
    return supported
      ? catalog.thinkingOptions.filter((option) => supported.includes(option.id))
      : [];
  };
  const clean = (entry) => {
    const next = {};
    if (entry.permissionModeId) next.permissionModeId = entry.permissionModeId;
    if (entry.model && entry.model.id) next.model = { id: entry.model.id };
    if (entry.thinkingOptionId) next.thinkingOptionId = entry.thinkingOptionId;
    return next;
  };
  const same = (a, b) => JSON.stringify(clean(a || {})) === JSON.stringify(clean(b || {}));
  const dirty = () => !same(draft, saved[current]);

  const select = (label, value, options, onChange, disabled) => {
    const element = h(
      "select",
      { class: "input compact-select", "aria-label": label, disabled: disabled || saving },
      options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)),
    );
    element.addEventListener("change", () => onChange(element.value));
    return element;
  };
  const row = (title, brief, full, control, note) =>
    h(
      "div",
      { class: "pref-row" },
      h("div", { class: "who" }, h("b", null, title), info(brief, full), note),
      control,
    );
  const effective = (text, stale) =>
    h(
      "span",
      { class: `sub defaults-effective ${stale ? "stale" : ""}` },
      stale ? h("span", { class: "tag warn" }, "已失效") : null,
      text,
    );

  /* ---------- One row per setting ---------- */
  function permissionRow(configuration) {
    const catalog = configuration && configuration.permissionModes;
    const value = draft.permissionModeId || "";
    if (configuration && !configuration.selectPermissionMode)
      return row(
        "默认权限",
        "新对话的权限模式",
        "这个助手没有可选的权限模式",
        h("span", { class: "sub" }, "不支持"),
      );
    const defaultMode = catalog && catalog.modes.find((m) => m.id === catalog.defaultModeId);
    const listed = catalog && value && catalog.modes.find((m) => m.id === value);
    const unsetBypass =
      current === "claude-code" &&
      catalog &&
      catalog.modes.find((m) => m.id === CLAUDE_UNSET_PERMISSION);
    let note;
    if (!catalog) note = null;
    else if (listed) note = effective(`新对话用：${modeLabel(listed)}`);
    else if (value)
      note = effective(
        `列表里已没有「${value}」，新对话改用上次的选择，没有就用「${defaultMode ? modeLabel(defaultMode) : catalog.defaultModeId}」`,
        true,
      );
    else if (unsetBypass) note = effective(`没设置，沿用 RLY/0 默认：${modeLabel(unsetBypass)}`);
    else
      note = effective(
        `没设置，沿用上次的选择，没有就用「${defaultMode ? modeLabel(defaultMode) : catalog.defaultModeId}」`,
      );
    const options = [["", "不指定"]];
    if (catalog) options.push(...catalog.modes.map((m) => [m.id, modeLabel(m)]));
    if (value && !listed) options.push([value, `${value}（已失效）`]);
    return row(
      "默认权限",
      "新对话的权限模式",
      "新开的对话按这个权限模式开始，对话里仍可临时改",
      select(
        "默认权限",
        value,
        options,
        (v) => edit({ permissionModeId: v || undefined }),
        !catalog,
      ),
      note,
    );
  }

  function modelRow(configuration) {
    const catalog = configuration && configuration.catalog;
    const value = (draft.model && draft.model.id) || "";
    if (configuration && !configuration.selectModel)
      return row(
        "默认模型",
        "新对话用的模型",
        "这个助手没有可选的模型",
        h("span", { class: "sub" }, "不支持"),
      );
    // Same match as Codex (catalogModelForRef): a Model's fast variant id also counts.
    const listed =
      catalog &&
      value &&
      catalog.models.find((m) => m.ref.id === value || (m.fastModel || {}).id === value);
    const fast = listed && listed.ref.id !== value;
    const fallback =
      catalog &&
      catalog.defaultModel &&
      catalog.models.find((m) => m.ref.id === catalog.defaultModel.id);
    const fallbackText = fallback ? `「${fallback.label}」` : "助手自己的默认";
    let note = null;
    if (catalog)
      note = listed
        ? effective(`新对话用：${listed.label}${fast ? "（Fast）" : ""}`)
        : value
          ? effective(
              `列表里已没有「${value}」，新对话改用上次的选择，没有就用${fallbackText}`,
              true,
            )
          : effective(`没设置，沿用上次的选择，没有就用${fallbackText}`);
    const options = [["", "不指定"]];
    if (catalog) options.push(...catalog.models.map((m) => [m.ref.id, m.label]));
    if (fast) options.push([value, `${listed.label}（Fast）`]);
    if (value && !listed) options.push([value, `${value}（已失效）`]);
    return row(
      "默认模型",
      "新对话用的模型",
      "新开的对话预选这个模型，对话里仍可临时换",
      select(
        "默认模型",
        value,
        options,
        (v) => {
          const next = { model: v ? { id: v } : undefined };
          // A thinking level the new Model does not offer would be ignored; clear it now.
          if (catalog && draft.thinkingOptionId) {
            const target = v || (catalog.defaultModel && catalog.defaultModel.id);
            if (!thinkingFor(catalog, target).some((o) => o.id === draft.thinkingOptionId))
              next.thinkingOptionId = undefined;
          }
          edit(next);
        },
        !catalog,
      ),
      note,
    );
  }

  function thinkingRow(configuration) {
    const catalog = configuration && configuration.catalog;
    const value = draft.thinkingOptionId || "";
    if (configuration && !configuration.selectThinkingOption)
      return row(
        "思考等级",
        "新对话的思考等级",
        "这个助手没有可选的思考等级",
        h("span", { class: "sub" }, "不支持"),
      );
    const modelId =
      (draft.model && draft.model.id) ||
      (catalog && catalog.defaultModel && catalog.defaultModel.id);
    const offered = catalog ? thinkingFor(catalog, modelId) : [];
    const listed = value && offered.find((o) => o.id === value);
    const fallback = catalog && offered.find((o) => o.id === catalog.defaultThinkingOptionId);
    const fallbackText = fallback ? `「${fallback.label}」` : "助手自己的默认";
    let note = null;
    if (catalog && !offered.length) note = effective("这个模型没有思考等级可选");
    else if (catalog)
      note = listed
        ? effective(`新对话用：${listed.label}`)
        : value
          ? effective(
              `这个模型没有「${value}」，新对话改用上次的选择，没有就用${fallbackText}`,
              true,
            )
          : effective(`没设置，沿用上次的选择，没有就用${fallbackText}`);
    const options = [["", "不指定"], ...offered.map((o) => [o.id, o.label])];
    if (value && !listed) options.push([value, `${value}（已失效）`]);
    return row(
      "思考等级",
      draft.model ? "按所选模型列出" : "按助手默认模型列出",
      "输入框里模型旁边的思考等级；新开的对话预选这一档",
      select(
        "思考等级",
        value,
        options,
        (v) => edit({ thinkingOptionId: v || undefined }),
        !catalog || !offered.length,
      ),
      note,
    );
  }

  /* ---------- Whole card ---------- */
  function edit(patch) {
    draft = clean({ ...draft, ...patch });
    saveError = "";
    draw();
  }

  function unavailableNote() {
    const entry = report && report.agents && report.agents[current];
    const name = nameOf(current);
    if (!report) return `还没读到 ${name} 的模型和权限列表。打开 Codex 后点“读取列表”。`;
    if (!entry) return `这次检测没有包含 ${name}。确认已经安装，再点“读取列表”。`;
    if (entry.status === "ready") return `${name} 没有报告可选的模型和权限，请更新后再读取。`;
    const why = entry.hint || entry.message || "连接失败";
    return `${name} 现在用不了（${why}），拿不到它的列表。登录或修好后点“读取列表”。`;
  }

  // Collapsed line: the values a new Thread starts with, or 未设置.
  function summaryText() {
    const configuration = configurationOf(current);
    const entry = saved[current] || {};
    const parts = [];
    const stale = (id) => `${id}（已失效）`;
    const modes = configuration && configuration.permissionModes;
    const mode =
      modes && entry.permissionModeId && modes.modes.find((m) => m.id === entry.permissionModeId);
    if (entry.permissionModeId)
      parts.push(
        mode ? modeLabel(mode) : modes ? stale(entry.permissionModeId) : entry.permissionModeId,
      );
    else if (
      current === "claude-code" &&
      (!modes || modes.modes.some((m) => m.id === CLAUDE_UNSET_PERMISSION))
    )
      parts.push("绕过权限（RLY/0 默认）");
    const catalog = configuration && configuration.catalog;
    if (entry.model) {
      const model =
        catalog &&
        catalog.models.find(
          (m) => m.ref.id === entry.model.id || (m.fastModel || {}).id === entry.model.id,
        );
      const fast = model && model.ref.id !== entry.model.id ? "（Fast）" : "";
      parts.push(model ? model.label + fast : catalog ? stale(entry.model.id) : entry.model.id);
    }
    if (entry.thinkingOptionId) {
      // Same check as the row: the levels the chosen (or the agent's default) Model offers.
      const modelId =
        (entry.model && entry.model.id) ||
        (catalog && catalog.defaultModel && catalog.defaultModel.id);
      const option =
        catalog && thinkingFor(catalog, modelId).find((o) => o.id === entry.thinkingOptionId);
      parts.push(
        option ? option.label : catalog ? stale(entry.thinkingOptionId) : entry.thinkingOptionId,
      );
    }
    return parts.length ? parts.join(" · ") : "未设置";
  }

  function draw() {
    summary.replaceChildren(
      phase === "loading"
        ? "新对话默认 · 读取中…"
        : phase === "loadError"
          ? "新对话默认 · 读取失败"
          : `新对话默认 · ${summaryText()}`,
    );
    const head = h(
      "div",
      { class: "row defaults-head" },
      h(
        "div",
        { class: "mod-title" },
        h("span", null, "新开的对话按这里预选；已开的对话不变，对话里仍可临时改"),
      ),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn sm",
          type: "button",
          disabled: checking || phase === "loading",
          onclick: () => readCatalogs(),
        },
        checking ? "读取中…" : "读取列表",
      ),
    );
    if (phase === "loading") {
      put(body, head, h("p", { class: "sub", role: "status" }, "正在读取默认设置…"));
      return;
    }
    if (phase === "loadError") {
      put(
        body,
        head,
        h(
          "div",
          { class: "row defaults-problem", role: "alert" },
          h("span", { class: "sub" }, "读取默认设置失败，可能是 Hub 后台还没准备好。"),
          h("button", { class: "btn sm", type: "button", onclick: () => load() }, "重试"),
        ),
      );
      return;
    }
    const configuration = configurationOf(current);
    const changed = dirty();
    put(
      body,
      head,
      configuration
        ? null
        : h("p", { class: "sub defaults-problem", role: "status" }, unavailableNote()),
      permissionRow(configuration),
      modelRow(configuration),
      thinkingRow(configuration),
      h(
        "div",
        { class: "row defaults-foot" },
        h(
          "span",
          { class: `sub ${saveError ? "defaults-error" : ""}`, "aria-live": "polite" },
          saveError
            ? `没保存上：${saveError}`
            : saving
              ? "正在保存…"
              : changed
                ? "有改动还没保存"
                : "回到 Codex 窗口后，新开的对话生效",
        ),
        h("span", { class: "spacer" }),
        changed && !saving
          ? h(
              "button",
              {
                class: "btn sm quiet",
                type: "button",
                onclick: () => edit(clean(saved[current] || {})),
              },
              "撤销",
            )
          : null,
        h(
          "button",
          {
            class: "btn paper sm",
            type: "button",
            disabled: !changed || saving,
            onclick: () => save(),
          },
          saving ? "保存中…" : "保存",
        ),
      ),
    );
  }

  /* ---------- Bypass needs an explicit yes ---------- */
  function confirmDangerous(mode) {
    return new Promise((resolve) => {
      let answered = false;
      const ui = window.HubUI.dialog({
        title: `默认${modeLabel(mode)}？`,
        sub: nameOf(current),
        onClose: () => {
          if (!answered) resolve(false);
        },
      });
      const answer = (yes) => {
        answered = true;
        resolve(yes);
        ui.close();
      };
      ui.body.append(
        h(
          "p",
          null,
          `以后每个新开的 ${nameOf(current)} 对话都不再询问，会直接执行任何命令，包括修改和删除文件。`,
        ),
        h("p", { class: "sub" }, "只在你信任所用项目时这样设置。已经开着的对话不受影响。"),
      );
      ui.foot.append(
        h("button", { class: "btn", type: "button", onclick: () => answer(false) }, "取消"),
        h(
          "button",
          { class: "btn red", type: "button", onclick: () => answer(true) },
          "确认并保存",
        ),
      );
    });
  }

  async function save() {
    if (saving) return;
    const entry = clean(draft);
    const catalog = (configurationOf(current) || {}).permissionModes;
    const mode = catalog && catalog.modes.find((m) => m.id === entry.permissionModeId);
    const before = (saved[current] || {}).permissionModeId;
    if (mode && mode.dangerous && entry.permissionModeId !== before) {
      if (!(await confirmDangerous(mode))) return;
      if (!alive()) return;
    }
    saving = true;
    saveError = "";
    draw();
    try {
      // Other agent cards save to the same file; start from what is on disk now. If it cannot be
      // read, do not write this card's older copy over another card's newer save.
      const latest = await call("prefs.agentDefaultsGet");
      if (!alive()) return;
      const next = { ...((latest && latest.agentDefaults && latest.agentDefaults.agents) || {}) };
      if (Object.keys(entry).length) next[current] = entry;
      else delete next[current];
      const result = await call("prefs.agentDefaultsSet", { agents: next });
      if (!alive()) return;
      saved = (result && result.agentDefaults && result.agentDefaults.agents) || next;
      draft = clean(saved[current] || {});
      toast("已保存，回到 Codex 后新开的对话生效");
    } catch (error) {
      if (!alive()) return;
      saveError = explain(error && error.message);
      failed(error);
    } finally {
      saving = false;
      if (alive()) draw();
    }
  }

  async function readCatalogs() {
    checking = true;
    draw();
    const result = await call("agents.checkConnections").catch(() => null);
    checking = false;
    if (!alive()) return;
    if (result && result.codexRunning === false) toast("Codex 没在运行，打开 Codex 后再读取");
    else if (!result || !result.report) toast("Codex 没有回应，请确认 Codex 是从 RLY/0 Hub 启动的");
    else {
      report = result.report;
      toast(configurationOf(current) ? "已读取最新列表" : `${nameOf(current)} 还拿不到列表`);
    }
    draw();
  }

  async function load() {
    phase = "loading";
    draw();
    const [prefs, status] = await Promise.all([
      call("prefs.agentDefaultsGet").then(
        (value) => ({ value }),
        () => null,
      ),
      call("agents.connectionStatus").catch(() => null),
    ]);
    if (!alive()) return;
    if (!prefs) {
      phase = "loadError";
      draw();
      return;
    }
    saved = (prefs.value && prefs.value.agentDefaults && prefs.value.agentDefaults.agents) || {};
    report = (status && status.report) || null;
    draft = clean(saved[current] || {});
    phase = "ready";
    draw();
  }

  load();
  return card;
}
