#!/usr/bin/env node
// Fake rly0-core used only by packages/host-runtime tests. Speaks the same newline-delimited
// JSON-RPC 2.0 protocol as the real (closed-source) binary, just enough to exercise the host-side
// client and bridge: id correlation, a slow method for timeout coverage, business errors shaped
// like the real core's ("code":-32000, short message), usage lookups, relays and the local proxy.
// It never touches the network or the file system; all state is in memory.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

const USAGE = {
  windows: [
    { kind: "primary", usedPercent: 95, windowSeconds: 18000, resetsAt: 1790000000 },
    { kind: "secondary", usedPercent: 40, windowSeconds: 604800, resetsAt: 1790500000 },
  ],
  plan: "pro",
  fetchedAt: 1789990000,
  source: "live",
};

const relays = new Map();
let relaySeq = 0;
let proxy = null;

function publicRelay(relay) {
  // Deliberately leaks `apiKey` and an unknown field: the host bridge must strip both.
  return { ...relay, apiKey: relay.secret, internalNote: "x", secret: undefined };
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = request;
  const ok = (result) => send({ jsonrpc: "2.0", id, result });
  if (method === "core/hello") {
    ok({ name: "rly0-core-fake", version: "0.0.0-test", capabilities: ["accounts"] });
    return;
  }
  if (method === "debug/env") {
    ok({
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      https_proxy: process.env.https_proxy ?? null,
      ALL_PROXY: process.env.ALL_PROXY ?? null,
      pid: process.pid,
    });
    return;
  }
  if (method === "accounts/list") {
    ok({
      accounts: [
        {
          id: "abcdef012345",
          alias: "work",
          email: "work@example.com",
          plan: "pro",
          accountId: "acct-1",
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          current: true,
          lastUsage: { ...USAGE, source: "snapshot" },
          accessToken: "must-not-leak",
        },
      ],
      liveLoggedIn: true,
      liveUnsaved: false,
    });
    return;
  }
  if (method === "accounts/switch" && params && params.id === "000000000000") {
    fail(id, "CODEX_NOT_LOGGED_IN");
    return;
  }
  if (method === "accounts/switch") {
    ok({ switched: true, requiresRestart: true, alias: "work" });
    return;
  }
  if (method === "accounts/usage") {
    if (params && params.id === "0123456789ab") return fail(id, "USAGE_TOKEN_EXPIRED");
    if (params && params.id === "ffffffffffff") return fail(id, "free text with token sk-123");
    ok(USAGE);
    return;
  }
  if (method === "accounts/usageAll") {
    ok({
      results: [
        { id: "abcdef012345", usage: USAGE },
        { id: "0123456789ab", error: "USAGE_BLOCKED" },
        { id: "bad-id", usage: USAGE },
        { id: "aaaaaaaaaaaa", error: "not a code" },
      ],
    });
    return;
  }
  if (method === "relay/list") {
    ok({ relays: [...relays.values()].map(publicRelay) });
    return;
  }
  if (method === "relay/add") {
    if (!params || typeof params.name !== "string") return fail(id, "RELAY_NAME_REJECTED");
    relaySeq += 1;
    const relay = {
      id: `r${relaySeq}`,
      name: params.name,
      baseUrl: params.baseUrl,
      protocol: "responses",
      models: params.models ?? [],
      enabled: params.enabled ?? true,
      addedAt: 1789000000,
      updatedAt: 1789000000,
      hasKey: typeof params.apiKey === "string",
      keyMask:
        typeof params.apiKey === "string"
          ? `${params.apiKey.slice(0, 3)}…${params.apiKey.slice(-2)}`
          : undefined,
      secret: params.apiKey,
    };
    relays.set(relay.id, relay);
    ok({ id: relay.id, relay: publicRelay(relay) });
    return;
  }
  if (method === "relay/update" || method === "relay/setEnabled") {
    const relay = params && relays.get(params.id);
    if (!relay) return fail(id, "NOT_FOUND");
    for (const key of ["name", "baseUrl", "models", "enabled"]) {
      if (params[key] !== undefined) relay[key] = params[key];
    }
    if (typeof params.apiKey === "string") {
      relay.secret = params.apiKey;
      relay.hasKey = true;
      relay.keyMask = `${params.apiKey.slice(0, 3)}…${params.apiKey.slice(-2)}`;
    }
    if (params.clearKey) {
      relay.secret = undefined;
      relay.hasKey = false;
      relay.keyMask = undefined;
    }
    relay.updatedAt += 1;
    ok({ relay: publicRelay(relay) });
    return;
  }
  if (method === "relay/remove") {
    if (!params || !relays.delete(params.id)) return fail(id, "NOT_FOUND");
    ok({ ok: true });
    return;
  }
  if (method === "relay/test") {
    const relay = params && relays.get(params.id);
    if (!relay) return fail(id, "NOT_FOUND");
    ok({ ok: true, latencyMs: 42, status: 200, modelCount: 2, models: ["gpt-5", "gpt-5-mini"] });
    return;
  }
  if (method === "proxy/start") {
    const port = (params && params.port) || 25917;
    if (port === 1) return fail(id, "PROXY_PORT_IN_USE");
    const alreadyRunning = proxy !== null;
    proxy ??= {
      running: true,
      port,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      startedAt: 1789000000,
      requests: 2,
      routed: 1,
      unrouted: 1,
      failed: 0,
      recent: [
        {
          at: 1789000001,
          method: "POST",
          path: "/v1/responses",
          model: "gpt-5",
          relay: "A",
          relayId: "r1",
          status: 200,
          ms: 12,
        },
        {
          at: 1789000002,
          method: "POST",
          path: "/v1/responses",
          model: "x",
          status: 404,
          ms: 1,
          authorization: "Bearer sk-leak",
        },
      ],
    };
    ok({ ...proxy, ...(alreadyRunning ? { alreadyRunning: true } : {}) });
    return;
  }
  if (method === "proxy/stop") {
    const stopped = proxy !== null;
    proxy = null;
    ok({ stopped });
    return;
  }
  if (method === "proxy/status") {
    ok(proxy ?? { running: false, defaultPort: 25917 });
    return;
  }
  if (method === "slow/echo") {
    // Deliberately never responds; used to exercise the client's per-request timeout.
    return;
  }
  if (method === "core/crash") {
    // Exits without responding; used to exercise the client's respawn-on-crash behavior.
    process.exit(1);
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "METHOD_NOT_FOUND" } });
});
