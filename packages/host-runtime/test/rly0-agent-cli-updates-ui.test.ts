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
          latestVersion: "2.2.0",
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

  it("uses a waiting tone for temporary problems and names only skip-listed versions bad", async () => {
    const ui = await mount(
      status([
        entry("pi", { result: "skipped-not-ready", errorCode: "HOST_UNAVAILABLE" }),
        entry("opencode", {
          result: "rolled-back",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          causeCode: "HOST_UNAVAILABLE",
        }),
        entry("hermes", { result: "failed", errorCode: "INSTALL_FAILED" }),
        entry("deepseek-harness", { result: "skipped-unsupported", errorCode: "VERSION_PINNED" }),
        entry("qwen-code", { result: "recovered" }),
      ]),
    );
    const cls = (id: string) => String(ui.line(id)?.props.class);
    expect(cls("pi")).toContain("wait");
    expect(ui.line("pi")?.textContent).toContain("等 Codex 打开");
    expect(cls("opencode")).toContain("wait");
    expect(ui.line("opencode")?.textContent).not.toContain("不再装");
    expect(ui.line("hermes")?.textContent).toContain("这次没装上，稍后再试");
    expect(ui.line("hermes")?.textContent).not.toContain("退回旧版也没成功");
    expect(ui.line("deepseek-harness")?.textContent).toContain("已锁定在适配好的版本");
    expect(ui.line("qwen-code")?.textContent).toContain("已保留恢复后的原版本");
  });

  it("follows contract v3: pending recovery, restored original, install timeout, kept version", async () => {
    const ui = await mount(
      status([
        entry("pi", { result: "skipped-busy", latestVersion: "1.1.0", recoveryPending: true }),
        entry("opencode", {
          result: "failed",
          errorCode: "CHECK_TIMEOUT",
          currentVersion: "1.0.0",
          previousVersion: "1.0.0",
        }),
        entry("hermes", {
          result: "failed",
          errorCode: "INSTALL_TIMEOUT",
          currentVersion: "2.0.0",
          previousVersion: "2.0.0",
        }),
        entry("grok", { result: "recovered", currentVersion: "1.2.0", previousVersion: "1.1.0" }),
        entry("copilot", { result: "failed", errorCode: "PRE_UPDATE_VERSION_MISMATCH" }),
      ]),
    );
    expect(ui.line("pi")?.textContent).toContain("上次更新还没收尾");
    expect(ui.line("pi")?.textContent).not.toContain("有新版");
    expect(ui.line("opencode")?.textContent).toContain("旧版本已恢复，等连接检查正常");
    expect(ui.line("hermes")?.textContent).toContain("这次安装超时，已保留原版本");
    expect(ui.line("grok")?.textContent).toContain("新版检查正常，已保留");
    expect(ui.line("copilot")?.textContent).toContain("更新前版本已经变了");
    expect(ui.line("copilot")?.textContent).not.toContain("装完");
  });

  it("shows rollback failure, stuck installer and unsaved state as warnings even with recovery pending", async () => {
    const ui = await mount(
      status([
        entry("pi", { result: "failed", errorCode: "ROLLBACK_FAILED", recoveryPending: true }),
        entry("opencode", {
          result: "failed",
          errorCode: "COMMAND_TREE_STOP_FAILED",
          recoveryPending: true,
        }),
        entry("hermes", {
          result: "failed",
          errorCode: "STATE_WRITE_FAILED",
          recoveryPending: true,
        }),
        entry("grok", { result: "skipped-unsupported", errorCode: "INSTALL_FILE_BUSY" }),
      ]),
    );
    for (const id of ["pi", "opencode", "hermes"]) {
      expect(String(ui.line(id)?.props.class)).toContain("warn");
      expect(ui.line(id)?.textContent).not.toContain("还没收尾");
    }
    expect(String(ui.line("grok")?.props.class)).toContain("wait");
    expect(ui.line("grok")?.textContent).not.toContain("不自动更新");
  });

  it("names a busy install file while waiting (contract v4)", async () => {
    const text = await lineText(
      entry("opencode", {
        result: "skipped-busy",
        errorCode: "INSTALL_FILE_BUSY",
        latestVersion: "1.1.0",
      }),
    );
    expect(text).toContain("有新版 v1.1.0");
    expect(text).toContain("安装文件可能被占用");
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
          errorCode: "VERSION_MISMATCH",
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
