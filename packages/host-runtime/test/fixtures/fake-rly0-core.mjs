#!/usr/bin/env node
// Fake rly0-core used only by packages/host-runtime/test/rly0-core.test.ts. Speaks the same
// newline-delimited JSON-RPC 2.0 protocol as the real (closed-source) binary, just enough to
// exercise the host-side client: id correlation, a slow method for timeout coverage, and a
// business error shaped like the real core's ("code":-32000, short message).
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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
  if (method === "core/hello") {
    send({ jsonrpc: "2.0", id, result: { name: "rly0-core-fake", version: "0.0.0-test", capabilities: ["accounts"] } });
    return;
  }
  if (method === "accounts/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
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
          },
        ],
        liveLoggedIn: true,
        liveUnsaved: false,
      },
    });
    return;
  }
  if (method === "accounts/switch" && params && params.id === "000000000000") {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "CODEX_NOT_LOGGED_IN" } });
    return;
  }
  if (method === "accounts/switch") {
    send({ jsonrpc: "2.0", id, result: { switched: true, requiresRestart: true, alias: "work" } });
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
