// Synthetic DOM and RPC only. Does not load credentials, a browser profile, or the live service.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
  children: Element[] = [];
  textContent = "";
  disabled = false;
  onclick?: () => Promise<void>;
  constructor(
    readonly tag: string,
    readonly props: Record<string, unknown> | null,
    children: unknown[],
  ) {
    Object.assign(this, props);
    this.children = children.flat().filter((x): x is Element => x instanceof Element);
    this.textContent = children.filter((x) => typeof x === "string").join("");
  }
  append(...items: Element[]) {
    this.children.push(...items);
  }
}
const source = readFileSync(
  new URL("../../../apps/hub-desktop/www/pages/reset-credits.js", import.meta.url),
  "utf8",
);
const account = { id: "0123456789ab", email: "synthetic@example.test", plan: "plus" };
function item<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing synthetic item ${index}`);
  return value;
}
function fixture(outcomes: (string | Error | Promise<string>)[] = ["reset"]) {
  const stored = new Map<string, string>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const dialogs: { body: Element; foot: Element; close: () => void }[] = [];
  const messages: string[] = [];
  let refreshes = 0;
  const h = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) =>
    new Element(tag, props, children);
  const window = {
    registerHubResetCredits: undefined as unknown as (api: unknown) => {
      tile: (
        count: number | undefined,
        options: unknown,
      ) => {
        onUse: () => Promise<void>;
        reason: string;
        action?: string;
        disabledReason?: string;
      };
    },
    HubUI: {
      dialog: (o: { onClose: () => void }) => {
        const d = { body: h("body", null), foot: h("foot", null), close: o.onClose };
        dialogs.push(d);
        return d;
      },
    },
  };
  runInNewContext(source, {
    window,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
  });
  const api = window.registerHubResetCredits({
    h,
    toast: (s: string) => messages.push(s),
    resetCardTile: (_count: unknown, options: unknown) => options,
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params: structuredClone(params) });
      if (method === "accounts.resetPrepare") {
        const pending = stored.get(account.id);
        if (pending === "broken") throw new Error("RESET_STATE_UNAVAILABLE");
        return {
          availableCount: 1,
          creditId: "synthetic-card",
          revision: "a".repeat(64),
          expiresAt: null,
          pendingRequestId: pending ? JSON.parse(pending).requestId : null,
        };
      }
      if (method === "accounts.resetConsume") {
        stored.set(account.id, JSON.stringify(params));
        const value = await outcomes.shift();
        if (value instanceof Error) throw value;
        return { outcome: value };
      }
      if (method === "accounts.resetAcknowledge") stored.delete(account.id);
      return { ok: true };
    },
  });
  const tile = () =>
    api.tile(1, {
      vendor: "openai",
      account,
      refreshed: async () => {
        refreshes++;
      },
    });
  return {
    api,
    tile,
    calls,
    dialogs,
    stored,
    messages,
    get refreshes() {
      return refreshes;
    },
  };
}
describe("reset-credit interactions (synthetic)", () => {
  it("opening and cancelling never consumes a card", async () => {
    const f = fixture();
    await f.tile().onUse();
    item(f.dialogs, 0).close();
    expect(f.calls.map((c) => c.method)).toEqual(["accounts.resetPrepare"]);
    expect(f.stored.size).toBe(0);
  });
  it("keeps the same card and request across an uncertain result and reopened dialog", async () => {
    const f = fixture([new Error("RESET_RESULT_UNKNOWN"), "alreadyRedeemed"]);
    await f.tile().onUse();
    await item(item(f.dialogs, 0).foot.children, 1).onclick?.();
    expect(f.stored.size).toBe(1);
    expect(f.refreshes).toBe(0);
    item(f.dialogs, 0).close();
    await f.tile().onUse();
    await item(item(f.dialogs, 1).foot.children, 1).onclick?.();
    const mutations = f.calls.filter((c) => c.method === "accounts.resetConsume");
    expect(mutations).toHaveLength(2);
    expect(item(mutations, 0).params).toEqual(item(mutations, 1).params);
    expect(f.calls.filter((c) => c.method === "accounts.resetPrepare")).toHaveLength(2);
    expect(f.stored.size).toBe(0);
    expect(f.refreshes).toBe(1);
    expect(item(item(f.dialogs, 1).foot.children, 1).disabled).toBe(true);
  });
  it("does not consume again after success and distinguishes noCredit/nothingToReset", async () => {
    for (const outcome of ["reset", "nothingToReset", "noCredit"]) {
      const f = fixture([outcome]);
      await f.tile().onUse();
      const b = item(item(f.dialogs, 0).foot.children, 1);
      await b.onclick?.();
      await b.onclick?.();
      expect(f.calls.filter((c) => c.method === "accounts.resetConsume")).toHaveLength(1);
      expect(f.stored.size).toBe(0);
    }
  });
  it("closing an in-flight confirmation does not unlock a second operation", async () => {
    const gate = Promise.withResolvers<string>();
    const f = fixture([gate.promise]);
    await f.tile().onUse();
    const dialog = item(f.dialogs, 0);
    const pending = item(dialog.foot.children, 1).onclick?.();
    dialog.close();
    await f.tile().onUse();
    expect(f.dialogs).toHaveLength(1);
    gate.resolve("reset");
    await pending;
    await f.tile().onUse();
    expect(f.dialogs).toHaveLength(2);
  });
  it("exposes Claude's fixed official page, and no fake consume action for other vendors", async () => {
    const f = fixture();
    await f.api.tile(undefined, { vendor: "anthropic" }).onUse();
    expect(f.calls).toEqual([{ method: "links.open", params: { target: "claudeUsage" } }]);
    for (const vendor of ["google", "xai", "api-key"]) {
      expect(f.api.tile(undefined, { vendor }).onUse).toBeUndefined();
    }
  });
  it("does not send a POST when the backend journal is unavailable", async () => {
    const f = fixture();
    f.stored.set(account.id, "broken");
    await f.tile().onUse();
    expect(f.calls.map((c) => c.method)).toEqual(["accounts.resetPrepare"]);
    expect(f.dialogs).toEqual([]);
  });
  it("offers 使用 only when a card exists; 0 is disabled with the reason", async () => {
    const f = fixture();
    const none = f.api.tile(0, { vendor: "openai", account });
    expect(none.onUse).toBeUndefined();
    expect(none.disabledReason).toBe("没有可用的重置卡");
    expect(f.tile().action).toBe("使用");
    const unknown = f.api.tile(undefined, { vendor: "openai", account });
    expect(unknown.action).toBe("核实");
    expect(f.calls).toEqual([]);
  });
  it("states account, the one card it consumes and the windows before anything is used", async () => {
    const f = fixture();
    const withUsage = {
      ...account,
      lastUsage: {
        windows: [
          { kind: "primary", usedPercent: 88 },
          { kind: "secondary", usedPercent: 40 },
        ],
      },
    };
    await f.api.tile(1, { vendor: "openai", account: withUsage }).onUse();
    const text = (e: Element): string => e.textContent + e.children.map(text).join(" ");
    const body = text(item(f.dialogs, 0).body);
    expect(body).toContain("synthetic@example.test");
    expect(body).toContain("1 张额度重置卡（现有 1 张，用后剩 0 张）");
    expect(body).toContain("5 小时额度（现在剩 12%）、每周额度（现在剩 60%）");
    expect(body).toContain("不会消耗");
    expect(f.calls.map((c) => c.method)).toEqual(["accounts.resetPrepare"]);
  });
});
