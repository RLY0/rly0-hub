import { describe, expect, it, vi } from "vitest";
import type { Rly0Account } from "@codexhost/shared-contracts";

import { mountRly0Accounts, type RendererRly0AccountClient } from "../../src/settings/rly0-accounts.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  className = "";
  textContent = "";
  title = "";
  type = "";
  disabled = false;
  hidden = false;
  tabIndex = -1;
  constructor(readonly tagName: string) {}
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...children);
  }
  setAttribute(): void {
    // Not asserted in these tests.
  }
  focus(): void {
    // Not asserted in these tests.
  }
}

const fakeDocument = {
  createElement: (tagName: string) => new FakeElement(tagName),
} as unknown as Document;

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => descendants(child)),
  ];
}
function text(root: FakeElement): string {
  return descendants(root)
    .map((el) => el.textContent)
    .filter(Boolean)
    .join(" | ");
}

const messages = rendererSettingsMessages("zh-CN").rly0Accounts;

function mount(getClient: () => RendererRly0AccountClient | null) {
  const root = new FakeElement("div") as unknown as HTMLElement;
  Object.assign(root, { ownerDocument: fakeDocument });
  const controller = new AbortController();
  const changed = vi.fn();
  const mounted = mountRly0Accounts(root, controller.signal, getClient, messages, changed);
  return { mounted, changed, root: mounted.section as unknown as FakeElement };
}

describe("mountRly0Accounts", () => {
  it("shows the unavailable hint and hides the save button when the bridge is missing", async () => {
    const { mounted, root } = mount(() => ({
      rly0CoreStatus: async () => ({ available: false }),
    }));
    await mounted.refresh();
    expect(text(root)).toContain(messages.unavailableHint);
    const saveButton = descendants(root).find((el) => el.tagName === "button");
    expect(saveButton?.hidden).toBe(true);
  });

  it("shows the unavailable hint when the client exposes no rly0 methods at all", async () => {
    const { mounted, root } = mount(() => null);
    await mounted.refresh();
    expect(text(root)).toContain(messages.unavailableHint);
  });

  it("lists saved accounts once the bridge is available", async () => {
    const accounts: Rly0Account[] = [
      {
        id: "abcdef012345",
        alias: "work",
        email: "work@example.com",
        plan: "pro",
        current: true,
      },
      {
        id: "0123456789ab",
        alias: "personal",
        current: false,
      },
    ];
    const { mounted, root, changed } = mount(() => ({
      rly0CoreStatus: async () => ({
        available: true,
        name: "rly0-core",
        version: "1.0.0",
        capabilities: ["accounts"],
      }),
      listRly0Accounts: async () => ({ available: true, accounts }),
    }));
    await mounted.refresh();
    const rendered = text(root);
    expect(rendered).toContain("work");
    expect(rendered).toContain("personal");
    expect(rendered).toContain(messages.currentBadge);
    const noticeElement = root.children[1];
    expect(noticeElement?.hidden).toBe(true);
    expect(changed).toHaveBeenCalled();
  });

  it("shows the empty state when the bridge is available but nothing is saved yet", async () => {
    const { mounted, root } = mount(() => ({
      rly0CoreStatus: async () => ({
        available: true,
        name: "rly0-core",
        version: "1.0.0",
        capabilities: ["accounts"],
      }),
      listRly0Accounts: async () => ({ available: true, accounts: [] }),
    }));
    await mounted.refresh();
    expect(text(root)).toContain(messages.empty);
  });
});
