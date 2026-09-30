import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: (name: string) => ({ icon: name, classList: { add() {} } }),
  isRendererSettingsIconName: () => true,
}));

import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import { createDefaultRendererSettingsPages } from "../../src/settings/pages.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly #listeners = new Map<string, ((event?: unknown) => void)[]>();
  className = "";
  textContent = "";
  title = "";
  type = "";
  href = "";
  target = "";
  rel = "";
  src = "";
  alt = "";
  draggable = true;
  open = false;
  focused = false;
  parent: FakeElement | undefined;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  append(...children: unknown[]): void {
    for (const child of children) if (child instanceof FakeElement) child.parent = this;
    this.children.push(...children);
  }
  remove(): void {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
    this.parent = undefined;
  }
  addEventListener(name: string, listener: (event?: unknown) => void): void {
    this.#listeners.set(name, [...(this.#listeners.get(name) ?? []), listener]);
  }
  dispatch(name: string, event?: unknown): void {
    for (const listener of this.#listeners.get(name) ?? []) listener(event);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.dispatch("close");
  }
  focus(): void {
    this.focused = true;
  }
}

class FakeDocument {
  readonly defaultView = { navigator: { platform: "MacIntel", userAgent: "Macintosh" } };
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}

function visibleText(root: FakeElement): string {
  return descendants(root)
    .map(({ textContent }) => textContent)
    .filter(Boolean)
    .join(" ");
}

function mountAbout(locale: "zh-CN" | "en" = "zh-CN") {
  const page = createDefaultRendererSettingsPages(rendererSettingsMessages(locale)).find(
    ({ id }) => id === "about",
  );
  if (!page) throw new Error("About page is not registered");
  const document = new FakeDocument();
  const content = document.createElement("main");
  const scope = new RendererSettingsPageScope();
  page.mount({
    content: content as unknown as HTMLElement,
    signal: scope.signal,
    runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
  });
  const entry = descendants(content).find(
    (element) => element.tagName === "button" && element.dataset.sponsorEntry === "true",
  );
  const dialog = () => descendants(content).find((element) => element.tagName === "dialog");
  return { content, scope, entry, dialog };
}

describe("Sponsor dialog", () => {
  it("adds a coffee sponsor entry to the About page without opening a dialog", () => {
    const { entry, dialog, scope } = mountAbout();
    expect(entry).toBeDefined();
    expect(visibleText(entry as FakeElement)).toContain("请作者喝杯咖啡");
    expect(entry?.children.some((child) => (child as { icon?: string }).icon === "coffee")).toBe(
      true,
    );
    expect(dialog()).toBeUndefined();
    scope.dispose();
  });

  it("opens a dialog with both QR codes, Chinese copy, and the author-run relay link", () => {
    const { entry, dialog, scope } = mountAbout();
    entry?.dispatch("click");
    const modal = dialog();
    expect(modal?.open).toBe(true);
    const text = visibleText(modal as FakeElement);
    expect(text).toContain("请作者喝杯咖啡");
    expect(text).toContain(
      "RLY/0 Hub 免费开源。如果它帮到了你，欢迎自愿赞助，完全不影响任何功能。",
    );
    expect(text).toContain("微信");
    expect(text).toContain("支付宝");
    expect(text).toContain("作者自营中转站：");
    expect(text).toContain("RLY/0 · 零号中转");

    const images = descendants(modal as FakeElement).filter(({ tagName }) => tagName === "img");
    expect(images).toHaveLength(2);
    expect(images.map(({ alt }) => alt)).toEqual(["微信", "支付宝"]);
    expect(images[0]?.src).toMatch(/sponsor-wechat\.jpg$|^data:image\/jpeg/);
    expect(images[1]?.src).toMatch(/sponsor-alipay\.jpg$|^data:image\/jpeg/);

    const link = descendants(modal as FakeElement).find(({ tagName }) => tagName === "a");
    expect(link).toMatchObject({
      href: "https://rly0.com",
      target: "_blank",
      rel: "noopener noreferrer",
    });
    expect(visibleText(link as FakeElement)).toContain("https://rly0.com");
    scope.dispose();
  });

  it("uses English copy for the English locale", () => {
    const { entry, dialog, scope } = mountAbout("en");
    entry?.dispatch("click");
    const text = visibleText(dialog() as FakeElement);
    expect(text).toContain("Buy me a coffee");
    expect(text).toContain("WeChat Pay");
    expect(text).toContain("Alipay");
    scope.dispose();
  });

  it("closes from the close button and returns focus to the entry", () => {
    const { entry, dialog, scope } = mountAbout();
    entry?.dispatch("click");
    const modal = dialog() as FakeElement;
    const closeButton = descendants(modal).find(
      (element) => element.tagName === "button" && element.getAttribute("aria-label") === "关闭",
    );
    closeButton?.dispatch("click");
    expect(modal.open).toBe(false);
    expect(dialog()).toBeUndefined();
    expect(entry?.focused).toBe(true);

    entry?.dispatch("click");
    expect(dialog()?.open).toBe(true);
    scope.dispose();
  });

  it("closes on Escape", () => {
    const { entry, dialog, scope } = mountAbout();
    entry?.dispatch("click");
    const modal = dialog() as FakeElement;
    const preventDefault = vi.fn();
    modal.dispatch("keydown", { key: "Escape", preventDefault, stopPropagation: vi.fn() });
    expect(preventDefault).toHaveBeenCalled();
    expect(modal.open).toBe(false);
    expect(dialog()).toBeUndefined();
    scope.dispose();
  });

  it("removes an open dialog when the page is disposed", () => {
    const { entry, dialog, scope } = mountAbout();
    entry?.dispatch("click");
    expect(dialog()).toBeDefined();
    scope.dispose();
    expect(dialog()).toBeUndefined();
  });
});
