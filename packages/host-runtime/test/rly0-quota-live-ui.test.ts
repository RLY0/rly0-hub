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
