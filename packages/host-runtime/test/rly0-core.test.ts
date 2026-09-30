import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Rly0CoreClient, resolveRly0CoreBinaryPath } from "../src/rly0-core/client.js";
import { Rly0CoreBridge, rly0CoreRpcError } from "../src/rly0-core/index.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-rly0-core.mjs",
);

/** Spawns the Node fixture instead of a real binary, ignoring the (fake) binary path argument. */
const spawnFake = ((_binary: string, _args: string[], options: Parameters<typeof spawn>[2]) =>
  spawn(process.execPath, [fixture], options)) as unknown as typeof spawn;

describe("Rly0CoreClient", () => {
  it("resolves unavailable when no binary can be found", async () => {
    const client = new Rly0CoreClient({ binaryPath: null });
    const result = await client.request("core/hello", {});
    expect(result).toEqual({ available: false });
    await client.dispose();
  });

  it("spawns the fake core and correlates a response by id", async () => {
    const client = new Rly0CoreClient({ binaryPath: "fake", spawn: spawnFake });
    const result = await client.request<{ name: string }>("core/hello", {});
    expect(result).toEqual({
      available: true,
      result: { name: "rly0-core-fake", version: "0.0.0-test", capabilities: ["accounts"] },
    });
    await client.dispose();
  });

  it("correlates several concurrent requests to their own responses", async () => {
    const client = new Rly0CoreClient({ binaryPath: "fake", spawn: spawnFake });
    const [hello, accounts] = await Promise.all([
      client.request<{ name: string }>("core/hello", {}),
      client.request<{ accounts: unknown[] }>("accounts/list", {}),
    ]);
    expect(hello.available && hello.result.name).toBe("rly0-core-fake");
    expect(accounts.available && accounts.result.accounts).toHaveLength(1);
    await client.dispose();
  });

  it("rejects with a business error code from the core", async () => {
    const client = new Rly0CoreClient({ binaryPath: "fake", spawn: spawnFake });
    await expect(client.request("accounts/switch", { id: "000000000000" })).rejects.toMatchObject({
      message: "CODEX_NOT_LOGGED_IN",
      code: -32000,
    });
    await client.dispose();
  });

  it("times out a request the core never answers", async () => {
    const client = new Rly0CoreClient({ binaryPath: "fake", spawn: spawnFake, timeoutMs: 50 });
    await expect(client.request("slow/echo", {})).rejects.toThrow("RLY0_CORE_TIMEOUT");
    await client.dispose();
  }, 10_000);

  it("restarts on crash: the next request respawns the core", async () => {
    const client = new Rly0CoreClient({ binaryPath: "fake", spawn: spawnFake });
    const first = await client.request<{ name: string }>("core/hello", {});
    expect(first.available).toBe(true);
    await expect(client.request("core/crash", {})).rejects.toThrow("RLY0_CORE_EXITED");
    const second = await client.request<{ name: string }>("core/hello", {});
    expect(second.available).toBe(true);
    await client.dispose();
  });
});

describe("resolveRly0CoreBinaryPath", () => {
  it("prefers RLY0_CORE_PATH when the file exists", () => {
    const found = resolveRly0CoreBinaryPath({ RLY0_CORE_PATH: fixture });
    expect(found).toBe(fixture);
  });

  it("returns null when RLY0_CORE_PATH does not exist and no fallback binary is present", () => {
    const found = resolveRly0CoreBinaryPath({
      RLY0_CORE_PATH: path.join(fixture, "does-not-exist"),
    });
    expect(found).toBeNull();
  });
});

describe("Rly0CoreBridge", () => {
  it("reports unavailable results end-to-end when no binary is configured", async () => {
    const bridge = new Rly0CoreBridge({ binaryPath: null });
    await expect(bridge.status()).resolves.toEqual({ available: false });
    await expect(bridge.listAccounts()).resolves.toEqual({ available: false, accounts: [] });
    await expect(bridge.switchAccount({ id: "abcdef012345" })).resolves.toEqual({
      available: false,
      switched: false,
    });
    await bridge.dispose();
  });

  it("shapes a live accounts/list response", async () => {
    const bridge = new Rly0CoreBridge({ binaryPath: "fake", spawn: spawnFake });
    const result = await bridge.listAccounts();
    expect(result).toEqual({
      available: true,
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
          lastUsage: {
            windows: [
              { kind: "primary", usedPercent: 95, windowSeconds: 18000, resetsAt: 1790000000 },
              { kind: "secondary", usedPercent: 40, windowSeconds: 604800, resetsAt: 1790500000 },
            ],
            plan: "pro",
            fetchedAt: 1789990000,
            source: "snapshot",
          },
        },
      ],
      liveLoggedIn: true,
      liveUnsaved: false,
    });
    await bridge.dispose();
  });
});

describe("rly0CoreRpcError", () => {
  it("forwards a business error code and message as-is", () => {
    const error = Object.assign(new Error("CODEX_NOT_LOGGED_IN"), { code: -32000 });
    expect(rly0CoreRpcError(error)).toEqual({ code: -32000, message: "CODEX_NOT_LOGGED_IN" });
  });

  it("maps a timeout to a generic code without leaking internals", () => {
    expect(rly0CoreRpcError(new Error("RLY0_CORE_TIMEOUT"))).toEqual({
      code: -32000,
      message: "RLY0_CORE_TIMEOUT",
    });
  });

  it("falls back to a generic error for unrecognized failures", () => {
    expect(rly0CoreRpcError(new Error("boom"))).toEqual({
      code: -32000,
      message: "RLY0_CORE_ERROR",
    });
  });
});
