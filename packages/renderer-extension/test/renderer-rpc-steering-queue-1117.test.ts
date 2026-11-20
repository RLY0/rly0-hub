import { describe, expect, it, vi } from "vitest";
import { prepareRpcSteeringQueue } from "../src/renderer-rpc-steering-queue.js";

/** Synthetic Manager shaped like Desktop 26.1117, which has no `getTurnById`. */
function manager1117(status: string) {
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    subscribe: (input) => {
      (input as { listener(value: unknown): void }).listener([{ id: "message" }]);
      return { [Symbol.dispose]: () => undefined };
    },
    getThreadExecutionState: () => ({ inProgress: false, activeTurnId: null }),
    getDynamicToolTurnContext: vi.fn((_thread: unknown, turnId: unknown) =>
      turnId === "turn-1" ? { status, rootTurnId: null } : null,
    ),
  };
  return {
    methods,
    call: (name: string, ...args: unknown[]) => {
      const method = methods[name];
      if (!method) throw new TypeError(`${name} is not a function`);
      return method(...args);
    },
  };
}

describe("26.1117 steering queue reconciliation", () => {
  it.each([
    ["completed", true],
    ["interrupted", false],
  ] as const)(
    "reads a %s Turn without getTurnById and resumes only after completion",
    async (status, resumes) => {
      const manager = manager1117(status);
      const coordinator = vi.fn<(name: string, ...args: unknown[]) => Promise<undefined>>(
        async () => undefined,
      );
      const finish = await prepareRpcSteeringQueue(
        "local",
        "thread",
        manager.call,
        coordinator,
        "message",
      );
      await finish("turn-1");
      expect(manager.methods.getDynamicToolTurnContext).toHaveBeenCalledWith("thread", "turn-1");
      expect(coordinator.mock.calls.map(([name]) => name)).toEqual(
        resumes
          ? ["removeQueuedMessage", "resumeInterruptedQueuedMessages"]
          : ["removeQueuedMessage"],
      );
    },
  );
});
