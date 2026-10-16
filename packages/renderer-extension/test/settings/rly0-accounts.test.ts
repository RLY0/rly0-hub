import { describe, expect, it, vi } from "vitest";
import type { Rly0Account, Rly0AccountUsage } from "@codexhost/shared-contracts";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
}));

import {
  RLY0_MULTI_ACCOUNT_TERMS_STORAGE_KEY,
  mountRly0Accounts,
  type RendererRly0AccountClient,
} from "../../src/settings/rly0-accounts.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  className = "";
  textContent = "";
  title = "";
  type = "";
  dateTime = "";
  colSpan = 1;
  disabled = false;
  hidden = false;
  tabIndex = -1;
  constructor(readonly tagName: string) {}
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  append(...children: unknown[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: unknown[]): void {
    this.children.length = 0;
    this.children.push(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  focus(): void {
    // Not asserted in these tests.
  }
  open = false;
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
    this.listeners.get("close")?.();
  }
  remove(): void {
    this.open = false;
  }
}

const fakeDocument = {
  createElement: (tagName: string) => new FakeElement(tagName),
} as unknown as Document;

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}
function text(root: FakeElement): string {
  return descendants(root)
    .map((el) => el.textContent)
    .filter(Boolean)
    .join(" | ");
}
function buttonWithText(root: FakeElement, label: string): FakeElement | undefined {
  return descendants(root).find((el) => el.tagName === "button" && el.textContent === label);
}
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

const settingsMessages = rendererSettingsMessages("zh-CN");
const messages = settingsMessages.rly0Accounts;

function mount(getClient: () => RendererRly0AccountClient | null, loginOnly = false) {
  const root = new FakeElement("div") as unknown as HTMLElement;
  Object.assign(root, { ownerDocument: fakeDocument });
  const controller = new AbortController();
  const changed = vi.fn();
  const mounted = mountRly0Accounts(
    root,
    controller.signal,
    getClient,
    settingsMessages,
    changed,
    loginOnly,
  );
  return { mounted, changed, root: mounted.section as unknown as FakeElement };
}

const available = async () => ({
  available: true as const,
  name: "rly0-core",
  version: "1.0.0",
  capabilities: ["accounts"],
});

function usage(fivePercent: number, weeklyPercent: number, fetchedAt: number): Rly0AccountUsage {
  return {
    windows: [
      { kind: "primary", usedPercent: fivePercent, windowSeconds: 18_000 },
      { kind: "secondary", usedPercent: weeklyPercent, windowSeconds: 604_800 },
    ],
    fetchedAt,
    source: "snapshot",
  };
}

describe("mountRly0Accounts", () => {
  it("keeps browser sign-in but hides saved-account management when Hub owns it", async () => {
    const { mounted, root } = mount(
      () => ({
        rly0CoreStatus: available,
        listRly0Accounts: async () => ({
          available: true,
          accounts: [{ id: "abcdef012345", alias: "saved-account", current: true }],
        }),
        startRly0AddAccountLogin: vi.fn(),
        rly0AddAccountLoginStatus: vi.fn(),
        cancelRly0AddAccountLogin: vi.fn(),
      }),
      true,
    );
    await mounted.refresh();
    expect(text(root)).not.toContain("saved-account");
    expect(buttonWithText(root, messages.save)?.hidden).toBe(true);
    expect(buttonWithText(root, messages.usageRefreshAll)?.hidden).toBe(true);
    expect(buttonWithText(root, messages.add)?.hidden).toBe(false);
  });

  it("shows the unavailable hint and hides the header buttons when the bridge is missing", async () => {
    const { mounted, root } = mount(() => ({
      rly0CoreStatus: async () => ({ available: false }),
    }));
    await mounted.refresh();
    expect(text(root)).toContain(messages.unavailableHint);
    expect(buttonWithText(root, messages.save)?.hidden).toBe(true);
    expect(buttonWithText(root, messages.usageRefreshAll)?.hidden).toBe(true);
  });

  it("shows the unavailable hint when the client exposes no rly0 methods at all", async () => {
    const { mounted, root } = mount(() => null);
    await mounted.refresh();
    expect(text(root)).toContain(messages.unavailableHint);
  });

  it("lists saved accounts once the bridge is available", async () => {
    const accounts: Rly0Account[] = [
      { id: "abcdef012345", alias: "work", email: "work@example.com", plan: "pro", current: true },
      { id: "0123456789ab", alias: "personal", current: false },
    ];
    const { mounted, root, changed } = mount(() => ({
      rly0CoreStatus: available,
      listRly0Accounts: async () => ({ available: true, accounts }),
    }));
    await mounted.refresh();
    const rendered = text(root);
    expect(rendered).toContain("work");
    expect(rendered).toContain("personal");
    expect(rendered).toContain(messages.currentBadge);
    expect(rendered).toContain(messages.usageEmpty);
    const noticeElement = root.children[1] as FakeElement;
    expect(noticeElement.hidden).toBe(true);
    expect(changed).toHaveBeenCalled();
  });

  it("shows the empty state when the bridge is available but nothing is saved yet", async () => {
    const { mounted, root } = mount(() => ({
      rly0CoreStatus: available,
      listRly0Accounts: async () => ({ available: true, accounts: [] }),
    }));
    await mounted.refresh();
    expect(text(root)).toContain(messages.empty);
  });

  it("renders cached lastUsage with the 5-hour and weekly remaining and a relative time", async () => {
    const fetchedAt = Math.floor(Date.now() / 1000) - 5 * 60;
    const accounts: Rly0Account[] = [
      { id: "abcdef012345", alias: "work", current: true, lastUsage: usage(30, 60, fetchedAt) },
    ];
    const { mounted, root } = mount(() => ({
      rly0CoreStatus: available,
      listRly0Accounts: async () => ({ available: true, accounts }),
    }));
    await mounted.refresh();
    const rendered = text(root);
    expect(rendered).toContain("70%");
    expect(rendered).toContain("40%");
    expect(rendered).toContain(
      messages.usageUpdated.replace("{time}", messages.minutesAgo.replace("{n}", "5")),
    );
    expect(rendered).toContain(messages.usageCached);
    expect(descendants(root).some((el) => el.tagName === "table")).toBe(true);
  });

  it("refreshes one account and maps usage error codes to readable messages", async () => {
    const accounts: Rly0Account[] = [
      { id: "abcdef012345", alias: "work", current: true },
      { id: "0123456789ab", alias: "personal", current: false },
    ];
    const rly0AccountUsage = vi
      .fn()
      .mockRejectedValueOnce({ code: -32000, message: "USAGE_TOKEN_EXPIRED" })
      .mockRejectedValueOnce({ code: -32000, message: "USAGE_BLOCKED" })
      .mockRejectedValueOnce({ code: -32000, message: "USAGE_NETWORK" })
      .mockResolvedValueOnce({
        available: true,
        usage: { ...usage(10, 20, Math.floor(Date.now() / 1000)), source: "live" },
      });
    const { mounted, root } = mount(() => ({
      rly0CoreStatus: available,
      listRly0Accounts: async () => ({ available: true, accounts }),
      rly0AccountUsage,
    }));
    await mounted.refresh();
    const clickFirstRefresh = async () => {
      const button = descendants(root).find(
        (el) => el.tagName === "button" && el.textContent === messages.usageRefresh,
      );
      button?.listeners.get("click")?.();
      await flush();
    };
    await clickFirstRefresh();
    expect(rly0AccountUsage).toHaveBeenLastCalledWith({ id: "abcdef012345" });
    expect(text(root)).toContain("登录已过期，切换到该账号后刷新");
    await clickFirstRefresh();
    expect(text(root)).toContain("被网络防护拦截，请稍后或换网络");
    await clickFirstRefresh();
    expect(text(root)).toContain("网络错误");
    await clickFirstRefresh();
    const rendered = text(root);
    expect(rendered).not.toContain("网络错误");
    expect(rendered).toContain("90%");
    expect(rendered).toContain(messages.usageUpdated.replace("{time}", messages.justNow));
  });

  it("refreshes every account with usageAll and applies per-account errors", async () => {
    const accounts: Rly0Account[] = [
      { id: "abcdef012345", alias: "work", current: true },
      { id: "0123456789ab", alias: "personal", current: false },
    ];
    const now = Math.floor(Date.now() / 1000);
    const rly0AccountUsageAll = vi.fn(async () => ({
      available: true as const,
      results: [
        { id: "abcdef012345", usage: usage(50, 50, now) },
        { id: "0123456789ab", error: "USAGE_BLOCKED" },
      ],
    }));
    const { mounted, root } = mount(() => ({
      rly0CoreStatus: available,
      listRly0Accounts: async () => ({ available: true, accounts }),
      rly0AccountUsageAll,
    }));
    await mounted.refresh();
    const refreshAll = buttonWithText(root, messages.usageRefreshAll);
    expect(refreshAll?.hidden).toBe(false);
    refreshAll?.listeners.get("click")?.();
    await flush();
    expect(rly0AccountUsageAll).toHaveBeenCalledTimes(1);
    const rendered = text(root);
    expect(rendered).toContain("50%");
    expect(rendered).toContain(messages.usageBlocked);
  });

  it("accepts usage pushed from the quota alert poll", async () => {
    const accounts: Rly0Account[] = [{ id: "abcdef012345", alias: "work", current: true }];
    const { mounted, root } = mount(() => ({
      rly0CoreStatus: available,
      listRly0Accounts: async () => ({ available: true, accounts }),
    }));
    await mounted.refresh();
    mounted.applyUsage([
      { id: "abcdef012345", usage: usage(95, 10, Math.floor(Date.now() / 1000)) },
    ]);
    expect(text(root)).toContain("5%");
  });

  it("shows the multi-account notice once before saving a second account", async () => {
    const storage = new Map<string, string>();
    const document = {
      createElement: (tagName: string) => new FakeElement(tagName),
      defaultView: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => void storage.set(key, value),
        },
      },
    } as unknown as Document;
    const root = new FakeElement("div");
    Object.assign(root, { ownerDocument: document });
    let accounts: Rly0Account[] = [];
    const importCurrent = vi.fn(async () => ({ available: true as const, id: "x" }));
    const mounted = mountRly0Accounts(
      root as unknown as HTMLElement,
      new AbortController().signal,
      () =>
        ({
          rly0CoreStatus: available,
          listRly0Accounts: async () => ({ available: true, accounts }),
          importCurrentRly0Account: importCurrent,
        }) as unknown as RendererRly0AccountClient,
      settingsMessages,
      vi.fn(),
    );
    const section = mounted.section as unknown as FakeElement;
    const openDialog = () =>
      root.children.find(
        (child): child is FakeElement => child instanceof FakeElement && child.open,
      );
    await mounted.refresh();

    // The first account needs no notice.
    buttonWithText(section, messages.save)?.listeners.get("click")?.();
    expect(text(openDialog() as FakeElement)).not.toContain(messages.termsTitle);
    openDialog()?.close();

    accounts = [{ id: "abcdef012345", alias: "work", current: true }];
    await mounted.refresh();
    buttonWithText(section, messages.save)?.listeners.get("click")?.();
    const notice = openDialog() as FakeElement;
    expect(text(notice)).toContain(messages.termsTitle);
    expect(text(notice)).toContain("OpenAI 使用条款");
    // Cancelling keeps it unacknowledged.
    buttonWithText(notice, messages.cancel)?.listeners.get("click")?.();
    expect(storage.has(RLY0_MULTI_ACCOUNT_TERMS_STORAGE_KEY)).toBe(false);

    buttonWithText(section, messages.save)?.listeners.get("click")?.();
    buttonWithText(openDialog() as FakeElement, messages.termsAcknowledge)?.listeners.get(
      "click",
    )?.();
    await flush();
    expect(storage.get(RLY0_MULTI_ACCOUNT_TERMS_STORAGE_KEY)).toBe("1");
    // It continues straight into the save dialog, and never shows again.
    expect(text(openDialog() as FakeElement)).not.toContain(messages.termsTitle);
    expect(buttonWithText(openDialog() as FakeElement, messages.save)).toBeDefined();
    openDialog()?.close();
    buttonWithText(section, messages.add)?.listeners.get("click")?.();
    expect(text(openDialog() as FakeElement)).toContain(messages.addTitle);
    expect(text(openDialog() as FakeElement)).not.toContain(messages.termsTitle);
  });
});
