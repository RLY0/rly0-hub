// Synthetic headers, notifications and files only: no credential, network or real Hub data.
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Rly0Account, Rly0Relay } from "@codexhost/shared-contracts";

import { CLAUDE_CODE_RELAY_TOKEN } from "../src/rly0-relay/agent-relays.js";
import { ClaudeOfficialKeyQuota } from "../src/rly0-relay/claude-key-quota.js";
import { ClaudeRelayForwarder } from "../src/rly0-relay/claude-relay-forwarder.js";
import {
  codexUsageFromPlan,
  parseAnthropicRateLimitHeaders,
  parseLiveQuotaDocument,
  Rly0LiveQuotaFeed,
  type LiveQuotaDocument,
} from "../src/rly0-relay/live-quota-feed.js";
import { matchCodexAccount, Rly0HubLiveQuota } from "../src/rly0-hub-service/live-quota.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Anthropic unified rate-limit headers", () => {
  it("reads the 5-hour and 7-day windows with their resets", () => {
    expect(
      parseAnthropicRateLimitHeaders(
        {
          "anthropic-ratelimit-unified-5h-utilization": "0.42",
          "anthropic-ratelimit-unified-5h-reset": "1792000000",
          "anthropic-ratelimit-unified-7d-utilization": "0.1",
          "anthropic-ratelimit-unified-status": "allowed",
        },
        1_791_990_000,
      ),
    ).toEqual({
      windows: [
        { kind: "primary", usedPercent: 42, windowSeconds: 18_000, resetsAt: 1_792_000_000 },
        { kind: "secondary", usedPercent: 10, windowSeconds: 604_800 },
      ],
      fetchedAt: 1_791_990_000,
      source: "live",
    });
  });

  it("ignores responses without the limiter's numbers and malformed values", () => {
    expect(parseAnthropicRateLimitHeaders({ "content-type": "application/json" })).toBeNull();
    expect(
      parseAnthropicRateLimitHeaders({
        "anthropic-ratelimit-unified-5h-utilization": "abc",
        "anthropic-ratelimit-unified-7d-utilization": "-1",
      }),
    ).toBeNull();
    const capped = parseAnthropicRateLimitHeaders({
      "anthropic-ratelimit-unified-5h-utilization": ["1.7"],
      "anthropic-ratelimit-unified-5h-reset": "not-a-time",
    });
    expect(capped?.windows).toEqual([{ kind: "primary", usedPercent: 100, windowSeconds: 18_000 }]);
  });
});

describe("Codex rate-limit notifications", () => {
  it("map the plan rows to the Hub's windows", () => {
    expect(
      codexUsageFromPlan(
        {
          planFiveHourUsedPercent: 30,
          planFiveHourResetsAtUnix: 1_800_000_000,
          planSevenDayUsedPercent: 5,
        },
        100,
      ),
    ).toEqual({
      windows: [
        { kind: "primary", usedPercent: 30, windowSeconds: 18_000, resetsAt: 1_800_000_000 },
        { kind: "secondary", usedPercent: 5, windowSeconds: 604_800 },
      ],
      fetchedAt: 100,
      source: "live",
    });
    expect(codexUsageFromPlan({ inputTokens: 5 })).toBeNull();
  });
});

function memoryFile() {
  let document: LiveQuotaDocument = { version: 1, entries: [] };
  const writes: LiveQuotaDocument[] = [];
  return {
    writes,
    get document() {
      return document;
    },
    read: async () => document,
    write: async (_file: string, value: LiveQuotaDocument) => {
      document = JSON.parse(JSON.stringify(value)) as LiveQuotaDocument;
      writes.push(document);
    },
  };
}

const usage = (used: number, fetchedAt = 1) => ({
  windows: [{ kind: "primary" as const, usedPercent: used, windowSeconds: 18_000 }],
  fetchedAt,
  source: "live" as const,
});

describe("live quota feed writer", () => {
  it("coalesces a streaming turn into one write and keeps the newest numbers per key", async () => {
    vi.useFakeTimers();
    const file = memoryFile();
    let now = 1_000;
    const feed = new Rly0LiveQuotaFeed({
      file: "live.json",
      now: () => now,
      read: file.read,
      write: file.write,
    });
    feed.record({ provider: "claude", key: "aaaaaaaaaaaa", usage: usage(10) });
    now += 10;
    feed.record({ provider: "claude", key: "aaaaaaaaaaaa", usage: usage(12) });
    feed.record({ provider: "codex", key: "current", email: "a@example.test", usage: usage(40) });
    feed.relayTurnFinished();
    await vi.runAllTimersAsync();
    await feed.flush();
    expect(file.writes).toHaveLength(1);
    expect(file.document.entries.map((e) => [e.provider, e.usage.windows[0]?.usedPercent])).toEqual(
      expect.arrayContaining([
        ["claude", 12],
        ["codex", 40],
      ]),
    );
    expect(file.document.relayTurnAt).toBe(1_010);
  });

  it("drops entries with an unsafe key or no windows", async () => {
    const file = memoryFile();
    const feed = new Rly0LiveQuotaFeed({ file: "x", read: file.read, write: file.write });
    feed.record({ provider: "claude", key: "../evil", usage: usage(1) });
    feed.record({ provider: "codex", key: "ok", usage: { ...usage(1), windows: [] } });
    await feed.flush();
    expect(file.writes).toHaveLength(0);
    expect(parseLiveQuotaDocument("not json")).toEqual({ version: 1, entries: [] });
    expect(
      parseLiveQuotaDocument(
        JSON.stringify({ version: 1, entries: [{ provider: "x", key: "a", usage: usage(1) }] }),
      ).entries,
    ).toEqual([]);
  });
});

describe("Claude forwarder headers", () => {
  it("hands every upstream response's headers to the observer without changing the reply", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
      });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const proxyBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const seen: { relayId: string; used: number | undefined }[] = [];
    const forwarder = new ClaudeRelayForwarder({
      resolve: async () => ({ proxyBaseUrl, relayId: "0123456789ab" }),
      observeResponse: (relayId, headers) =>
        seen.push({
          relayId,
          used: parseAnthropicRateLimitHeaders(headers)?.windows[0]?.usedPercent,
        }),
    });
    cleanups.push(() => forwarder.close());
    const url = await forwarder.url();
    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLAUDE_CODE_RELAY_TOKEN}` },
      body: "{}",
    });
    expect(await response.text()).toBe('{"ok":true}');
    expect(seen).toEqual([{ relayId: "0123456789ab", used: 25 }]);
  });

  it("an observed reply is what passive inspections show; they never probe", async () => {
    let now = 1_000_000;
    const read = vi.fn(async () => ({ kind: "subscription", usage: usage(1, 900) }));
    const quota = new ClaudeOfficialKeyQuota(read, { now: () => now });
    quota.observe("0123456789ab", usage(33, 1000));
    const first = await quota.inspect({ relayId: "0123456789ab", keyMask: "m" }, false);
    expect(first.snapshot?.credits.usedPercent).toBe(33);
    now += 4 * 60_000;
    await quota.inspect({ relayId: "0123456789ab", keyMask: "m" }, false);
    expect(read).not.toHaveBeenCalled();
    now += 24 * 3600_000;
    await quota.inspect({ relayId: "0123456789ab", keyMask: "m" }, false);
    expect(read).not.toHaveBeenCalled();
  });
});

const account = (over: Partial<Rly0Account>): Rly0Account => ({
  id: "aaaaaaaaaaaa",
  current: false,
  ...over,
});

describe("Hub live quota ingestion", () => {
  it("matches the Codex account by official id, then email, then the current login", () => {
    const accounts = [
      account({ id: "111111111111", email: "One@example.test", accountId: "acct-1" }),
      account({ id: "222222222222", email: "two@example.test", current: true }),
    ];
    expect(matchCodexAccount(accounts, { key: "acct-1" })?.id).toBe("111111111111");
    expect(matchCodexAccount(accounts, { key: "x", email: "one@example.test" })?.id).toBe(
      "111111111111",
    );
    expect(matchCodexAccount(accounts, { key: "current" })?.id).toBe("222222222222");
    expect(matchCodexAccount(accounts, { key: "unknown" })).toBeNull();
  });

  function hub(document: { value: LiveQuotaDocument; mtime: number }) {
    const events: [string, Record<string, unknown>][] = [];
    const recorded: string[] = [];
    let now = 100_000;
    const balance = vi.fn(async () => ({ configured: true, balance: 3 }));
    const live = new Rly0HubLiveQuota({
      file: "live.json",
      listAccounts: async () => [account({ id: "222222222222", current: true })],
      listRelays: async () => [
        {
          id: "0123456789ab",
          name: "Claude 订阅令牌",
          baseUrl: "https://api.anthropic.com",
          enabled: true,
          hasKey: true,
          keyRevision: "f".repeat(64),
        } as unknown as Rly0Relay,
      ],
      recordToken: async (relay) => {
        recorded.push(relay.id);
        return true;
      },
      emit: (event, params) => events.push([event, params]),
      readBalance: balance,
      balanceDebounceMs: 30_000,
      now: () => now,
      read: async () => document.value,
      mtime: async () => document.mtime,
    });
    return {
      live,
      events,
      recorded,
      balance,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("pushes only observations newer than what it already saw, and skips unchanged files", async () => {
    const document: { mtime: number; value: LiveQuotaDocument } = {
      mtime: 1,
      value: {
        version: 1 as const,
        entries: [{ provider: "codex" as const, key: "current", usage: usage(5), observedAt: 10 }],
      },
    };
    const { live, events, recorded } = hub(document);
    await live.check();
    // The first read only learns the state: nothing old is announced.
    expect(events).toEqual([]);
    document.mtime = 2;
    document.value = {
      version: 1,
      entries: [
        { provider: "codex", key: "current", usage: usage(5), observedAt: 10 },
        { provider: "claude", key: "0123456789ab", usage: usage(60), observedAt: 20 },
      ],
    };
    await live.check();
    await live.check();
    expect(events.map(([name, params]) => [name, params.provider, params.id])).toEqual([
      ["quota", "claude", "0123456789ab"],
    ]);
    expect(recorded).toEqual(["0123456789ab"]);
    expect(live.snapshot().map((u) => u.id)).toEqual(["222222222222", "0123456789ab"]);
  });

  it("re-reads the balance after a relay turn, at most once per debounce window", async () => {
    vi.useFakeTimers();
    const document: { mtime: number; value: LiveQuotaDocument } = {
      mtime: 1,
      value: { version: 1, entries: [] },
    };
    const { live, events, balance, advance } = hub(document);
    await live.check();
    document.mtime = 2;
    document.value = { version: 1, entries: [], relayTurnAt: 5 } as LiveQuotaDocument;
    await live.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(balance).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.[0]).toBe("balance");
    advance(1_000);
    document.mtime = 3;
    document.value = { version: 1, entries: [], relayTurnAt: 6 } as LiveQuotaDocument;
    await live.check();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(balance).toHaveBeenCalledTimes(1);
    advance(29_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(balance).toHaveBeenCalledTimes(2);
  });
});
