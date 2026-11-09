import { expect, it, vi } from "vitest";
import { watchCodexUpdateLease } from "../src/rly0-hub-service/codex-update-watchdog.js";

it.each(["dead", "expired", "future", "invalid"])(
  "disarms on %s lease without depending on the Hub or its next startup",
  async (reason) => {
    const disarm = vi.fn(async () => undefined);
    await watchCodexUpdateLease({
      id: "synthetic",
      read: async () => ({
        id: "synthetic",
        pid: 123,
        at:
          reason === "expired"
            ? 0
            : reason === "future"
              ? 200_000
              : reason === "invalid"
                ? NaN
                : 100_000,
      }),
      alive: () => reason !== "dead",
      now: () => 100_000,
      disarm,
      wait: async () => {
        throw new Error("must not wait");
      },
    });
    expect(disarm).toHaveBeenCalledOnce();
  },
);
it("keeps a live fresh release armed, then exits without touching explicitly restored preferences", async () => {
  const disarm = vi.fn(async () => undefined);
  const ready = vi.fn();
  let count = 0;
  await watchCodexUpdateLease({
    id: "synthetic",
    read: async () => (count++ === 0 ? { id: "synthetic", pid: 123, at: 100_000 } : null),
    alive: () => true,
    now: () => 100_000,
    disarm,
    ready,
    wait: async () => undefined,
  });
  expect(ready).toHaveBeenCalledOnce();
  expect(disarm).not.toHaveBeenCalled();
});
it("an older watchdog cannot disarm a newer lease owner", async () => {
  const disarm = vi.fn(async () => undefined);
  await watchCodexUpdateLease({
    id: "old",
    read: async () => ({ id: "new", pid: 123, at: 100_000 }),
    alive: () => false,
    now: () => 100_000,
    disarm,
    wait: async () => undefined,
  });
  expect(disarm).not.toHaveBeenCalled();
});
it("read errors fail closed instead of leaving automatic updates armed", async () => {
  const disarm = vi.fn(async () => undefined);
  const ready = vi.fn();
  await watchCodexUpdateLease({
    id: "synthetic",
    read: async () => {
      throw new Error("synthetic corrupt journal");
    },
    alive: () => true,
    disarm,
    ready,
    wait: async () => undefined,
  });
  expect(disarm).toHaveBeenCalledOnce();
  expect(ready).not.toHaveBeenCalled();
});
