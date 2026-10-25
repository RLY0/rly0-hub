"use strict";
// What the upstream web console offered beyond the Hub, now inside the Hub window (no browser
// page): 设置 → 远程连接, 设置 → 用量统计, and 维护 → 会话导入. All of it reads the running Codex
// through the Hub service (host-console-routes.ts); while Codex is closed each says so.
window.registerHubConsoleFeatures = ({ pages, h, call, toast, failed }) => {
  const button = (text, action, extra) =>
    h(
      "button",
      {
        class: `btn sm ${extra || ""}`,
        type: "button",
        onclick: async (event) => {
          const el = event.currentTarget;
          el.disabled = true;
          try {
            await action();
          } catch (error) {
            failed(error);
          } finally {
            el.disabled = false;
          }
        },
      },
      text,
    );
  const put = (element, ...items) =>
    element.replaceChildren(...items.flat().filter((item) => item !== null && item !== undefined));
  const ERRORS = { HOST_UNAVAILABLE: "Codex 没在运行，先打开 Codex" };
  const fail = (error) =>
    failed(new Error(ERRORS[error && error.message] || (error && error.message) || "HUB_ERROR"));
  const closedNote = (section) =>
    h(
      "div",
      { class: "empty-note" },
      h("p", { class: "sub" }, "Codex 没在运行。打开 Codex 后再看。"),
      button("打开 Codex", () => call("codex.open").then(() => toast("正在打开 Codex"))),
      section ? button("刷新", section) : null,
    );

  /* ---------- 设置 → 远程连接 ---------- */
  pages.remote = (root, alive) => {
    const list = h("div", { class: "remote-list" }, h("p", { class: "sub" }, "读取中…"));
    const load = async () => {
      const result = await call("remote.list").catch((error) => {
        fail(error);
        return null;
      });
      if (!alive()) return;
      if (!result) return put(list, h("p", { class: "sub" }, "没读到远程连接"));
      if (!result.available) return put(list, closedNote(load));
      if (result.connections.length === 0)
        return put(
          list,
          h(
            "p",
            { class: "sub" },
            "还没有远程主机。在 Codex 的连接设置里添加 SSH 主机后会显示在这里。",
          ),
        );
      put(
        list,
        result.connections.map((connection) => {
          const state = h("span", { class: "tag" }, "…");
          const toggle = h("span", { class: "row" });
          const refresh = async () => {
            const read = await call("remote.state", { hostId: connection.hostId }).catch(
              () => null,
            );
            if (!alive()) return;
            const value = read && read.available && read.state ? read.state.state : null;
            const connected = value === "connected";
            state.textContent = connected ? "已连接" : value === "connecting" ? "连接中" : "未连接";
            state.classList.toggle("ok", connected);
            put(
              toggle,
              button(connected ? "断开" : "连接", async () => {
                await call("remote.connect", {
                  hostId: connection.hostId,
                  enabled: !connected,
                }).catch(fail);
                setTimeout(refresh, 1200);
              }),
            );
          };
          void refresh();
          return h(
            "div",
            { class: "remote-row" },
            h(
              "div",
              { class: "remote-name" },
              h("b", null, connection.displayName),
              h("span", { class: "sub mono" }, connection.sshAlias || connection.sshHost),
            ),
            state,
            toggle,
          );
        }),
      );
    };
    root.append(
      h(
        "section",
        { class: "m" },
        h(
          "div",
          { class: "mod-head" },
          h("h2", null, "远程连接"),
          h("span", { class: "sub" }, "Codex 已保存的 SSH 主机"),
        ),
        list,
      ),
    );
    void load();
  };

  /* ---------- 设置 → 用量统计 ---------- */
  const RANGES = [
    ["today", "今天"],
    ["7d", "7 天"],
    ["30d", "30 天"],
    ["all", "全部"],
  ];
  const number = (value) =>
    value >= 1e9
      ? `${(value / 1e9).toFixed(1)}B`
      : value >= 1e6
        ? `${(value / 1e6).toFixed(1)}M`
        : value >= 1e3
          ? `${(value / 1e3).toFixed(1)}K`
          : String(value || 0);
  pages.usage = (root, alive) => {
    let range = "7d";
    const body = h("div", { class: "usage-body" }, h("p", { class: "sub" }, "读取中…"));
    const tabs = h("div", { class: "segment", role: "tablist", "aria-label": "时间范围" });
    const drawTabs = () =>
      put(
        tabs,
        RANGES.map(([id, label]) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              class: id === range ? "on" : "",
              "aria-selected": id === range ? "true" : "false",
              onclick: () => {
                range = id;
                drawTabs();
                void load();
              },
            },
            label,
          ),
        ),
      );
    const load = async () => {
      const mine = range;
      const result = await call("usage.statistics", { range }).catch((error) => {
        fail(error);
        return null;
      });
      if (!alive() || mine !== range) return;
      if (!result) return put(body, h("p", { class: "sub" }, "没读到用量"));
      if (!result.available) return put(body, closedNote(load));
      const s = result.statistics;
      const totals = s.totals;
      const tile = (label, value) =>
        h(
          "div",
          { class: "usage-tile" },
          h("span", { class: "sub" }, label),
          h("b", { class: "tabular" }, value),
        );
      const rows = (s.byHarness || [])
        .slice()
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 12)
        .map((row) =>
          h(
            "tr",
            null,
            h("td", null, row.harness),
            h("td", { class: "tabular" }, number(row.requests)),
            h("td", { class: "tabular" }, number(row.inputTokens + row.outputTokens)),
            h("td", { class: "tabular" }, `$${row.costUsd.toFixed(2)}`),
          ),
        );
      put(
        body,
        h(
          "div",
          { class: "usage-tiles" },
          tile("请求", number(totals.requests)),
          tile("输入", number(totals.inputTokens)),
          tile("输出", number(totals.outputTokens)),
          tile("按官方价", `$${totals.costUsd.toFixed(2)}`),
        ),
        rows.length
          ? h(
              "table",
              { class: "usage-table" },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  h("th", null, "助手"),
                  h("th", null, "请求"),
                  h("th", null, "Token"),
                  h("th", null, "费用"),
                ),
              ),
              h("tbody", null, rows),
            )
          : h("p", { class: "sub" }, "这段时间没有用量"),
        s.reading && !s.reading.complete
          ? h("p", { class: "sub" }, `还在读取本机记录（${s.reading.read}/${s.reading.sources}）`)
          : null,
        s.failures && s.failures.length
          ? h(
              "p",
              { class: "sub warn" },
              `${s.failures.map((f) => f.harness).join("、")} 的记录没读到`,
            )
          : null,
      );
    };
    drawTabs();
    root.append(
      h(
        "section",
        { class: "m" },
        h(
          "div",
          { class: "mod-head" },
          h("h2", null, "用量统计"),
          h("span", { class: "sub" }, "本机各助手的请求与 Token"),
        ),
        tabs,
        body,
      ),
    );
    void load();
  };

  /* ---------- 维护 → 会话导入 ---------- */
  // Opens a dialog: pick an agent, then import one of its native sessions into Codex.
  function openSessionImport() {
    let alive = true;
    const ui = window.HubUI.dialog({
      title: "会话导入",
      sub: "把助手原生会话放进 Codex",
      wide: true,
      onClose: () => {
        alive = false;
      },
    });
    const picker = h("select", { class: "input", "aria-label": "选择助手" });
    const list = h("div", { class: "session-list" }, h("p", { class: "sub" }, "读取中…"));
    ui.body.append(picker, list);
    const loadList = async () => {
      put(list, h("p", { class: "sub" }, "读取中…"));
      const result = await call("sessions.list", { harnessId: picker.value, limit: 20 }).catch(
        (error) => {
          fail(error);
          return null;
        },
      );
      if (!alive) return;
      if (!result) return put(list, h("p", { class: "sub" }, "没读到会话"));
      if (!result.available) return put(list, closedNote(null));
      const candidates = result.list.candidates || [];
      if (candidates.length === 0)
        return put(list, h("p", { class: "sub" }, "这个助手还没有可导入的会话"));
      put(
        list,
        candidates.map((candidate) =>
          h(
            "div",
            { class: "session-row" },
            h(
              "div",
              { class: "session-name" },
              h("b", null, candidate.title || "（无标题）"),
              h("span", { class: "sub mono" }, candidate.cwd),
            ),
            button("导入", async () => {
              await call("sessions.import", {
                harnessId: picker.value,
                nativeSessionId: candidate.nativeSessionId,
              }).then(() => toast("已导入，在 Codex 的会话列表里打开"), fail);
            }),
          ),
        ),
      );
    };
    picker.addEventListener("change", () => void loadList());
    call("sessions.sources").then(
      (result) => {
        if (!alive) return;
        if (!result.available) return put(list, closedNote(null));
        if (result.harnesses.length === 0)
          return put(list, h("p", { class: "sub" }, "没有支持导入的助手"));
        put(
          picker,
          result.harnesses.map((item) => h("option", { value: item.harnessId }, item.name)),
        );
        if (window.HubUI.enhanceSelect) window.HubUI.enhanceSelect(picker);
        void loadList();
      },
      (error) => {
        fail(error);
        put(list, h("p", { class: "sub" }, "没读到助手列表"));
      },
    );
    ui.foot.append(button("关闭", () => ui.close()));
  }

  return { openSessionImport };
};
