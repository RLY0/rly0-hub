// Fakes only: no Codex process, Launcher or heartbeat file is touched.
import { describe, expect, it } from "vitest";

import { type Rly0CodexApplyDeps, Rly0CodexApplier } from "../src/rly0-hub-service/codex-apply.js";

function fakes(overrides: Partial<Rly0CodexApplyDeps> & { busyAnswers?: (boolean | null)[] } = {}) {
  const log: string[] = [];
  const busyAnswers = overrides.busyAnswers ?? [false];
  let clock = 0;
  const deps: Rly0CodexApplyDeps = {
    status: async () => ({ running: true }),
    restart: async () => {
      log.push("restart");
      return { ok: true };
    },
    requestReload: async () => {
      log.push("reload");
      return null;
    },
    busy: async () => (busyAnswers.length > 1 ? busyAnswers.shift() : busyAnswers[0]) ?? null,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pollMs: 1000,
    maxWaitMs: 10_000,
    ...overrides,
  };
  return { applier: new Rly0CodexApplier(deps), log };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Rly0CodexApplier", () => {
  it("leaves a closed Codex alone: the next start reads the change", async () => {
    const { applier, log } = fakes({ status: async () => ({ running: false }) });
    expect(await applier.apply({ scope: "window" })).toEqual({ outcome: "notRunning" });
    expect(await applier.apply({ scope: "backend" })).toEqual({ outcome: "notRunning" });
    expect(log).toEqual([]);
  });

  it("reloads the backend in place and never restarts when the Codex side answers", async () => {
    for (const answer of ["reloaded", "deferred"] as const) {
      const { applier, log } = fakes({
        requestReload: async () => {
          log.push("reload");
          return answer;
        },
      });
      expect(await applier.apply({ scope: "backend" })).toEqual({ outcome: answer });
      expect(log).toEqual(["reload"]);
    }
  });

  it("restarts an idle Codex right away for a window-level change", async () => {
    const { applier, log } = fakes({ busyAnswers: [false] });
    expect(await applier.apply({ scope: "window" })).toEqual({ outcome: "restarting" });
    expect(log).toEqual(["restart"]);
  });

  it("waits for running work to end before restarting", async () => {
    const { applier, log } = fakes({ busyAnswers: [true, true, true, false] });
    expect(await applier.apply({ scope: "window" })).toEqual({ outcome: "scheduled" });
    expect(applier.pending).toBe(true);
    expect(log).toEqual([]);
    for (let i = 0; i < 10 && applier.pending; i++) await settle();
    expect(log).toEqual(["restart"]);
    expect(applier.pending).toBe(false);
  });

  it("does not restart after the person cancels the waiting restart", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { applier, log } = fakes({ busyAnswers: [true, false], sleep: () => gate });
    await applier.apply({ scope: "window" });
    applier.cancel();
    release();
    await settle();
    await settle();
    expect(log).toEqual([]);
  });

  it("never restarts blindly when Codex's state is unknown; one click restarts", async () => {
    const { applier, log } = fakes({ busyAnswers: [null] });
    expect(await applier.apply({ scope: "backend" })).toEqual({ outcome: "needsRestart" });
    expect(log).toEqual(["reload"]);
    expect(await applier.apply({ scope: "backend", restartNow: true })).toEqual({
      outcome: "restarting",
    });
    expect(log).toEqual(["reload", "restart"]);
  });

  it("stops waiting when the heartbeat goes away or the deadline passes", async () => {
    const lost = fakes({ busyAnswers: [true, null] });
    await lost.applier.apply({ scope: "window" });
    for (let i = 0; i < 10 && lost.applier.pending; i++) await settle();
    expect(lost.log).toEqual([]);
    const forever = fakes({ busyAnswers: [true] });
    await forever.applier.apply({ scope: "window" });
    for (let i = 0; i < 40 && forever.applier.pending; i++) await settle();
    expect(forever.applier.pending).toBe(false);
    expect(forever.log).toEqual([]);
  });

  it("reports a restart that did not go through", async () => {
    const { applier } = fakes({ restart: async () => ({ ok: false }) });
    expect(await applier.apply({ scope: "window" })).toEqual({ outcome: "failed" });
  });
});
