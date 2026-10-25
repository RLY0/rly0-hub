import http from "node:http";
import type { AddressInfo } from "node:net";

import type { Rly0Relay } from "@codexhost/shared-contracts";

import { CLAUDE_CODE_RELAY_TOKEN } from "./agent-relays.js";
import type { OfficialKeyUsageSnapshot } from "./official-key-usage.js";

/**
 * Claude Code reads `ANTHROPIC_BASE_URL` once, when its process starts, and an open Thread keeps
 * that process. Pinning the URL to `/r/<relay id>` therefore kept every open Claude Thread on the
 * credential it started with: switching the subscription token in the Hub only reached Threads
 * opened afterwards (or after restarting Codex). Sessions get this forwarder's stable URL
 * instead; every request asks `resolve()` for the relay chosen now and goes to the local proxy
 * under that relay, so a switch applies from the next request on — including Claude Code's own
 * retries of a rejected (429) request.
 */
export interface ClaudeRelayTarget {
  /** The local proxy's base URL (with or without `/v1`). */
  readonly proxyBaseUrl: string;
  readonly relayId: string;
}

export interface ClaudeRelayForwarderOptions {
  /** The relay Claude Code should use now; null when it is back on its own login. */
  readonly resolve: () => Promise<ClaudeRelayTarget | null>;
  /** Plain-words lines appended to a quota rejection (429): the other saved credentials. */
  readonly describeAlternatives?: (currentRelayId: string) => Promise<string | null>;
}

const PREFIX = "/claude-code";
const MAX_REWRITTEN_ERROR_BYTES = 64 * 1024;

function anthropicError(status: number, type: string, message: string) {
  return {
    status,
    body: JSON.stringify({ type: "error", error: { type, message } }),
  };
}

/** The placeholder Claude Code sends; anything else on this port is not one of our sessions. */
function carriesPlaceholder(request: http.IncomingMessage): boolean {
  const bearer = request.headers.authorization;
  return (
    bearer === `Bearer ${CLAUDE_CODE_RELAY_TOKEN}` ||
    request.headers["x-api-key"] === CLAUDE_CODE_RELAY_TOKEN
  );
}

export class ClaudeRelayForwarder {
  readonly #options: ClaudeRelayForwarderOptions;
  #server: http.Server | null = null;
  #listening: Promise<string> | null = null;

  constructor(options: ClaudeRelayForwarderOptions) {
    this.#options = options;
  }

  /** The base URL Claude Code sessions use; starts listening on first use. */
  url(): Promise<string> {
    this.#listening ??= new Promise<string>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.#forward(request, response).catch(() => {
          if (!response.headersSent) {
            const failure = anthropicError(502, "api_error", "RLY/0 Hub 本地转发失败");
            response.writeHead(failure.status, { "content-type": "application/json" });
            response.end(failure.body);
          } else response.destroy();
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.unref();
        this.#server = server;
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}${PREFIX}`);
      });
    }).catch((error: unknown) => {
      this.#listening = null;
      throw error;
    });
    return this.#listening;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#listening = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #forward(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (failure: { status: number; body: string }) => {
      request.resume();
      response.writeHead(failure.status, { "content-type": "application/json" });
      response.end(failure.body);
    };
    const url = request.url ?? "";
    if (!(url === PREFIX || url.startsWith(`${PREFIX}/`)) || !carriesPlaceholder(request)) {
      reply(anthropicError(404, "not_found_error", "Not found"));
      return;
    }
    const target = await this.#options.resolve();
    if (!target) {
      reply(
        anthropicError(
          401,
          "authentication_error",
          "Claude Code 已在 RLY/0 Hub 改回自己的登录，这个已打开的对话还连着之前的令牌通道。请新开一个 Claude 对话（或重新打开 Codex）后继续。",
        ),
      );
      return;
    }
    const root = target.proxyBaseUrl.replace(/\/v1\/?$/u, "").replace(/\/+$/u, "");
    const upstreamUrl = new URL(`${root}/r/${target.relayId}${url.slice(PREFIX.length)}`);
    const headers = { ...request.headers, host: upstreamUrl.host };
    await new Promise<void>((resolve, reject) => {
      const upstream = http.request(
        upstreamUrl,
        { method: request.method ?? "GET", headers },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 502;
          if (status === 429 && this.#options.describeAlternatives) {
            void this.#rewriteQuotaRejection(upstreamResponse, response, target.relayId).then(
              resolve,
              reject,
            );
            return;
          }
          response.writeHead(status, upstreamResponse.headers);
          upstreamResponse.pipe(response);
          upstreamResponse.once("end", resolve);
          upstreamResponse.once("error", reject);
        },
      );
      upstream.once("error", reject);
      // A Claude Code request that is abandoned (cancelled turn) stops the upstream one too.
      response.once("close", () => {
        if (!response.writableFinished) upstream.destroy();
      });
      request.pipe(upstream);
    });
  }

  /** Adds the other saved credentials to a 429, so the Thread says what to switch to. */
  async #rewriteQuotaRejection(
    upstream: http.IncomingMessage,
    response: http.ServerResponse,
    relayId: string,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of upstream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size <= MAX_REWRITTEN_ERROR_BYTES) chunks.push(buffer);
    }
    const original = Buffer.concat(chunks);
    const headers = { ...upstream.headers };
    let body: Buffer = original;
    const encoding = headers["content-encoding"];
    const hint =
      size <= MAX_REWRITTEN_ERROR_BYTES && (!encoding || encoding === "identity")
        ? await this.#options.describeAlternatives?.(relayId).catch(() => null)
        : null;
    if (hint) {
      try {
        const parsed = JSON.parse(original.toString("utf8")) as {
          error?: { message?: unknown };
        };
        if (parsed?.error && typeof parsed.error === "object") {
          const message = typeof parsed.error.message === "string" ? parsed.error.message : "";
          parsed.error.message = `${message}${message ? "\n\n" : ""}${hint}`;
          body = Buffer.from(JSON.stringify(parsed), "utf8");
        }
      } catch {
        // Not JSON: passed through unchanged.
      }
    }
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    response.writeHead(429, { ...headers, "content-length": String(body.length) });
    response.end(body);
  }
}

function remainingText(snapshot: OfficialKeyUsageSnapshot | undefined): {
  text: string;
  least: number | null;
} {
  const windows = snapshot?.usage.windows ?? [];
  if (windows.length === 0) return { text: "额度未知", least: null };
  const parts = windows.map((window) => {
    const left = Math.max(0, Math.round(100 - window.usedPercent));
    return { left, label: `${window.kind === "primary" ? "5 小时" : "每周"}剩 ${left}%` };
  });
  const at = new Date((snapshot?.usage.fetchedAt ?? 0) * 1000);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return {
    text: `${parts.map((part) => part.label).join("、")}（${time} 查询）`,
    least: Math.min(...parts.map((part) => part.left)),
  };
}

/**
 * The text a quota rejection (429) carries in the Thread: the other saved Claude subscription
 * tokens and keys with their last known remaining quota (or 额度未知), most remaining first, and
 * how to switch. Switching takes effect for this open Thread on the next request.
 */
export function describeClaudeAlternatives(
  currentRelayId: string,
  relays: readonly Rly0Relay[],
  usageFor: (relay: Rly0Relay) => OfficialKeyUsageSnapshot | undefined,
  autoSwitchOn = false,
): string {
  const others = relays
    .filter((relay) => relay.id !== currentRelayId && relay.enabled && relay.hasKey)
    .map((relay) => ({
      name: relay.name.replace(/ ?官方 API Key$/u, "") || relay.id,
      ...remainingText(usageFor(relay)),
    }))
    .sort((a, b) => (b.least ?? -1) - (a.least ?? -1));
  const lines = ["RLY/0 Hub：这个账号的额度用完了（429）。"];
  if (others.length === 0) {
    lines.push("没有其他已保存的 Claude 账号或令牌；可在 RLY/0 Hub → 账号 添加。");
    return lines.join("\n");
  }
  lines.push(
    "换个账号重试：在 RLY/0 Hub → 账号 选下面任一个点“使用”，然后在这里重发即可，不用重启 Codex。",
  );
  for (const other of others.slice(0, 8)) lines.push(`· ${other.name}：${other.text}`);
  if (autoSwitchOn) lines.push("已开启自动切换：RLY/0 Hub 会按设置自动换到额度更多的账号。");
  return lines.join("\n");
}
