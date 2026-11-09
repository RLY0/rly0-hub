// Synthetic DOM and RPC only. Does not touch Codex preferences, credentials, or the live service.
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
    this.children = flat.filter((x): x is Element => x instanceof Element);
    this.text = flat.filter((x) => typeof x === "string").join("");
  }
  append(...items: unknown[]) {
    this.children.push(...items.flat(Infinity).filter((x): x is Element => x instanceof Element));
  }
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
  new URL("../../../apps/hub-desktop/www/pages/codex-updates.js", import.meta.url),
  "utf8",
);

type Status = Record<string, unknown>;
const base: Status = {
  enabled: true,
  defaulted: true,
  noticePending: false,
  supported: true,
  phase: "up-to-date",
  currentVersion: "26.1103.1.0",
  latestVersion: null,
  error: null,
  checkedAt: "2026-11-09T00:00:00.000Z",
  compatibility: { source: "remote", updatedAt: null, error: null, hubVersion: "0.11.40" },
  renderer: { schemaVersion: 1, mode: "full", disabled: [] },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function load(status: Status, isMac = false) {
  const calls: { method: string; params: unknown }[] = [];
  const dialogs: Element[] = [];
  const h = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) =>
    new Element(tag, props, children);
  const button = (label: string, action: () => unknown) =>
    new Element("button", { class: "btn", onclick: action }, [label]);
  const window: Record<string, unknown> = {
    HubUI: {
      isMac,
      dialog: ({ title, onClose }: { title: string; onClose?: () => void }) => {
        const ui = {
          title,
          body: new Element("div", null, []),
          foot: new Element("div", null, []),
          closed: false,
          close: () => {
            if (ui.closed) return;
            ui.closed = true;
            onClose?.();
          },
        };
        dialogs.push(Object.assign(new Element("dialog", null, [title]), { ui }));
        return ui;
      },
    },
  };
  // Timers stay inert: polling is checked by the call log, not by waiting.
  runInNewContext(source, { window, setTimeout: () => 0, clearTimeout: () => undefined, Promise });
  const call = async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === "codex.updates.setEnabled") {
      const on = (params as { enabled: boolean }).enabled;
      return { ...status, enabled: on, phase: on ? "checking" : "disabled" };
    }
    return status;
  };
  return { window, calls, dialogs, h, button, call };
}

async function card(status: Status, isMac = false) {
  const env = load(status, isMac);
  const render = env.window.renderCodexUpdates as (api: unknown) => Element;
  const root = render({
    h: env.h,
    call: env.call,
    failed: () => undefined,
    button: env.button,
    alive: () => true,
  });
  await tick();
  const switchEl = () => [...root.walk()].find((el) => el.props.role === "switch");
  const find = (label: string) =>
    [...root.walk()].find((el) => el.tag === "button" && el.textContent === label);
  return { ...env, root, switchEl, find };
}

describe("设置 → 更新 → Codex 更新 (synthetic)", () => {
  it("says in plain words that a new Codex is held until adapted", async () => {
    const page = await card({
      ...base,
      phase: "waiting-compatibility",
      latestVersion: "26.1200.1.0",
    });
    expect(page.root.textContent).toContain("Codex 出了新版 v26.1200.1.0，Hub 正在适配");
    expect(page.root.textContent).toContain("本机 v26.1103.1.0 · 最新 v26.1200.1.0");
    expect(page.switchEl()?.props["aria-checked"]).toBe("true");
  });

  it("shows a failure reason whole (not shortened) and offers a retry", async () => {
    const page = await card({ ...base, phase: "failed", error: "CODEX_UPDATE_CHECK_FAILED" });
    const note = [...page.root.walk()].find(
      (el) => el.tag === "p" && el.textContent.includes("没能准备好更新"),
    );
    expect(note?.props["data-keep"]).toBe(true);
    const retry = page.find("重试")?.props.onclick;
    expect(retry).toBeTypeOf("function");
    if (typeof retry === "function") retry();
    await tick();
    expect(page.calls.map((c) => c.method)).toContain("codex.updates.check");
  });

  it("asks before handing updates back to Codex, and only then sends the choice", async () => {
    const page = await card(base);
    (page.switchEl()?.props.onclick as () => void)();
    expect(page.calls.some((c) => c.method === "codex.updates.setEnabled")).toBe(false);
    const dialog = page.dialogs.at(-1) as Element & {
      ui: { foot: Element; body: Element; closed: boolean };
    };
    expect(dialog.ui.body.textContent).toContain("Codex 照常能用");
    const off = [...dialog.ui.foot.walk()].find((el) => el.textContent === "关掉");
    (off?.props.onclick as () => void)();
    await tick();
    expect(page.calls).toContainEqual({
      method: "codex.updates.setEnabled",
      params: { enabled: false },
    });
  });

  it("turns management back on without a dialog", async () => {
    const page = await card({ ...base, enabled: false, phase: "disabled" });
    expect(page.root.textContent).toContain("已交给 Codex 自己更新");
    (page.switchEl()?.props.onclick as () => void)();
    await tick();
    expect(page.dialogs).toHaveLength(0);
    expect(page.calls).toContainEqual({
      method: "codex.updates.setEnabled",
      params: { enabled: true },
    });
  });

  it("on Windows keeps the switch off and disabled and says the fallback covers it", async () => {
    const page = await card({
      ...base,
      supported: false,
      phase: "unsupported",
      renderer: { schemaVersion: 1, mode: "core", disabled: [] },
    });
    expect(page.switchEl()?.props["aria-checked"]).toBe("false");
    expect(page.switchEl()?.props.disabled).toBe(true);
    expect(page.root.textContent).toContain("部分增强已暂停");
    expect(page.root.textContent).toContain("Codex 照常能用");
  });

  it("does not show a newer feed version once the delivered one is installed", async () => {
    const page = await card({ ...base, phase: "up-to-date", latestVersion: "26.1300.1.0" });
    expect(page.root.textContent).toContain("已是适配好的最新版");
    expect(page.root.textContent).not.toContain("26.1300");
  });

  it("on a Mac test/dev Hub says it leaves Codex alone instead of blaming Windows", async () => {
    const page = await card({ ...base, supported: false, phase: "unsupported" }, true);
    expect(page.root.textContent).toContain("测试版 Hub 不管理 Codex 更新");
    expect(page.root.textContent).not.toContain("Windows");
    expect(page.switchEl()?.props.disabled).toBe(true);
  });

  it("names a moved data folder rather than calling a real Hub a test build", async () => {
    const page = await card(
      { ...base, supported: false, phase: "unsupported", unsupportedReason: "environment" },
      true,
    );
    expect(page.root.textContent).toContain("Hub 的数据位置改过");
    expect(page.root.textContent).not.toContain("测试版");
  });

  it("shows that Codex is being reopened", async () => {
    const page = await card({ ...base, phase: "installing", reopening: true });
    expect(page.root.textContent).toContain("正在重新打开 Codex…");
  });

  it("tells the user to open Codex once reopening was given up", async () => {
    const page = await card({ ...base, phase: "failed", error: "CODEX_REOPEN_FAILED" });
    expect(page.root.textContent).toContain("请手动打开 Codex");
  });

  it("explains an unreachable adapted list without hiding the cached judgement", async () => {
    const page = await card({
      ...base,
      compatibility: { source: "cache", updatedAt: null, error: "COMPAT_UNAVAILABLE" },
    });
    expect(page.root.textContent).toContain("先按上次拿到的名单判断");
  });

  it("keeps reading status while an update is moving", async () => {
    const page = await card({ ...base, phase: "waiting-idle", latestVersion: "26.1200.1.0" });
    expect(page.root.textContent).toContain("等你离开电脑 5 分钟后开始更新");
  });

  it("shows the one-time notice only when pending, enabled and supported", async () => {
    for (const [status, shown] of [
      [{ ...base, noticePending: true }, true],
      [{ ...base, noticePending: false }, false],
      [{ ...base, noticePending: true, enabled: false }, false],
      [{ ...base, noticePending: true, supported: false }, false],
    ] as const) {
      const env = load(status);
      const show = env.window.showCodexUpdatesNotice as (api: unknown) => Promise<void>;
      const went: string[] = [];
      await show({ h: env.h, call: env.call, go: (page: string) => went.push(page) });
      expect(env.dialogs.length).toBe(shown ? 1 : 0);
      if (!shown) continue;
      const dialog = env.dialogs[0] as Element & { ui: { foot: Element } };
      const toSettings = [...dialog.ui.foot.walk()].find((el) => el.textContent === "去设置");
      (toSettings?.props.onclick as () => void)();
      await tick();
      expect(env.calls.map((c) => c.method)).toContain("codex.updates.acknowledgeNotice");
      expect(went).toEqual(["updates"]);
    }
  });

  it("counts the notice as read however the dialog is closed (Esc or ×)", async () => {
    const env = load({ ...base, noticePending: true });
    const show = env.window.showCodexUpdatesNotice as (api: unknown) => Promise<void>;
    await show({ h: env.h, call: env.call, go: () => undefined });
    const dialog = env.dialogs[0] as Element & { ui: { close: () => void } };
    dialog.ui.close();
    await tick();
    expect(env.calls.filter((c) => c.method === "codex.updates.acknowledgeNotice")).toHaveLength(1);
  });
});
