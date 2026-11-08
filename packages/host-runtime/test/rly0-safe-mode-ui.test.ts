// Synthetic DOM and RPC only. Does not load credentials, a browser profile, or the live service.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
  children: Element[] = [];
  text = "";
  hidden = false;
  innerHTML = "";
  onclick?: () => unknown;
  constructor(
    readonly tag: string,
    readonly props: Record<string, unknown> | null,
    children: unknown[],
  ) {
    if (props) Object.assign(this, props);
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
  setAttribute() {}
  addEventListener() {}
  get textContent(): string {
    return [this.text, ...this.children.map((child) => child.textContent)].join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  *walk(): Generator<Element> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
}

const source = readFileSync(
  new URL("../../../apps/hub-desktop/www/pages/system.js", import.meta.url),
  "utf8",
);

const diagnostics = {
  advice: [],
  codexEndpoint: null,
  codexHome: "/synthetic/.codex",
  codexHomeExists: true,
  authJsonExists: true,
  configTomlExists: true,
  configTomlParses: true,
  sessionsDirExists: true,
  core: { available: true, version: "0.1.0" },
};

function compatibility(state: string, message: string) {
  return {
    checkedAt: "2026-11-08T00:00:00.000Z",
    state,
    desktopVersion: "26.1200.1",
    previousCompatibleVersion: "26.1103.5130.0",
    versionChanged: true,
    issue: state === "safe-mode" ? "UNVERIFIED_VERSION" : "NONE",
    message,
    checks: { managedRuntime: true, controllerAlive: true, interfaceConnected: false },
  };
}

async function maintenancePage(desktopCompatibility: unknown) {
  const calls: { method: string; params: unknown }[] = [];
  const toasts: string[] = [];
  const pages: Record<string, (root: Element, alive: () => boolean) => void> = {};
  const h = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) =>
    new Element(tag, props, children);
  const button = (label: string, action: () => unknown) =>
    new Element("button", { class: "btn", onclick: action }, [label]);
  const window = { registerHubSystem: undefined as unknown as (api: unknown) => void };
  runInNewContext(source, { window, URL, Date, setTimeout, Promise });
  window.registerHubSystem({
    pages,
    h,
    toast: (text: string) => toasts.push(text),
    failed: () => undefined,
    button,
    // The real confirmButton arms on the first tap; one tap stands for both here.
    confirmButton: button,
    go: () => undefined,
    recentErrors: () => [],
    applyToCodex: async () => undefined,
    consoleFeatures: { openSessionImport: () => undefined },
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "maintenance.diagnostics") return { ...diagnostics, desktopCompatibility };
      if (method === "codex.status") return { running: true, canOpen: true };
      if (method === "maintenance.restartCodex") return { ok: true };
      return null;
    },
  });
  const root = new Element("main", null, []);
  const render = pages.maintenance;
  if (!render) throw new Error("maintenance page was not registered");
  render(root, () => true);
  const find = (label: string) =>
    [...root.walk()].find((el) => el.tag === "button" && el.textContent === label);
  const click = async (label: string) => {
    const target = find(label);
    if (!target?.onclick) throw new Error(`no button ${label}`);
    await target.onclick();
  };
  await click("运行诊断");
  return { root, calls, toasts, find, click };
}

describe("maintenance page safe-mode restart (synthetic)", () => {
  it("offers a full-mode restart only in safe mode and sends the full-mode choice", async () => {
    const message =
      "Codex 新版本 v26.1200.1 还没经过 Hub 验证，已用安全模式打开：Codex 和叫 CC 干活都能正常用，Hub 的界面增强暂时关闭。";
    const page = await maintenancePage(compatibility("safe-mode", message));
    const row = [...page.root.walk()].find(
      (el) => el.tag === "li" && el.textContent.startsWith("Codex 界面连接"),
    );
    // Neutral, not a fault; the message already names the version, so it is not repeated.
    expect(row?.props?.class).toBe("neutral");
    expect(row?.textContent).toBe(`Codex 界面连接${message}`);
    expect(page.root.textContent).toContain("一切正常");
    expect(page.find("重启 Codex")).toBeUndefined();
    await page.click("以完整模式重启 Codex");
    expect(page.calls).toContainEqual({
      method: "maintenance.restartCodex",
      params: { fullMode: true },
    });
    expect(page.toasts).toContain("Codex 正在重启");
  });

  it("does not offer it when the interface is connected", async () => {
    const page = await maintenancePage(compatibility("ready", "Codex 界面连接正常"));
    expect(page.find("以完整模式重启 Codex")).toBeUndefined();
    expect(page.calls.some((c) => c.method === "maintenance.restartCodex")).toBe(false);
  });
});
