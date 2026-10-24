import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonObjectSchema, codexAccountListResultSchema } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";
import { createOwnedLoopbackBackend } from "../src/codex-runtime/owned-official-backends.js";
import { prepareLocalCodex, type PreparedLocalCodex } from "../src/native-account-host.js";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";

vi.mock("../src/codex-runtime/owned-official-backends.js", () => ({
  createOwnedLoopbackBackend: vi.fn(),
}));

const prepared = new Set<PreparedLocalCodex>();
const temporaryDirectories = new Set<string>();
afterEach(async () => {
  for (const local of prepared) await local.close();
  prepared.clear();
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
  vi.clearAllMocks();
});

function nativeFixture(startReady?: Promise<void>) {
  const exit = Promise.withResolvers<OfficialAppServerExit>();
  const requests: JsonObject[] = [];
  const connections: Array<{ close(): void }> = [];
  let account: JsonObject | null = {
    type: "chatgpt",
    email: "current@example.com",
    planType: "pro",
  };
  const connect = vi.fn(async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const closed = Promise.withResolvers<OfficialAppServerExit>();
    let pending = "";
    let initialized = false;
    stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const request = jsonObjectSchema.parse(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
        requests.push(request);
        if (request.method === "initialized") continue;
        let result: JsonObject;
        if (request.method === "initialize") {
          initialized = true;
          result = { userAgent: "synthetic" };
        } else {
          if (!initialized) throw new Error("Unexpected or uninitialized native request");
          if (request.method === "account/read") {
            result = { account, requiresOpenaiAuth: true };
          } else if (request.method === "thread/start" || request.method === "thread/resume") {
            result = { thread: { id: "voice-thread" } };
          } else if (request.method === "thread/realtime/start") {
            result = {};
          } else {
            throw new Error("Unexpected native request");
          }
        }
        stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
    const close = vi.fn(() => {
      stdin.end();
      stdout.end();
      stderr.end();
      closed.resolve({ code: 0, signal: null });
    });
    connections.push({ close });
    return { stdin, stdout, stderr, closed: closed.promise, close };
  });
  const stop = vi.fn(async () => {
    for (const connection of connections) connection.close();
    exit.resolve({ code: 0, signal: null });
  });
  vi.mocked(createOwnedLoopbackBackend).mockReturnValue({
    closed: exit.promise,
    start: vi.fn(async () => {
      await startReady;
    }),
    connect,
    stop,
  });
  return {
    requests,
    connect,
    stop,
    crash: () => exit.resolve({ code: 1, signal: null }),
    signOut: () => {
      account = null;
    },
  };
}

const diagnostics = new WeakMap<PreparedLocalCodex, () => string>();

async function startLocal(officialStartGraceMs?: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-native-account-host-"));
  temporaryDirectories.add(directory);
  const diagnosticOutput = new PassThrough();
  let text = "";
  diagnosticOutput.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  const local = await prepareLocalCodex({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    environment: { CODEX_HOME: path.join(directory, "missing-codex-home") },
    diagnosticOutput,
    ...(officialStartGraceMs === undefined ? {} : { officialStartGraceMs }),
  });
  prepared.add(local);
  diagnostics.set(local, () => text);
  return local;
}

describe("local Codex read-only identity startup", () => {
  it("recovers the local backend so an existing client can explicitly retry voice startup", async () => {
    const first = nativeFixture();
    const local = await startLocal();
    await local.accountControl.refresh?.();
    const desktop = new OfficialRuntimeClient({
      scope: local.officialRuntimeScope,
      output: async () => {},
    });
    try {
      await desktop.initializeProtocol({
        clientInfo: { name: "codex_desktop", version: "synthetic" },
      });
      await desktop.request("thread/start", { cwd: "/synthetic" });
      const replacement = nativeFixture();
      first.crash();
      await vi.waitFor(() => expect(local.officialRuntimeScope.gate.phase).toBe("unavailable"));
      await expect(
        desktop.request("thread/realtime/start", { threadId: "voice-thread" }),
      ).rejects.toThrow("unavailable");
      await vi.waitFor(() => expect(local.officialRuntimeScope.gate.phase).toBe("ready"), {
        timeout: 3000,
      });
      expect(first.stop).toHaveBeenCalledOnce();
      expect(local.officialRuntimeScope.owner.generation).toBe(2);
      expect(
        replacement.requests.some((request) => request.method === "thread/realtime/start"),
      ).toBe(false);

      await expect(
        desktop.request("thread/realtime/start", { threadId: "voice-thread" }),
      ).resolves.toMatchObject({ result: {} });
      expect(replacement.requests.map((request) => request.method)).toEqual([
        "initialize",
        "initialized",
        "initialize",
        "initialized",
        "thread/resume",
        "thread/realtime/start",
      ]);
      expect(await local.accountControl.refresh?.()).toMatchObject({ phase: "ready" });
    } finally {
      await desktop.close();
    }
  });

  it("keeps launching when the official backend fails to start and recovers it in the background", async () => {
    const f = nativeFixture();
    f.connect.mockRejectedValueOnce(new Error("Synthetic connection failure"));
    const local = await startLocal();
    expect(local.officialRuntimeScope.gate.phase).toBe("unavailable");
    expect(local.officialRuntimeScope.closed).toBe(false);
    // The failed generation's exit is proven, not left to the next attempt.
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    expect(f.requests).toEqual([]);
    expect(diagnostics.get(local)?.()).toContain(
      "official Codex failed to start: Codex is unavailable: Synthetic connection failure; other Agents and relay models stay available and it is retried in the background",
    );
    const replacement = nativeFixture();
    await vi.waitFor(() => expect(local.officialRuntimeScope.gate.phase).toBe("ready"), {
      timeout: 3000,
    });
    expect(await local.accountControl.refresh?.()).toMatchObject({
      phase: "ready",
      currentAccountId: "current",
    });
    expect(replacement.requests.slice(0, 2).map((r) => r.method)).toEqual([
      "initialize",
      "initialized",
    ]);
  });

  it("continues past a slow official start and becomes ready when it finishes", async () => {
    const ready = Promise.withResolvers<undefined>();
    const f = nativeFixture(ready.promise);
    const local = await startLocal(20);
    expect(local.officialRuntimeScope.gate.phase).toBe("unavailable");
    expect(diagnostics.get(local)?.()).toContain(
      "official Codex is still starting after 20ms; other Agents and relay models stay available while it finishes in the background",
    );
    await expect(local.accountControl.refresh?.()).rejects.toThrow("unavailable");
    ready.resolve(undefined);
    await vi.waitFor(() => expect(local.officialRuntimeScope.gate.phase).toBe("ready"));
    expect(diagnostics.get(local)?.()).toMatch(/official Codex became ready after \d+ms/u);
    expect(await local.accountControl.refresh?.()).toMatchObject({ phase: "ready" });
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("initializes the native read connection before projecting the current identity", async () => {
    const f = nativeFixture();
    const local = await startLocal();
    const result = codexAccountListResultSchema.parse(await local.accountControl.refresh?.());
    expect(result).toMatchObject({
      phase: "ready",
      currentAccountId: "current",
      accounts: [{ accountId: "current", email: "current@example.com", planType: "pro" }],
    });
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.requests.slice(0, 2).map((r) => r.method)).toEqual(["initialize", "initialized"]);
    expect(
      f.requests
        .filter((r) => r.method === "account/read")
        .every((r) => JSON.stringify(r.params) === JSON.stringify({ refreshToken: false })),
    ).toBe(true);
    await local.close();
    expect(f.stop).toHaveBeenCalledOnce();
    await expect(local.accountControl.refresh?.()).rejects.toThrow("unavailable");
  });

  it("projects native sign-out without restoring a saved identity or starting login", async () => {
    const f = nativeFixture();
    const local = await startLocal();
    await local.accountControl.refresh?.();
    f.signOut();
    expect(await local.accountControl.refresh?.()).toMatchObject({
      currentAccountId: null,
      accounts: [],
      phase: "ready",
    });
    expect(
      f.requests.every((r) =>
        ["initialize", "initialized", "account/read"].includes(String(r.method)),
      ),
    ).toBe(true);
    expect(f.connect).toHaveBeenCalledOnce();
  });
});
