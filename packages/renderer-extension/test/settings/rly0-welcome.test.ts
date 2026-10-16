import { describe, expect, it, vi } from "vitest";

import {
  RLY0_WELCOME_DISMISSED_STORAGE_KEY,
  createRly0Welcome,
  rly0WelcomeMessages,
} from "../../src/settings/rly0-welcome.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  className = "";
  textContent = "";
  type = "";
  removed = false;
  constructor(readonly tagName: string) {}
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  remove(): void {
    this.removed = true;
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

function fakeDocument(storage: Map<string, string>): Document {
  return {
    createElement: (tagName: string) => new FakeElement(tagName),
    defaultView: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
      },
    },
  } as unknown as Document;
}

const text = rly0WelcomeMessages("zh-CN");

describe("RLY/0 welcome card", () => {
  it("lists the steps with buttons to the right pages and goes away for good once dismissed", () => {
    const storage = new Map<string, string>();
    const navigate = vi.fn();
    const card = createRly0Welcome(
      fakeDocument(storage),
      "zh-CN",
      navigate,
    ) as unknown as FakeElement | null;
    if (!card) throw new Error("expected the welcome card");
    const all = descendants(card);
    const rendered = all.map((el) => el.textContent).join(" | ");
    for (const part of [text.title, text.openTitle, text.entryTitle, text.relayTitle]) {
      expect(rendered).toContain(part);
    }
    const buttons = all.filter((el) => el.tagName === "button");
    for (const [label, page] of [
      [text.accountAction, "accounts"],
      [text.relayAction, "relay"],
      [text.backupAction, "maintenance"],
    ] as const) {
      buttons.find((el) => el.textContent === label)?.listeners.get("click")?.();
      expect(navigate).toHaveBeenLastCalledWith(page);
    }
    expect(storage.has(RLY0_WELCOME_DISMISSED_STORAGE_KEY)).toBe(false);

    buttons.find((el) => el.textContent === text.dismiss)?.listeners.get("click")?.();
    expect(card.removed).toBe(true);
    expect(storage.get(RLY0_WELCOME_DISMISSED_STORAGE_KEY)).toBe("1");
    expect(createRly0Welcome(fakeDocument(storage), "zh-CN", navigate)).toBeNull();
  });

  it("shows no navigation buttons when the shell cannot navigate", () => {
    const card = createRly0Welcome(
      fakeDocument(new Map()),
      "en",
      undefined,
    ) as unknown as FakeElement | null;
    if (!card) throw new Error("expected the welcome card");
    const buttons = descendants(card).filter((el) => el.tagName === "button");
    expect(buttons.map((el) => el.textContent)).toEqual([rly0WelcomeMessages("en").dismiss]);
  });
});
