// Synthetic clock, DOM stand-ins and RPC only: no window, service, credential or network.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const page = (name: string) =>
  readFileSync(new URL(`../../../apps/hub-desktop/www/pages/${name}`, import.meta.url), "utf8");

interface Node {
  tag: string;
  props: Record<string, unknown>;
  children: unknown[];
}
const h = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({
  tag,
  props: props ?? {},
  children: children.flat(),
});
const text = (node: unknown): string =>
  typeof node === "string"
    ? node
    : node && typeof node === "object" && "children" in node
      ? (node as Node).children.map(text).join("")
      : "";

interface QuotaLive {
  freshness(at: number, now?: number): string;
  onShellEvent(data: unknown): boolean;
  ingest(update: unknown): void;
  mark(provider: string, id: string | null, source: string, at?: number): void;
  pick(
    provider: string,
    id: string,
    usage: unknown,
  ): { usage: unknown; at: number; source: string };
  pushedAt(provider: string, id: string): number;
  freshLine(fresh: unknown): Node | null;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  scheduler(
    tasks: { id: string; current?: boolean; run: () => Promise<unknown>; skip?: () => boolean }[],
  ): { tick(): Promise<string[]>; interval(id: string): number | null };
  visible(): boolean;
}

function load(clock: { now: number }, doc: { hidden: boolean } = { hidden: false }): QuotaLive {
  const window: Record<string, unknown> = {};
  runInNewContext(page("quota-live.js"), { window, globalThis: {}, Date, Math, Promise });
  const register = window.registerHubQuotaLive as (options: unknown) => QuotaLive;
  return register({ h, now: () => clock.now, doc });
}

const usage = (used: number, fetchedAt: number) => ({
  windows: [{ kind: "primary", usedPercent: used }],
  fetchedAt,
  source: "snapshot",
});

describe("quota freshness labels", () => {
  it("says 刚刚, N 分钟前, then the clock time (with the date when older than today)", () => {
    const clock = { now: new Date(2026, 9, 26, 14, 30, 0).getTime() };
    const live = load(clock);
    expect(live.freshness(clock.now - 20_000)).toBe("刚刚");
    expect(live.freshness(clock.now + 5_000)).toBe("刚刚");
    expect(live.freshness(clock.now - 60_000)).toBe("1 分钟前");
    expect(live.freshness(clock.now - 59 * 60_000)).toBe("59 分钟前");
    expect(live.freshness(new Date(2026, 9, 26, 12, 30).getTime())).toBe("12:30");
    expect(live.freshness(new Date(2026, 9, 25, 9, 5).getTime())).toBe("10月25日 09:05");
  });

  it("names the source in one short line: reply, timed or manual", () => {
    const clock = { now: 1_800_000_000_000 };
    const live = load(clock);
    const read = usage(30, 1_800_000_000 - 120);
    expect(live.pick("codex", "a", read).source).toBe("scheduled");
    live.mark("codex", "a", "manual", clock.now - 121_000);
    expect(live.pick("codex", "a", read).source).toBe("manual");
    live.ingest({ provider: "codex", id: "a", usage: usage(31, 1), observedAt: clock.now - 5_000 });
    const fresh = live.pick("codex", "a", read);
    expect(fresh.source).toBe("conversation");
    expect((fresh.usage as { windows: { usedPercent: number }[] }).windows[0]?.usedPercent).toBe(
      31,
    );
    const line = live.freshLine(fresh);
    expect(text(line)).toBe("刚刚 · 随对话更新");
    // A later timed read wins over an older reply, and an old manual mark does not name it.
    expect(live.pick("codex", "a", usage(40, 1_800_000_600)).source).toBe("scheduled");
  });

  it("takes pushed quota and visibility from the shell and tells subscribers", () => {
    const clock = { now: 1_000_000 };
    const live = load(clock);
    const seen: unknown[] = [];
    live.subscribe((event) => seen.push(event.type));
    expect(
      live.onShellEvent({
        event: "quota",
        params: { provider: "claude", id: "0123456789ab", usage: usage(5, 1), observedAt: 999 },
      }),
    ).toBe(true);
    expect(live.pushedAt("claude", "0123456789ab")).toBe(999);
    // Malformed updates are dropped.
    live.ingest({ provider: "gemini", id: "x", usage: usage(1, 1) });
    live.ingest({ provider: "codex", id: "x", usage: { windows: [] } });
    expect(live.onShellEvent({ event: "visibility", visible: false })).toBe(true);
    expect(live.visible()).toBe(false);
    // The Claude usage window is gone (0.11.17); its close event is no longer a shell event.
    expect(live.onShellEvent({ event: "claudeUsageClosed", accountId: "0123456789ab" })).toBe(
      false,
    );
    expect(live.onShellEvent({ event: "navigate", page: "home" })).toBe(false);
    expect(seen).toEqual(["quota", "visibility"]);
  });
});

describe("timed quota refresh", () => {
  it("runs the current account every minute, others every 5 minutes, only while visible", async () => {
    const clock = { now: 0 };
    const doc = { hidden: false };
    const live = load(clock, doc);
    const runs: string[] = [];
    const plan = live.scheduler([
      { id: "current", current: true, run: async () => runs.push("current") },
      { id: "others", run: async () => runs.push("others") },
    ]);
    clock.now = 30_000;
    expect(await plan.tick()).toEqual([]);
    clock.now = 60_000;
    expect(await plan.tick()).toEqual(["current"]);
    doc.hidden = true;
    clock.now = 400_000;
    expect(await plan.tick()).toEqual([]);
    doc.hidden = false;
    live.onShellEvent({ event: "visibility", visible: false });
    expect(await plan.tick()).toEqual([]);
    live.onShellEvent({ event: "visibility", visible: true });
    expect(await plan.tick()).toEqual(["current", "others"]);
    expect(runs).toEqual(["current", "current", "others"]);
  });

  it("backs off after failures and skips when a reply already brought the numbers", async () => {
    const clock = { now: 0 };
    const live = load(clock);
    const run = vi.fn(async () => {
      throw new Error("USAGE_NETWORK");
    });
    let replied = false;
    const plan = live.scheduler([{ id: "current", current: true, run, skip: () => replied }]);
    clock.now = 60_000;
    await plan.tick();
    expect(plan.interval("current")).toBe(120_000);
    clock.now = 120_000;
    expect(await plan.tick()).toEqual([]);
    clock.now = 180_000;
    await plan.tick();
    expect(plan.interval("current")).toBe(240_000);
    for (let i = 0; i < 6; i += 1) {
      clock.now += 15 * 60_000;
      await plan.tick();
    }
    expect(plan.interval("current")).toBe(15 * 60_000);
    replied = true;
    const calls = run.mock.calls.length;
    clock.now += 60 * 60_000;
    expect(await plan.tick()).toEqual([]);
    expect(run.mock.calls.length).toBe(calls);
  });
});

describe("quota tiles for a refused token", () => {
  function cards() {
    const window: Record<string, unknown> = {
      registerHubResetCredits: () => ({ tile: () => null }),
      HubUI: { armable: () => () => true },
    };
    runInNewContext(page("account-cards.js"), { window, Date, Math, Promise });
    const register = window.registerHubAccountCards as (options: unknown) => {
      quotaCards(usage: unknown, options?: Record<string, unknown>): Node;
    };
    return register({
      h,
      call: vi.fn(),
      toast: vi.fn(),
      failed: vi.fn(),
      explain: (code: string) => code,
      countdown: () => "1 小时后",
      resetText: () => "23:20",
      resetCardTile: () => null,
    });
  }
  const now = Math.floor(Date.now() / 1000);

  it("says it is refused above windows that look unused, until the refusal ends", () => {
    const { quotaCards } = cards();
    const usage = {
      windows: [{ kind: "primary", usedPercent: 0, resetsAt: now + 3_600 }],
      fetchedAt: now,
      source: "snapshot",
    };
    const refused = text(
      quotaCards({ ...usage, limited: { until: now + 3_600, claim: "five_hour" } }),
    );
    expect(refused).toContain("正在被限流（5 小时额度），预计");
    expect(refused).toContain("重启 Codex 也不会恢复");
    expect(refused).toContain("剩 100%");
    expect(text(quotaCards({ ...usage, limited: { until: now - 1 } }))).not.toContain("限流");
    // Known only as refused (a plain 429 without windows).
    expect(
      text(
        quotaCards({ windows: [], limited: { until: now + 60 }, fetchedAt: now, source: "live" }),
      ),
    ).toContain("正在被限流（用量限制）");
  });

  it("takes in a pushed refusal even without windows", () => {
    const clock = { now: Date.now() };
    const live = load(clock);
    const refused = { windows: [], limited: { until: now + 60 }, fetchedAt: now, source: "live" };
    live.ingest({ provider: "claude", id: "aaaaaaaaaaaa", usage: refused, observedAt: clock.now });
    expect(live.pick("claude", "aaaaaaaaaaaa", null).usage).toEqual(refused);
  });
});

describe("quota tiles past their reset time", () => {
  function cards() {
    const window: Record<string, unknown> = {
      registerHubResetCredits: () => ({ tile: () => null }),
      HubUI: { armable: () => () => true },
    };
    runInNewContext(page("account-cards.js"), { window, Date, Math, Promise });
    const register = window.registerHubAccountCards as (options: unknown) => {
      quotaCards(usage: unknown, options?: Record<string, unknown>): Node;
    };
    return register({
      h,
      call: vi.fn(),
      toast: vi.fn(),
      failed: vi.fn(),
      explain: (code: string) => code,
      countdown: () => "1 小时后",
      resetText: () => "23:20 重置",
      resetCardTile: () => null,
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const find = (node: unknown, test: (n: Node) => boolean): Node[] =>
    node && typeof node === "object" && "children" in node
      ? [
          ...(test(node as Node) ? [node as Node] : []),
          ...(node as Node).children.flatMap((child) => find(child, test)),
        ]
      : [];

  it("shows a window whose reset passed as refilled, asking for 刷新 to confirm", () => {
    const { quotaCards } = cards();
    const usage = {
      windows: [
        { kind: "primary", usedPercent: 100, resetsAt: now - 60 },
        { kind: "secondary", usedPercent: 40, resetsAt: now + 86_400 },
      ],
      fetchedAt: now - 7_200,
      source: "snapshot",
    };
    const shown = quotaCards(usage);
    const content = text(shown);
    expect(content).toContain("已重置");
    expect(content).toContain("已于 23:20 重置，点刷新确认");
    expect(content).toContain("剩 60%");
    expect(content).not.toContain("剩 0%");
    // Only the window still ahead waits for its time.
    const waiting = find(shown, (n) => n.props["data-reset-at"] !== undefined);
    expect(waiting.map((n) => n.props["data-reset-at"])).toEqual([String(now + 86_400)]);
  });

  it("never shows a refused token as refilled", () => {
    const { quotaCards } = cards();
    const content = text(
      quotaCards({
        windows: [{ kind: "primary", usedPercent: 100, resetsAt: now - 60 }],
        limited: { until: now + 600, claim: "seven_day_opus" },
        fetchedAt: now,
        source: "live",
      }),
    );
    expect(content).toContain("正在被限流");
    expect(content).not.toContain("已重置");
  });

  it("switches an open page's tile when its reset time comes", () => {
    const clock = { now: (now + 10) * 1000 };
    const live = load(clock);
    const make = (resetAt: number) => {
      const attributes = new Map([
        ["data-reset-at", String(resetAt)],
        ["data-reset-text", "已于 23:20 重置，点刷新确认"],
      ]);
      const amount = { textContent: "剩 0%" };
      const fill = { style: { width: "0%" } };
      const when = { textContent: "马上 · 23:20 重置" };
      const classes = new Set(["reset-card", "low"]);
      return {
        amount,
        fill,
        when,
        classes,
        attributes,
        getAttribute: (name: string) => attributes.get(name) ?? null,
        removeAttribute: (name: string) => attributes.delete(name),
        classList: { remove: (name: string) => classes.delete(name) },
        querySelector: (selector: string) =>
          selector === "b" ? amount : selector === ".bar i" ? fill : when,
      };
    };
    const due = make(now);
    const later = make(now + 3_600);
    const root = {
      querySelectorAll: (selector: string) =>
        selector.startsWith(".reset-card") ? [due, later] : [],
    };
    (live as unknown as { repaint(root: unknown): void }).repaint(root);
    expect(due.amount.textContent).toBe("已重置");
    expect(due.fill.style.width).toBe("100%");
    expect(due.when.textContent).toBe("已于 23:20 重置，点刷新确认");
    expect(due.classes.has("low")).toBe(false);
    expect(due.attributes.has("data-reset-at")).toBe(false);
    expect(later.amount.textContent).toBe("剩 0%");
  });
});
