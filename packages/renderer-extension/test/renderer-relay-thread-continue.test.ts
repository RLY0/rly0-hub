import { describe, expect, it, vi } from "vitest";

import {
  RLY0_THREAD_CONTINUED_CODE,
  RLY0_THREAD_CONTINUED_NOTE,
  RLY0_THREAD_PROVIDER_LOCKED_CODE,
} from "@codexhost/shared-contracts";

import {
  isThreadProviderLockedError,
  threadContinuedTarget,
  threadProviderLockedReason,
  withRelayThreadContinue,
} from "../src/renderer-relay-thread-continue.js";

const LOCKED = `这个对话是用官方账号开始的，没能自动换到中转模型继续。 (${RLY0_THREAD_PROVIDER_LOCKED_CODE})`;
const THREAD_ID = "019a0000-0000-7000-8000-000000000001";
const FORK_ID = "019a0000-0000-7000-8000-000000000002";
const CONTINUED = `${RLY0_THREAD_CONTINUED_NOTE} (${RLY0_THREAD_CONTINUED_CODE}:${FORK_ID})`;

function setup(openFails = false) {
  const notes: string[] = [];
  const open = vi.fn(async () => {
    if (openFails) throw new Error("not found");
  });
  const sender = withRelayThreadContinue(undefined, {
    open: open as never,
    note: (text) => notes.push(text),
  });
  return { notes, open, sender };
}

const params = {
  threadId: THREAD_ID,
  input: [{ type: "text", text: "继续写支付回调" }],
  model: null,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("continuing a provider-locked Thread without a choice dialog", () => {
  it("recognises the Host's markers", () => {
    expect(isThreadProviderLockedError(new Error(LOCKED))).toBe(true);
    expect(isThreadProviderLockedError({ code: -32602, message: LOCKED })).toBe(true);
    expect(
      isThreadProviderLockedError(
        new Error(
          "The 'rly0/x/gpt' model is not supported when using Codex with a ChatGPT account.",
        ),
      ),
    ).toBe(false);
    expect(threadProviderLockedReason(new Error(LOCKED))).not.toContain(
      RLY0_THREAD_PROVIDER_LOCKED_CODE,
    );
    expect(threadContinuedTarget({ message: CONTINUED })).toBe(FORK_ID);
    expect(threadContinuedTarget(new Error(LOCKED))).toBeUndefined();
  });

  it("opens the forked Thread and shows a short note; the reply still reaches Desktop", async () => {
    const { notes, open, sender } = setup();
    await expect(
      sender(params, () => Promise.reject(new Error(CONTINUED))) as Promise<unknown>,
    ).rejects.toThrow(RLY0_THREAD_CONTINUED_CODE);
    await flush();
    expect(open).toHaveBeenCalledWith(FORK_ID);
    expect(notes).toEqual([RLY0_THREAD_CONTINUED_NOTE]);
  });

  it("still says where the conversation went when the new Thread cannot be opened", async () => {
    const { notes, sender } = setup(true);
    await expect(
      sender(params, () => Promise.reject(new Error(CONTINUED))) as Promise<unknown>,
    ).rejects.toThrow();
    await flush();
    expect(notes[0]).toContain(RLY0_THREAD_CONTINUED_NOTE);
  });

  it("only notes the reason when even the fork failed, and passes other results through", async () => {
    const { notes, open, sender } = setup();
    await expect(
      sender(params, () => Promise.reject(new Error(LOCKED))) as Promise<unknown>,
    ).rejects.toThrow(RLY0_THREAD_PROVIDER_LOCKED_CODE);
    expect(open).not.toHaveBeenCalled();
    expect(notes).toEqual([threadProviderLockedReason(new Error(LOCKED))]);
    const ok = { turn: { id: "t" } };
    expect(await (sender(params, () => Promise.resolve(ok)) as Promise<unknown>)).toBe(ok);
    await expect(
      sender(params, () => Promise.reject(new Error("network"))) as Promise<unknown>,
    ).rejects.toThrow("network");
    expect(sender(params, () => "sync")).toBe("sync");
    expect(notes).toHaveLength(1);
  });
});
