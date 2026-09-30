import { describe, expect, it, vi } from "vitest";
import type { Rly0Account, Rly0AccountUsage } from "@codexhost/shared-contracts";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
}));

import { rendererSettingsMessages } from "../../src/settings/localization.js";
import {
  evaluateRly0QuotaAlert,
  mountRly0QuotaAlert,
  rly0QuotaAlertText,
  type RendererRly0QuotaAlertClient,
} from "../../src/settings/rly0-quota-alert.js";
import {
  formatRly0RelativeTime,
  rly0ErrorCode,
  rly0UsageErrorMessage,
  rly0UsageLowestWindow,
  rly0UsagePeriod,
  rly0UsageToCredits,
} from "../../src/settings/rly0-usage.js";
import {
  RENDERER_QUOTA_ALERT_ENABLED_STORAGE_KEY,
  RENDERER_QUOTA_ALERT_THRESHOLD_STORAGE_KEY,
} from "../../src/renderer-appearance-preferences.js";

const settingsMessages = rendererSettingsMessages("zh-CN");
const messages = settingsMessages.rly0Accounts;

function usage(fiveUsed: number, weeklyUsed: number, fetchedAt = 1_800_000_000): Rly0AccountUsage {
  return {
    windows: [
      { kind: "primary", usedPercent: fiveUsed, windowSeconds: 18_000, resetsAt: 1_800_003_600 },
      { kind: "secondary", usedPercent: weeklyUsed, windowSeconds: 604_800 },
    ],
    fetchedAt,
    source: "live",
  };
}

describe("rly0 usage helpers", () => {
  it("classifies windows by length first and by kind otherwise", () => {
    expect(rly0UsagePeriod({ kind: "secondary", usedPercent: 1, windowSeconds: 18_000 })).toBe(
      "five_hour",
    );
    expect(rly0UsagePeriod({ kind: "primary", usedPercent: 1, windowSeconds: 604_800 })).toBe(
      "seven_day",
    );
    expect(rly0UsagePeriod({ kind: "primary", usedPercent: 1, windowSeconds: 86_400 })).toBeNull();
    expect(rly0UsagePeriod({ kind: "primary", usedPercent: 1 })).toBe("five_hour");
    expect(rly0UsagePeriod({ kind: "secondary", usedPercent: 1 })).toBe("seven_day");
  });

  it("maps the 5-hour window to the main meter and the weekly window to the 7-day column", () => {
    const credits = rly0UsageToCredits(usage(30, 60));
    expect(credits).toMatchObject({
      usedPercent: 30,
      periodType: "five_hour",
      resetsAt: new Date(1_800_003_600 * 1000).toISOString(),
      productUsage: [{ product: "7-day window", usagePercent: 60 }],
    });
  });

  it("uses a weekly-only payload as the main seven-day meter", () => {
    const credits = rly0UsageToCredits({
      windows: [{ kind: "secondary", usedPercent: 12, windowSeconds: 604_800 }],
      fetchedAt: 1,
      source: "snapshot",
    });
    expect(credits).toMatchObject({ usedPercent: 12, periodType: "seven_day" });
    expect(credits?.productUsage).toBeUndefined();
    expect(rly0UsageToCredits({ windows: [], fetchedAt: 1, source: "live" })).toBeNull();
  });

  it("finds the tightest window", () => {
    expect(rly0UsageLowestWindow(usage(30, 95))).toEqual({
      period: "seven_day",
      remainingPercent: 5,
    });
    expect(rly0UsageLowestWindow({ windows: [], fetchedAt: 1, source: "live" })).toBeNull();
  });

  it("extracts code-shaped messages and maps the documented usage errors", () => {
    expect(rly0ErrorCode({ code: -32000, message: "USAGE_BLOCKED" })).toBe("USAGE_BLOCKED");
    expect(rly0ErrorCode(new Error("something broke"))).toBeNull();
    expect(rly0ErrorCode("USAGE_NETWORK")).toBe("USAGE_NETWORK");
    expect(rly0UsageErrorMessage("USAGE_TOKEN_EXPIRED", messages)).toBe(
      "登录已过期，切换到该账号后刷新",
    );
    expect(rly0UsageErrorMessage("USAGE_BLOCKED", messages)).toBe("被网络防护拦截，请稍后或换网络");
    expect(rly0UsageErrorMessage("USAGE_NETWORK", messages)).toBe("网络错误");
    expect(rly0UsageErrorMessage("WHATEVER", messages)).toBe(messages.usageFailed);
  });

  it("formats relative times", () => {
    const now = 1_800_000_000_000;
    expect(formatRly0RelativeTime(now / 1000 - 10, messages, now)).toBe(messages.justNow);
    expect(formatRly0RelativeTime(now / 1000 - 5 * 60, messages, now)).toBe("5 分钟前");
    expect(formatRly0RelativeTime(now / 1000 - 3 * 3600, messages, now)).toBe(
      messages.hoursAgo.replace("{n}", "3"),
    );
    expect(formatRly0RelativeTime(now / 1000 - 72 * 3600, messages, now)).toBe(
      messages.daysAgo.replace("{n}", "3"),
    );
  });
});

const accounts: Rly0Account[] = [
  { id: "aaaaaaaaaaaa", alias: "work", current: true },
  { id: "bbbbbbbbbbbb", alias: "spare", current: false },
  { id: "cccccccccccc", alias: "backup", current: false },
];

describe("evaluateRly0QuotaAlert", () => {
  it("does not alert while the current account is above the threshold", () => {
    const usageById = new Map([["aaaaaaaaaaaa", usage(50, 50)]]);
    expect(evaluateRly0QuotaAlert(accounts, usageById, 10)).toBeNull();
    expect(evaluateRly0QuotaAlert(accounts, new Map(), 10)).toBeNull();
  });

  it("alerts on any low window and suggests the account with the most left", () => {
    const usageById = new Map([
      ["aaaaaaaaaaaa", usage(10, 95)],
      ["bbbbbbbbbbbb", usage(40, 50)],
      ["cccccccccccc", usage(20, 70)],
    ]);
    const evaluation = evaluateRly0QuotaAlert(accounts, usageById, 10);
    expect(evaluation).toMatchObject({
      period: "seven_day",
      remainingPercent: 5,
      best: { account: { id: "bbbbbbbbbbbb" }, remainingPercent: 50 },
    });
    if (!evaluation) throw new Error("expected an alert");
    const copy = rly0QuotaAlertText(evaluation, messages);
    expect(copy.body).toContain("work");
    expect(copy.body).toContain("每周");
    expect(copy.suggestion).toContain("spare");
  });

  it("falls back to cached lastUsage and never suggests a worse account", () => {
    const cached = accounts.map((account) =>
      account.id === "aaaaaaaaaaaa"
        ? { ...account, lastUsage: usage(92, 10) }
        : { ...account, lastUsage: usage(99, 10) },
    );
    const evaluation = evaluateRly0QuotaAlert(cached, new Map(), 10);
    expect(evaluation?.period).toBe("five_hour");
    expect(evaluation?.best).toBeNull();
    if (!evaluation) throw new Error("expected an alert");
    expect(rly0QuotaAlertText(evaluation, messages).suggestion).toBe(messages.alertNoCandidate);
  });
});

class FakeElement {
  readonly children: unknown[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (event?: unknown) => void>();
  className = "";
  textContent = "";
  type = "";
  disabled = false;
  hidden = false;
  open = false;
  constructor(
    readonly tagName: string,
    readonly ownerDocument: unknown,
  ) {}
  addEventListener(name: string, listener: (event?: unknown) => void): void {
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
  remove(): void {
    // Detached dialogs are not tracked.
  }
  focus(): void {
    // Not asserted.
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
    this.listeners.get("close")?.();
  }
}

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
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function fakeWindow(storage: Record<string, string>) {
  const listeners = new Map<string, () => void>();
  return {
    localStorage: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
    },
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
    listeners,
  };
}

function mountAlert(client: RendererRly0QuotaAlertClient | null, storage: Record<string, string>) {
  const view = fakeWindow(storage);
  const document = {
    defaultView: view,
    createElement: (tagName: string): FakeElement => new FakeElement(tagName, document),
  };
  const root = new FakeElement("div", document);
  const controller = new AbortController();
  const onSwitched = vi.fn();
  const alert = mountRly0QuotaAlert(
    root as unknown as HTMLElement,
    controller.signal,
    () => client,
    settingsMessages,
    { onSwitched },
  );
  return {
    alert,
    root,
    element: alert.element as unknown as FakeElement,
    controller,
    onSwitched,
  };
}

describe("mountRly0QuotaAlert", () => {
  it("stays hidden and never polls while the preference is off (default)", async () => {
    const rly0AccountUsageAll = vi.fn();
    const { element, controller } = mountAlert(
      { listRly0Accounts: vi.fn(), rly0AccountUsageAll },
      {},
    );
    await flush();
    expect(element.hidden).toBe(true);
    expect(rly0AccountUsageAll).not.toHaveBeenCalled();
    controller.abort();
  });

  it("shows the requires-core hint when enabled without rly0-core", async () => {
    const { element, controller } = mountAlert(
      {
        listRly0Accounts: async () => ({ available: false, accounts: [] }),
        rly0AccountUsageAll: vi.fn(),
      },
      { [RENDERER_QUOTA_ALERT_ENABLED_STORAGE_KEY]: "true" },
    );
    await flush();
    expect(element.hidden).toBe(false);
    expect(text(element)).toContain(messages.alertUnavailable);
    controller.abort();
  });

  it("alerts, and switches only after the confirmation dialog is accepted", async () => {
    const switchRly0Account = vi.fn(async (input: { id: string }) => ({
      id: input.id,
      available: true as const,
      switched: true,
      alreadyCurrent: false,
    }));
    const client: RendererRly0QuotaAlertClient = {
      listRly0Accounts: async () => ({ available: true, accounts }),
      rly0AccountUsageAll: async () => ({
        available: true,
        results: [
          { id: "aaaaaaaaaaaa", usage: usage(95, 20) },
          { id: "bbbbbbbbbbbb", usage: usage(10, 10) },
          { id: "cccccccccccc", error: "USAGE_BLOCKED" },
        ],
      }),
      switchRly0Account,
    };
    const { element, root, controller, onSwitched } = mountAlert(client, {
      [RENDERER_QUOTA_ALERT_ENABLED_STORAGE_KEY]: "true",
      [RENDERER_QUOTA_ALERT_THRESHOLD_STORAGE_KEY]: "10",
    });
    await flush();
    expect(element.hidden).toBe(false);
    expect(element.className).toContain("--warning");
    expect(text(element)).toContain("spare");
    const switchButton = descendants(element).find((el) => el.textContent === messages.alertSwitch);
    switchButton?.listeners.get("click")?.();
    expect(switchRly0Account).not.toHaveBeenCalled();
    const dialog = root.children.find(
      (child) => child instanceof FakeElement && child.tagName === "dialog",
    ) as FakeElement;
    expect(dialog.open).toBe(true);
    expect(text(dialog)).toContain("Codex");
    const confirm = descendants(dialog).find((el) => el.textContent === messages.switchConfirm);
    confirm?.listeners.get("click")?.();
    await flush();
    expect(switchRly0Account).toHaveBeenCalledWith({ id: "bbbbbbbbbbbb" });
    expect(onSwitched).toHaveBeenCalled();
    expect(dialog.open).toBe(false);
    expect(element.className).toContain("--info");
    controller.abort();
  });
});
