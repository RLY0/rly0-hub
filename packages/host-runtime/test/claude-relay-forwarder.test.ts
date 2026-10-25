import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { Rly0Relay } from "@codexhost/shared-contracts";

import {
  CLAUDE_CODE_RELAY_TOKEN,
  claudeCodeForwardedEnvironment,
} from "../src/rly0-relay/agent-relays.js";
import {
  ClaudeRelayForwarder,
  describeClaudeAlternatives,
  type ClaudeRelayTarget,
} from "../src/rly0-relay/claude-relay-forwarder.js";

interface Seen {
  readonly url: string;
  readonly body: string;
  readonly authorization: string | undefined;
}

/** Stands in for rly0-core's local proxy: answers per relay id, records what reached it. */
async function fakeProxy(
  answer: (relayId: string, response: http.ServerResponse) => void = (_id, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  },
) {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      seen.push({ url: request.url ?? "", body, authorization: request.headers.authorization });
      answer(/^\/r\/([^/]+)/u.exec(request.url ?? "")?.[1] ?? "", response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl, seen };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function forwarder(options: ConstructorParameters<typeof ClaudeRelayForwarder>[0]) {
  const instance = new ClaudeRelayForwarder(options);
  cleanups.push(() => instance.close());
  return instance;
}

async function post(url: string, body: string, token = CLAUDE_CODE_RELAY_TOKEN) {
  const response = await fetch(`${url}/v1/messages?beta=true`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
  return { status: response.status, text: await response.text() };
}

function relay(id: string, name: string): Rly0Relay {
  return {
    id,
    name,
    baseUrl: "https://api.anthropic.com",
    protocol: "responses",
    models: [],
    enabled: true,
    hasKey: true,
    keyRevision: "a".repeat(64),
  };
}

describe("Claude relay forwarder", () => {
  it("sends each request to the relay chosen at that moment", async () => {
    const proxy = await fakeProxy();
    let current: ClaudeRelayTarget | null = {
      proxyBaseUrl: proxy.baseUrl,
      relayId: "aaaaaaaaaaaa",
    };
    const instance = forwarder({ resolve: () => Promise.resolve(current) });
    // One Claude Code process keeps this URL for its whole life.
    const url = await instance.url();
    expect(claudeCodeForwardedEnvironment({ ANTHROPIC_API_KEY: "own" }, url)).toEqual({
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_AUTH_TOKEN: CLAUDE_CODE_RELAY_TOKEN,
    });

    expect(await post(url, '{"turn":1}')).toEqual({ status: 200, text: '{"ok":true}' });
    // The person switches the subscription token in the Hub mid-session.
    current = { proxyBaseUrl: proxy.baseUrl, relayId: "bbbbbbbbbbbb" };
    expect((await post(url, '{"turn":2}')).status).toBe(200);

    expect(proxy.seen).toEqual([
      {
        url: "/r/aaaaaaaaaaaa/v1/messages?beta=true",
        body: '{"turn":1}',
        authorization: `Bearer ${CLAUDE_CODE_RELAY_TOKEN}`,
      },
      {
        url: "/r/bbbbbbbbbbbb/v1/messages?beta=true",
        body: '{"turn":2}',
        authorization: `Bearer ${CLAUDE_CODE_RELAY_TOKEN}`,
      },
    ]);
  });

  it("streams responses through as they arrive", async () => {
    const proxy = await fakeProxy((_id, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: a\ndata: 1\n\n");
      setTimeout(() => response.end("event: b\ndata: 2\n\n"), 20);
    });
    const instance = forwarder({
      resolve: () => Promise.resolve({ proxyBaseUrl: proxy.baseUrl, relayId: "aaaaaaaaaaaa" }),
    });
    const result = await post(await instance.url(), "{}");
    expect(result).toEqual({ status: 200, text: "event: a\ndata: 1\n\nevent: b\ndata: 2\n\n" });
  });

  it("serves only Claude Code sessions carrying the local placeholder", async () => {
    const proxy = await fakeProxy();
    const instance = forwarder({
      resolve: () => Promise.resolve({ proxyBaseUrl: proxy.baseUrl, relayId: "aaaaaaaaaaaa" }),
    });
    expect((await post(await instance.url(), "{}", "someone-else")).status).toBe(404);
    expect(proxy.seen).toEqual([]);
  });

  it("says plainly when Claude Code went back to its own login", async () => {
    const instance = forwarder({ resolve: () => Promise.resolve(null) });
    const result = await post(await instance.url(), "{}");
    expect(result.status).toBe(401);
    expect(JSON.parse(result.text)).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    });
    expect(result.text).toContain("新开一个 Claude 对话");
  });

  it("adds the other saved accounts to a quota rejection, and a retry after switching succeeds", async () => {
    const proxy = await fakeProxy((relayId, response) => {
      if (relayId === "aaaaaaaaaaaa") {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
        response.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    let current = { proxyBaseUrl: proxy.baseUrl, relayId: "aaaaaaaaaaaa" };
    const asked: string[] = [];
    const instance = forwarder({
      resolve: () => Promise.resolve(current),
      describeAlternatives: (id) => {
        asked.push(id);
        return Promise.resolve("换个账号重试：备用（5 小时剩 80%）");
      },
    });
    const url = await instance.url();

    const rejected = await post(url, "{}");
    expect(rejected.status).toBe(429);
    expect(JSON.parse(rejected.text)).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "limit\n\n换个账号重试：备用（5 小时剩 80%）" },
    });
    expect(asked).toEqual(["aaaaaaaaaaaa"]);

    current = { proxyBaseUrl: proxy.baseUrl, relayId: "bbbbbbbbbbbb" };
    expect(await post(url, "{}")).toEqual({ status: 200, text: '{"ok":true}' });
  });
});

describe("describeClaudeAlternatives", () => {
  it("lists the other saved credentials, most remaining first, and is honest about unknowns", () => {
    const fetchedAt = Math.floor(new Date(2026, 9, 25, 9, 5).getTime() / 1000);
    const text = describeClaudeAlternatives(
      "aaaaaaaaaaaa",
      [
        relay("aaaaaaaaaaaa", "在用 官方 API Key"),
        relay("bbbbbbbbbbbb", "低"),
        relay("cccccccccccc", "未知"),
        relay("dddddddddddd", "高"),
        { ...relay("eeeeeeeeeeee", "停用"), enabled: false },
      ],
      (entry) => {
        const used = entry.id === "bbbbbbbbbbbb" ? 90 : entry.id === "dddddddddddd" ? 20 : null;
        return used === null
          ? undefined
          : {
              id: entry.id,
              revision: "a".repeat(64),
              usage: {
                windows: [
                  { kind: "primary", usedPercent: used },
                  { kind: "secondary", usedPercent: 10 },
                ],
                fetchedAt,
                source: "snapshot",
              },
            };
      },
    );
    expect(text.split("\n")).toEqual([
      "RLY/0 Hub：这个账号的额度用完了（429）。",
      "换个账号重试：在 RLY/0 Hub → 账号 选下面任一个点“使用”，然后在这里重发即可，不用重启 Codex。",
      "· 高：5 小时剩 80%、每周剩 90%（09:05 查询）",
      "· 低：5 小时剩 10%、每周剩 90%（09:05 查询）",
      "· 未知：额度未知",
    ]);
  });

  it("says when there is nothing to switch to", () => {
    expect(
      describeClaudeAlternatives("aaaaaaaaaaaa", [relay("aaaaaaaaaaaa", "唯一")], () => undefined),
    ).toContain("没有其他已保存的 Claude 账号或令牌");
  });
});
