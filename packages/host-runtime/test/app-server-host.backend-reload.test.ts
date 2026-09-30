import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { RLY0_CODEX_RELOAD_BACKEND_METHOD } from "@codexhost/shared-contracts";

import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import type { OwnedOfficialBackend } from "../src/codex-runtime/official-runtime-owner.js";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";
import { createFixture, writeRequest } from "./app-server-host-fixture.js";

function nativeBackends() {
  const backends: { requests: JsonObject[]; stdout: PassThrough }[] = [];
  const createBackend = vi.fn((): OwnedOfficialBackend => {
    const exit = Promise.withResolvers<OfficialAppServerExit>();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const requests: JsonObject[] = [];
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)) as JsonObject;
        buffer = buffer.slice(newline + 1);
        requests.push(request);
        if (!("id" in request)) continue;
        writeRequest(stdout, {
          id: request.id ?? null,
          result:
            request.method === "initialize" ? { userAgent: "synthetic-native" } : { data: [] },
        });
      }
    });
    backends.push({ requests, stdout });
    return {
      closed: exit.promise,
      start: async () => {},
      connect: async () => ({ stdin, stdout, stderr, closed: exit.promise, close: () => {} }),
      stop: async () => {
        stdin.end();
        stdout.end();
        stderr.end();
        exit.resolve({ code: 0, signal: null });
      },
    };
  });
  return { backends, createBackend };
}

describe("hot reload of the official backend", () => {
  it("reloads immediately when idle and defers while an official turn is running", async () => {
    const native = nativeBackends();
    const scope = new OfficialRuntimeScope({
      permanentHome: "/synthetic/permanent",
      createBackend: native.createBackend,
      diagnosticOutput: new PassThrough(),
    });
    const fixture = createFixture({ officialRuntimeScope: scope });
    const params = { clientInfo: { name: "codex_desktop", version: "synthetic" } };
    try {
      writeRequest(fixture.desktopInput, { id: 901, method: "initialize", params });
      await fixture.collector.waitFor((message) => message.id === 901);
      writeRequest(fixture.desktopInput, { method: "initialized" });
      await scope.start();
      expect(native.createBackend).toHaveBeenCalledTimes(1);

      writeRequest(fixture.desktopInput, {
        id: 902,
        method: RLY0_CODEX_RELOAD_BACKEND_METHOD,
        params: {},
      });
      await expect(
        fixture.collector.waitFor((message) => message.id === 902),
      ).resolves.toMatchObject({ result: { status: "reloaded" } });
      expect(native.createBackend).toHaveBeenCalledTimes(2);
      expect(scope.gate.phase).toBe("ready");
      // The replacement process is re-initialized with Desktop's own initialize params.
      expect(native.backends[1]?.requests).toContainEqual(
        expect.objectContaining({ method: "initialize", params }),
      );

      // Desktop keeps working through the same connection.
      writeRequest(fixture.desktopInput, { id: 903, method: "model/list", params: {} });
      await expect(
        fixture.collector.waitFor((message) => message.id === 903),
      ).resolves.toMatchObject({ result: { data: [] } });

      // A running official turn must not be interrupted.
      const second = native.backends[1];
      if (!second) throw new Error("Replacement backend missing");
      writeRequest(second.stdout, {
        method: "turn/started",
        params: {
          threadId: "synthetic-thread",
          turn: { id: "synthetic-turn", status: "inProgress", items: [] },
        },
      });
      await fixture.collector.waitFor((message) => message.method === "turn/started");
      writeRequest(fixture.desktopInput, {
        id: 904,
        method: RLY0_CODEX_RELOAD_BACKEND_METHOD,
        params: {},
      });
      await expect(
        fixture.collector.waitFor((message) => message.id === 904),
      ).resolves.toMatchObject({ result: { status: "deferred" } });
      expect(native.createBackend).toHaveBeenCalledTimes(2);

      writeRequest(second.stdout, {
        method: "turn/completed",
        params: {
          threadId: "synthetic-thread",
          turn: { id: "synthetic-turn", status: "completed", items: [] },
        },
      });
      await vi.waitFor(() => expect(native.createBackend).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(scope.gate.phase).toBe("ready"));
    } finally {
      fixture.host.close();
      await fixture.running;
      await scope.close();
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("rejects malformed reload params", async () => {
    const native = nativeBackends();
    const scope = new OfficialRuntimeScope({
      permanentHome: "/synthetic/permanent",
      createBackend: native.createBackend,
      diagnosticOutput: new PassThrough(),
    });
    const fixture = createFixture({ officialRuntimeScope: scope });
    try {
      writeRequest(fixture.desktopInput, {
        id: 905,
        method: RLY0_CODEX_RELOAD_BACKEND_METHOD,
        params: { unexpected: true },
      });
      await expect(
        fixture.collector.waitFor((message) => message.id === 905),
      ).resolves.toMatchObject({ error: { code: -32602 } });
    } finally {
      fixture.host.close();
      await fixture.running;
      await scope.close();
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });
});
