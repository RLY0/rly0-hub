// Synthetic DOM and RPC only. Does not start the Hub service, Codex, or any agent.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Listener = () => unknown;
class Element {
  children: (Element | string)[] = [];
  listeners = new Map<string, Listener[]>();
  value = "";
  disabled = false;
  constructor(
    readonly tag: string,
    readonly props: Record<string, unknown>,
    children: unknown[],
  ) {
    this.disabled = Boolean(props.disabled);
    if (typeof props.onclick === "function") this.on("click", props.onclick as Listener);
    this.append(...children);
    if (tag === "option") this.value = String(props.value ?? "");
    if (tag === "select") {
      const options = this.children.filter((c): c is Element => c instanceof Element);
      this.value = (options.find((o) => o.props.selected) ?? options[0])?.value ?? "";
    }
  }
  on(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  addEventListener(type: string, listener: Listener) {
    this.on(type, listener);
  }
  append(...items: unknown[]) {
    for (const item of items.flat(Infinity as 1)) {
      if (item === null || item === undefined || item === false) continue;
      this.children.push(item instanceof Element ? item : String(item));
    }
  }
  replaceChildren(...items: unknown[]) {
    this.children = [];
    this.append(...items);
  }
  get text(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.text)).join("");
  }
  all(match: (element: Element) => boolean): Element[] {
    return this.children.flatMap((c) =>
      typeof c === "string" ? [] : [...(match(c) ? [c] : []), ...c.all(match)],
    );
  }
  async fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) await listener();
  }
}

const source = readFileSync(
  new URL("../../../apps/hub-desktop/www/pages/agent-defaults.js", import.meta.url),
  "utf8",
);

const claudeConfiguration = {
  selectModel: true,
  selectThinkingOption: true,
  selectPermissionMode: true,
  catalog: {
    models: [
      { ref: { id: "opus" }, label: "Opus", supportedThinkingOptionIds: ["auto", "medium"] },
      { ref: { id: "haiku" }, label: "Haiku", supportedThinkingOptionIds: ["auto"] },
    ],
    defaultModel: { id: "opus" },
    thinkingOptions: [
      { id: "auto", label: "Auto" },
      { id: "medium", label: "Medium" },
    ],
    defaultThinkingOptionId: "auto",
  },
  permissionModes: {
    defaultModeId: "default",
    modes: [
      { id: "plan", label: "Plan mode", localizations: { "zh-CN": { label: "规划模式" } } },
      { id: "default", label: "Default", localizations: { "zh-CN": { label: "默认" } } },
      {
        id: "bypassPermissions",
        label: "Bypass permissions",
        dangerous: true,
        localizations: { "zh-CN": { label: "绕过权限" } },
      },
    ],
  },
};
const report = {
  requestId: null,
  checkedAt: 1,
  agents: {
    "claude-code": { status: "ready", configuration: claudeConfiguration },
    opencode: {
      status: "ready",
      configuration: {
        selectModel: true,
        selectThinkingOption: false,
        selectPermissionMode: false,
        catalog: {
          models: [{ ref: { id: "gpt-5.5" }, label: "GPT-5.5" }],
          defaultModel: { id: "gpt-5.5" },
          thinkingOptions: [],
        },
      },
    },
    hermes: {
      status: "unavailable",
      message: "No API key configured",
      hint: "还没有可用的模型来源",
    },
  },
};

interface Options {
  prefs?: unknown;
  prefsFails?: boolean;
  status?: unknown;
  saveFails?: boolean;
  agentId?: string;
  agentName?: string;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(options: Options = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const toasts: string[] = [];
  const dialogs: { body: Element; foot: Element; close: () => void; title: string }[] = [];
  // `prefs` keeps the old fixture shape ({ agentDefaults }); the service file is { agents }.
  const initial = (options.prefs ?? {}) as { agentDefaults?: unknown };
  let saved: unknown =
    initial.agentDefaults === undefined
      ? null
      : { version: 1, updatedAt: 1, agents: initial.agentDefaults };
  const h = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) =>
    new Element(tag, props ?? {}, children);
  const window = {
    renderAgentDefaults: undefined as unknown as (api: unknown) => Element,
    HubUI: {
      info: (short: string) => h("span", null, short),
      dialog: (o: { title: string; onClose?: () => void }) => {
        const dialog = {
          title: o.title,
          body: h("div", null),
          foot: h("div", null),
          close: () => o.onClose?.(),
        };
        dialogs.push(dialog);
        return dialog;
      },
    },
  };
  runInNewContext(source, { window });
  const card = window.renderAgentDefaults({
    agentId: options.agentId ?? "claude-code",
    agentName: options.agentName ?? "Claude Code",
    h,
    alive: () => true,
    toast: (text: string) => toasts.push(text),
    failed: () => toasts.push("failed"),
    explain: (code: string) =>
      code === "CODEX_PREFERENCES_FAILED" ? "设置没写进去" : "操作没有成功",
    call: async (method: string, params: unknown) => {
      calls.push({ method, params: structuredClone(params) });
      if (method === "prefs.agentDefaultsGet") {
        if (options.prefsFails) throw new Error("HUB_ERROR");
        return { agentDefaults: saved };
      }
      if (method === "prefs.agentDefaultsSet") {
        if (options.saveFails) throw new Error("CODEX_PREFERENCES_FAILED");
        saved = { version: 1, updatedAt: 2, agents: (params as { agents: unknown }).agents };
        return { agentDefaults: saved };
      }
      if (method === "agents.list")
        return {
          agents: [
            { id: "claude-code", name: "Claude Code", installed: true },
            { id: "opencode", name: "OpenCode", installed: true },
            { id: "hermes", name: "Hermes", installed: true },
            { id: "grok", name: "Grok", installed: false },
          ],
        };
      if (method === "agents.connectionStatus")
        return { report: options.status === undefined ? report : options.status };
      throw new Error(`unexpected ${method}`);
    },
  });
  await tick();
  await tick();
  const selectNamed = (label: string) => {
    const found = card.all((e) => e.tag === "select" && e.props["aria-label"] === label)[0];
    if (!found) throw new Error(`no select ${label}`);
    return found;
  };
  const button = (text: string, root: Element = card) => {
    const found = root.all((e) => e.tag === "button" && e.text.includes(text))[0];
    if (!found) throw new Error(`no button ${text}`);
    return found;
  };
  const choose = async (label: string, value: string) => {
    const element = selectNamed(label);
    element.value = value;
    await element.fire("change");
  };
  const saves = () => {
    // The card never rewrites codex-preferences.json.
    expect(calls.some((c) => c.method.startsWith("prefs.codex"))).toBe(false);
    return calls.filter((c) => c.method === "prefs.agentDefaultsSet");
  };
  const otherCardSaves = async (agents: unknown) => {
    saved = { version: 1, updatedAt: 3, agents };
  };
  return { card, calls, saves, toasts, dialogs, selectNamed, button, choose, otherCardSaves };
}

describe("Hub 新对话默认设置", () => {
  it("shows that unset Claude Code keeps bypassing permissions", async () => {
    const ui = await mount();
    expect(ui.card.text).toContain("没设置，沿用 RLY/0 默认：绕过权限");
    expect(ui.selectNamed("默认权限").text).toContain("不指定");
    expect(ui.selectNamed("默认权限").value).toBe("");
    // The panel lives in the agent's own card: no agent picker, a one-line summary instead.
    expect(() => ui.selectNamed("助手")).toThrow();
    expect(ui.card.tag).toBe("details");
    expect(ui.card.text).toContain("新对话默认 · 绕过权限（RLY/0 默认）");
  });

  it("saves a safe choice right away and keeps the other agents' defaults", async () => {
    const ui = await mount({
      prefs: { updatedAt: 1, agentDefaults: { opencode: { model: { id: "gpt-5.5" } } } },
    });
    await ui.choose("默认权限", "plan");
    await ui.choose("默认模型", "haiku");
    await ui.choose("思考等级", "auto");
    expect(ui.card.text).toContain("有改动还没保存");
    await ui.button("保存").fire("click");
    expect(ui.dialogs).toHaveLength(0);
    expect(ui.saves().map((c) => c.params)).toEqual([
      {
        agents: {
          opencode: { model: { id: "gpt-5.5" } },
          "claude-code": {
            permissionModeId: "plan",
            model: { id: "haiku" },
            thinkingOptionId: "auto",
          },
        },
      },
    ]);
    expect(ui.toasts).toContain("已保存，回到 Codex 后新开的对话生效");
    expect(ui.card.text).toContain("新对话用：规划模式");
  });

  it("clears a thinking level the newly chosen Model does not offer", async () => {
    const ui = await mount();
    await ui.choose("思考等级", "medium");
    await ui.choose("默认模型", "haiku");
    expect(ui.selectNamed("思考等级").value).toBe("");
  });

  it("asks once before saving bypassed permissions and saves nothing on cancel", async () => {
    const ui = await mount();
    await ui.choose("默认权限", "bypassPermissions");
    const pending = ui.button("保存").fire("click");
    await tick();
    expect(ui.dialogs).toHaveLength(1);
    expect(ui.dialogs[0]?.body.text).toContain("直接执行任何命令");
    expect(ui.saves()).toHaveLength(0);
    await ui.button("取消", ui.dialogs[0]?.foot).fire("click");
    await pending;
    expect(ui.saves()).toHaveLength(0);

    const confirmed = ui.button("保存").fire("click");
    await tick();
    expect(ui.dialogs).toHaveLength(2);
    await ui.button("确认并保存", ui.dialogs[1]?.foot).fire("click");
    await confirmed;
    expect(ui.saves().map((c) => c.params)).toEqual([
      { agents: { "claude-code": { permissionModeId: "bypassPermissions" } } },
    ]);
  });

  it("does not ask again once bypass is the saved default", async () => {
    const ui = await mount({
      prefs: {
        updatedAt: 1,
        agentDefaults: { "claude-code": { permissionModeId: "bypassPermissions" } },
      },
    });
    await ui.choose("默认模型", "opus");
    await ui.button("保存").fire("click");
    expect(ui.dialogs).toHaveLength(0);
    expect(ui.saves()).toHaveLength(1);
  });

  it("marks a saved value the catalog no longer lists and explains the fallback", async () => {
    const ui = await mount({
      prefs: {
        updatedAt: 1,
        agentDefaults: {
          "claude-code": { permissionModeId: "retired-mode", model: { id: "retired-model" } },
        },
      },
    });
    expect(ui.card.text).toContain("已失效");
    expect(ui.card.text).toContain("列表里已没有「retired-model」");
    expect(ui.card.text).toContain("列表里已没有「retired-mode」");
    expect(ui.selectNamed("默认模型").text).toContain("retired-model（已失效）");
  });

  it("accepts a saved fast-model id the way Codex does, not as 已失效", async () => {
    const original = claudeConfiguration.catalog.models[0];
    claudeConfiguration.catalog.models[0] = {
      ...original,
      fastModel: { id: "opus-fast" },
    } as never;
    try {
      const ui = await mount({
        prefs: { updatedAt: 1, agentDefaults: { "claude-code": { model: { id: "opus-fast" } } } },
      });
      expect(ui.card.text).not.toContain("已失效");
      expect(ui.card.text).toContain("新对话用：Opus（Fast）");
      expect(ui.selectNamed("默认模型").value).toBe("opus-fast");
    } finally {
      claudeConfiguration.catalog.models[0] = original as never;
    }
  });

  it("explains agents without a catalog: not read yet, or not usable", async () => {
    const none = await mount({ status: null });
    expect(none.card.text).toContain("还没读到 Claude Code 的模型和权限列表");
    expect(none.selectNamed("默认权限").disabled).toBe(true);

    const hermes = await mount({ agentId: "hermes", agentName: "Hermes" });
    expect(hermes.card.text).toContain("Hermes 现在用不了（还没有可用的模型来源）");
    expect(hermes.card.text).toContain("新对话默认 · 未设置");
    const opencode = await mount({ agentId: "opencode", agentName: "OpenCode" });
    expect(opencode.card.text).toContain("不支持");
  });

  it("shows a read failure with a retry, and a save failure without losing the edit", async () => {
    const failed = await mount({ prefsFails: true });
    expect(failed.card.text).toContain("读取默认设置失败");
    failed.button("重试");

    const ui = await mount({ saveFails: true });
    await ui.choose("默认权限", "plan");
    await ui.button("保存").fire("click");
    expect(ui.card.text).toContain("没保存上：设置没写进去");
    expect(ui.selectNamed("默认权限").value).toBe("plan");
  });

  it("summarises the saved values in the collapsed line and marks stale ones", async () => {
    const ui = await mount({
      prefs: {
        updatedAt: 1,
        agentDefaults: {
          "claude-code": { permissionModeId: "plan", model: { id: "retired-model" } },
        },
      },
    });
    expect(ui.card.text).toContain("新对话默认 · 规划模式 · retired-model（已失效）");
  });

  it("saves on top of what another agent's card saved meanwhile", async () => {
    const ui = await mount();
    // Another card (OpenCode) saved after this one loaded.
    await ui.otherCardSaves({ opencode: { model: { id: "gpt-5.5" } } });
    await ui.choose("默认权限", "plan");
    await ui.button("保存").fire("click");
    expect(ui.saves().map((c) => c.params)).toEqual([
      {
        agents: {
          opencode: { model: { id: "gpt-5.5" } },
          "claude-code": { permissionModeId: "plan" },
        },
      },
    ]);
  });
});
