// Synthetic DOM and RPC only. Never runs npm or touches an installed CLI.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
  children: Element[] = [];
  text = "";
  props: Record<string, unknown>;
  constructor(
    readonly tag: string,
    props: Record<string, unknown> | null,
    children: unknown[],
  ) {
    this.props = props ?? {};
    this.#set(children);
  }
  #set(children: unknown[]) {
    const flat = children.flat(Infinity);
    // Like the DOM, a null child passed to replaceChildren would become the text "null".
    if (flat.some((x) => x === null)) this.sawNull = true;
    this.children = flat.filter((x): x is Element => x instanceof Element);
    this.text = flat.filter((x) => typeof x === "string").join("");
  }
  sawNull = false;
  replaceChildren(...items: unknown[]) {
    this.#set(items);
  }
  get textContent(): string {
    return [this.text, ...this.children.map((child) => child.textContent)].join("");
  }
  *walk(): Generator<Element> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
}

const source = readFileSync(
  new URL("../../../apps/hub-desktop/www/pages/agent-cli-updates.js", import.meta.url),
  "utf8",
);

const NOW = Date.now();
const entry = (agent: string, more: Record<string, unknown> = {}) => ({
  agent,
  currentVersion: "1.0.0",
  latestVersion: "1.0.0",
  lastCheckedAt: NOW - 3600e3,
  lastUpdatedAt: null,
  phase: "idle",
  result: null,
  errorCode: null,
  causeCode: null,
  badVersions: [],
  installKind: "npm",
  canUpdate: true,
  ...more,
});
const status = (agents: unknown[], more: Record<string, unknown> = {}) => ({
  enabled: true,
  checking: false,
  intervalMs: 86400000,
  agents,
  ...more,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(initial: Record<string, unknown>) {
  const calls: { method: string; params: unknown }[] = [];
  const h = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) =>
    new Element(
      tag,
      props,
      children.filter((child) => child !== null && child !== undefined),
    );
  const window: Record<string, unknown> = {
    HubUI: { info: (short: string) => new Element("span", { class: "info" }, [short]) },
  };
  runInNewContext(source, { window, setTimeout: () => 0, clearTimeout: () => undefined, Promise });
  let changes = 0;
  const call = async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === "agents.cliUpdates.setEnabled")
      return { ...initial, enabled: (params as { enabled: boolean }).enabled };
    return initial;
  };
  const create = window.AgentCliUpdates as (api: unknown) => {
    card: Element;
    line: (id: string) => Element | null;
  };
  const ui = create({
    h,
    call,
    failed: () => undefined,
    alive: () => true,
    onChange: () => (changes += 1),
  });
  await tick();
  return { ...ui, calls, changes: () => changes };
}

const lineText = async (e: Record<string, unknown>, enabled = true) => {
  const ui = await mount(status([e], { enabled }));
  return ui.line(String(e.agent))?.textContent ?? null;
};

describe("AI 助手 → 自动更新命令行工具 (synthetic)", () => {
  it("tells each outcome in plain words", async () => {
    expect(await lineText(entry("opencode", { result: "up-to-date" }))).toContain("已是最新");
    expect(
      await lineText(entry("opencode", { result: "updated", lastUpdatedAt: NOW - 60e3 })),
    ).toContain("自动更新过");
    expect(
      await lineText(
        entry("pi", { result: "skipped-busy", currentVersion: "0.9.1", latestVersion: "0.9.3" }),
      ),
    ).toBe("v0.9.1 · 有新版 v0.9.3，等它空闲后更新");
    expect(
      await lineText(
        entry("hermes", {
          result: "rolled-back",
          currentVersion: "2.1.0",
          causeCode: "CONNECTION_NOT_READY",
          badVersions: ["2.2.0"],
        }),
      ),
    ).toBe("新版 v2.2.0 跟 Hub 对接不上，已退回 v2.1.0，不再装这个版本");
    expect(
      await lineText(
        entry("kimi-code", {
          result: "skipped-unsupported",
          errorCode: "ROLLBACK_UNSUPPORTED",
          canUpdate: false,
          installKind: "script",
        }),
      ),
    ).toContain("出问题时没法退回旧版");
    expect(
      await lineText(entry("opencode", { phase: "updating", latestVersion: "1.1.0" })),
    ).toContain("正在更新到 v1.1.0");
  });

  it("keeps warnings whole and never claims recovery when the rollback failed", async () => {
    const ui = await mount(
      status([entry("opencode", { result: "failed", errorCode: "ROLLBACK_FAILED" })]),
    );
    const line = ui.line("opencode");
    expect(line?.textContent).toContain("退回旧版也没成功");
    const span = [...(line?.walk() ?? [])].find((el) => el.tag === "span");
    expect(span?.props["data-keep"]).toBe("");
  });

  it("does not hide a failure just because the versions now match", async () => {
    expect(
      await lineText(
        entry("opencode", {
          result: "failed",
          errorCode: "INSTALL_FAILED",
          currentVersion: "1.0.0",
          latestVersion: "1.0.0",
        }),
      ),
    ).toContain("自动更新没成功");
  });

  it("says nothing for an agent that is not installed or not listed", async () => {
    const ui = await mount(status([entry("grok", { result: "skipped-not-installed" })]));
    expect(ui.line("grok")).toBeNull();
    expect(ui.line("claude-code")).toBeNull();
  });

  it("sends the switch and check-now, and prints no stray null when off", async () => {
    const ui = await mount(status([entry("opencode")], { enabled: false }));
    expect(ui.card.sawNull).toBe(false);
    expect(ui.card.textContent).toContain("已关闭");
    const sw = [...ui.card.walk()].find((el) => el.props.role === "switch");
    expect(sw?.props["aria-checked"]).toBe("false");
    (sw?.props.onclick as () => void)();
    await tick();
    expect(ui.calls).toContainEqual({
      method: "agents.cliUpdates.setEnabled",
      params: { enabled: true },
    });
    const check = [...ui.card.walk()].find(
      (el) => el.tag === "button" && el.textContent === "立即检查",
    );
    (check?.props.onclick as () => void)();
    await tick();
    expect(ui.calls.some((c) => c.method === "agents.cliUpdates.check")).toBe(true);
    expect(ui.changes()).toBeGreaterThan(0);
  });
});
