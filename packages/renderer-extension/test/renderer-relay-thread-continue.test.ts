import { describe, expect, it, vi } from "vitest";

import { RLY0_THREAD_PROVIDER_LOCKED_CODE } from "@codexhost/shared-contracts";

import {
  isThreadProviderLockedError,
  threadProviderLockedReason,
  turnStartFollowUp,
  withRelayThreadContinue,
  type RelayThreadContinueOffer,
} from "../src/renderer-relay-thread-continue.js";

const LOCKED = `这个对话是用官方账号开始的，Codex 不能在同一个对话里改用中转模型。 (${RLY0_THREAD_PROVIDER_LOCKED_CODE})`;
const THREAD_ID = "019a0000-0000-7000-8000-000000000001";

function setup() {
  const offers: RelayThreadContinueOffer[] = [];
  const handoff = vi.fn(async () => ({
    threadId: "019a0000-0000-7000-8000-000000000002",
    mode: "created" as const,
    title: "↪ 支付系统 · 接力 Codex",
    carried: {
      turns: 1,
      includedTurns: 1,
      omittedTurns: 0,
      commands: 0,
      files: 0,
      truncated: false,
    },
  }));
  const open = vi.fn(async () => undefined);
  const sender = withRelayThreadContinue(undefined, {
    handoff: handoff as never,
    open: open as never,
    show: (offer) => offers.push(offer),
    requestId: () => "click-relay-0001",
  });
  return { offers, handoff, open, sender };
}

const params = {
  threadId: THREAD_ID,
  input: [{ type: "text", text: "继续写支付回调" }],
  model: null,
};

describe("在新对话里继续 after a provider-lock refusal", () => {
  it("recognises only the Host's provider-lock refusal", () => {
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
    expect(turnStartFollowUp(params)).toBe("继续写支付回调");
    expect(turnStartFollowUp({ input: [{ type: "image", url: "x" }] })).toBeUndefined();
  });

  it("keeps the rejection, and one click hands off to a new Codex Thread with the draft", async () => {
    const { offers, handoff, open, sender } = setup();
    const send = vi.fn(() => Promise.reject(new Error(LOCKED)));
    await expect(sender(params, send) as Promise<unknown>).rejects.toThrow(
      RLY0_THREAD_PROVIDER_LOCKED_CODE,
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]?.threadId).toBe(THREAD_ID);
    await offers[0]?.continue();
    expect(handoff).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      targetHarnessId: "codex",
      requestId: "click-relay-0001",
      followUp: "继续写支付回调",
    });
    expect(open).toHaveBeenCalledWith("019a0000-0000-7000-8000-000000000002");
  });

  it("passes other results and errors through untouched", async () => {
    const { offers, sender } = setup();
    const ok = { turn: { id: "t" } };
    expect(await (sender(params, () => Promise.resolve(ok)) as Promise<unknown>)).toBe(ok);
    await expect(
      sender(params, () => Promise.reject(new Error("network"))) as Promise<unknown>,
    ).rejects.toThrow("network");
    expect(sender(params, () => "sync")).toBe("sync");
    expect(offers).toHaveLength(0);
  });
});
