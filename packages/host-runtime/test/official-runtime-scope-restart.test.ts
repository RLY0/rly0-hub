import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  OfficialRuntimeScope,
  type OfficialRuntimeRecoveryOptions,
} from "../src/codex-runtime/official-runtime-scope.js";
import type { OwnedOfficialBackend } from "../src/codex-runtime/official-runtime-owner.js";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";

function fixture(recovery?: OfficialRuntimeRecoveryOptions) {
  const events: string[] = [];
  let failNextStart = false;
  const backends: OwnedOfficialBackend[] = [];
  const createBackend = vi.fn(() => {
    const index = backends.length;
    const exit = Promise.withResolvers<OfficialAppServerExit>();
    const backend: OwnedOfficialBackend = {
      closed: exit.promise,
      start: async () => {
        events.push(`start:${index}`);
        if (failNextStart) {
          failNextStart = false;
          throw new Error("Synthetic start failure");
        }
      },
      connect: async () => {
        throw new Error("No client expected");
      },
      stop: async () => {
        events.push(`stop:${index}`);
        exit.resolve({ code: 0, signal: null });
      },
    };
    backends.push(backend);
    return backend;
  });
  const scope = new OfficialRuntimeScope({
    permanentHome: "/synthetic/home",
    createBackend,
    diagnosticOutput: new PassThrough(),
    ...(recovery ? { recovery } : {}),
  });
  return {
    scope,
    events,
    createBackend,
    failNextStart: () => {
      failNextStart = true;
    },
  };
}

describe("OfficialRuntimeScope.restartBackend", () => {
  it("replaces the backend in place without reporting a Scope failure", async () => {
    const f = fixture();
    try {
      await f.scope.start();
      expect(f.scope.gate.phase).toBe("ready");
      const revision = f.scope.gate.revision;
      const generation = f.scope.owner.generation;

      await f.scope.restartBackend();

      expect(f.events).toEqual(["start:0", "stop:0", "start:1"]);
      expect(f.createBackend).toHaveBeenCalledTimes(2);
      expect(f.scope.gate.phase).toBe("ready");
      expect(f.scope.gate.revision).toBeGreaterThan(revision);
      expect(f.scope.owner.generation).toBe(generation + 1);
      expect(f.scope.owner.running).toBe(true);
      expect(f.scope.restarting).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.scope.gate.phase).toBe("ready");
      expect(f.createBackend).toHaveBeenCalledTimes(2);
    } finally {
      await f.scope.close();
    }
  });

  it("coalesces concurrent reload requests into one restart", async () => {
    const f = fixture();
    try {
      await f.scope.start();
      const first = f.scope.restartBackend();
      const second = f.scope.restartBackend();
      expect(f.scope.restarting).toBe(true);
      await Promise.all([first, second]);
      expect(f.createBackend).toHaveBeenCalledTimes(2);
    } finally {
      await f.scope.close();
    }
  });

  it("refuses to interrupt admitted official work", async () => {
    const f = fixture();
    try {
      await f.scope.start();
      const finish = f.scope.gate.admit();
      await expect(f.scope.restartBackend()).rejects.toMatchObject({ code: "busy" });
      expect(f.createBackend).toHaveBeenCalledTimes(1);
      expect(f.scope.gate.phase).toBe("ready");
      finish();
      await f.scope.restartBackend();
      expect(f.createBackend).toHaveBeenCalledTimes(2);
    } finally {
      await f.scope.close();
    }
  });

  it("rejects after the Scope is closed", async () => {
    const f = fixture();
    await f.scope.start();
    await f.scope.close();
    await expect(f.scope.restartBackend()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("keeps a failed replacement unavailable until an explicit retry without recovery", async () => {
    const f = fixture();
    try {
      await f.scope.start();
      f.failNextStart();
      await expect(f.scope.restartBackend()).rejects.toThrow("unavailable");
      expect(f.scope.gate.phase).toBe("unavailable");
      expect(f.scope.owner.running).toBe(false);
      expect(f.scope.restarting).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.createBackend).toHaveBeenCalledTimes(2);
      await f.scope.restartBackend();
      expect(f.scope.gate.phase).toBe("ready");
      expect(f.scope.owner.running).toBe(true);
      expect(f.createBackend).toHaveBeenCalledTimes(3);
    } finally {
      await f.scope.close();
    }
  });

  it("joins a concurrent start to the manual restart without another generation", async () => {
    const f = fixture({ delaysMs: [1], stableMs: 1_000 });
    try {
      await f.scope.start();
      const restart = f.scope.restartBackend();
      expect(f.scope.start()).toBe(restart);
      await restart;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.events).toEqual(["start:0", "stop:0", "start:1"]);
      expect(f.createBackend).toHaveBeenCalledTimes(2);
      expect(f.scope.gate.phase).toBe("ready");
    } finally {
      await f.scope.close();
    }
  });

  it("recovers a failed manual replacement when automatic recovery is enabled", async () => {
    const f = fixture({ delaysMs: [1], stableMs: 1_000 });
    try {
      await f.scope.start();
      f.failNextStart();
      await expect(f.scope.restartBackend()).rejects.toThrow("unavailable");
      await vi.waitFor(() => {
        expect(f.scope.gate.phase).toBe("ready");
        expect(f.scope.owner.running).toBe(true);
        expect(f.createBackend).toHaveBeenCalledTimes(3);
      });
      expect(f.scope.restarting).toBe(false);
    } finally {
      await f.scope.close();
    }
  });

  it("does not launch a replacement when closed during a manual restart", async () => {
    const f = fixture({ delaysMs: [1], stableMs: 1_000 });
    await f.scope.start();
    const restart = f.scope.restartBackend();
    const rejected = expect(restart).rejects.toMatchObject({ code: "unavailable" });
    await f.scope.close();
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.scope.closed).toBe(true);
    expect(f.scope.owner.running).toBe(false);
    expect(f.createBackend).toHaveBeenCalledTimes(1);
  });
});
