import { describe, expect, it } from "vitest";

import { relayChinese } from "../../src/settings/relay-messages.js";
import {
  createRly0Showcase,
  RLY0_RELAY_PROMO_DISMISSED_KEY,
  RLY0_RELAY_PROMO_URL,
} from "../../src/settings/rly0-showcase.js";

class FakeElement {
  children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  className = "";
  textContent = "";
  hidden = false;
  href = "";
  target = "";
  rel = "";
  src = "";
  alt = "x";
  type = "";
  constructor(readonly tagName: string) {}
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(): void {
    this.children = [];
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
}

function all(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap(all)];
}

function fakeDocument(storage: Record<string, string>): Document {
  return {
    createElement: (tag: string) => new FakeElement(tag),
    defaultView: {
      localStorage: {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, value: string) => {
          storage[key] = value;
        },
      },
    },
  } as unknown as Document;
}

describe("RLY/0 relay showcase", () => {
  it("shows the brand mark, author label and an outbound-only link", () => {
    const storage: Record<string, string> = {};
    const root = createRly0Showcase(fakeDocument(storage), relayChinese) as unknown as FakeElement;
    const nodes = all(root);
    const logo = nodes.find((node) => node.tagName === "img");
    expect(logo?.src).toBeTruthy();
    expect(logo?.alt).toBe("");
    expect(nodes.some((node) => node.textContent === "作者自营")).toBe(true);
    const link = nodes.find((node) => node.tagName === "a");
    expect(link?.href).toBe(RLY0_RELAY_PROMO_URL);
    expect(link?.rel).toBe("noopener noreferrer");
    expect(link?.listeners.size).toBe(0);
    const route = nodes.find((node) => node.className === "settings-rly0-showcase__route");
    expect(route?.attributes.get("aria-hidden")).toBe("true");
    expect(nodes.some((node) => node.textContent === relayChinese.promoTagline)).toBe(true);
  });

  it("stays dismissed once closed and omits the details in compact mode", () => {
    const storage: Record<string, string> = {};
    const document = fakeDocument(storage);
    const compact = createRly0Showcase(document, relayChinese, {
      compact: true,
    }) as unknown as FakeElement;
    expect(compact.className).toContain("settings-rly0-showcase--compact");
    expect(all(compact).some((node) => node.className === "settings-rly0-showcase__route")).toBe(
      false,
    );
    const dismiss = all(compact).find((node) => node.textContent === relayChinese.promoDismiss);
    dismiss?.listeners.get("click")?.();
    expect(storage[RLY0_RELAY_PROMO_DISMISSED_KEY]).toBe("1");
    expect(compact.hidden).toBe(true);
    expect(createRly0Showcase(document, relayChinese)).toBeNull();
  });
});
