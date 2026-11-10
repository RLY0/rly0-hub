import { describe, expect, it } from "vitest";

import { estimateClaudeRequestCostUsd } from "../src/usage-estimate.js";

const usage = {
  requestId: "request-1",
  model: "claude-sonnet-4-6",
  provider: "firstParty",
  inputTokens: 100_000,
  outputTokens: 10_000,
  cacheCreationInputTokens: 20_000,
  cacheReadInputTokens: 500_000,
} as const;

describe("Claude request cost estimate", () => {
  it("prices actual first-party Sonnet request attribution including cache categories", () => {
    expect(estimateClaudeRequestCostUsd(usage)).toBeCloseTo(0.3 + 0.075 + 0.15 + 0.15, 12);
  });

  it("prices Claude Opus 5 at the Opus tier", () => {
    expect(estimateClaudeRequestCostUsd({ ...usage, model: "claude-opus-5" })).toBeCloseTo(
      0.5 + 0.125 + 0.25 + 0.25,
      12,
    );
  });

  it("prices Claude Fable 5 and Claude Fable 5.1 apart on their cache read rate", () => {
    expect(estimateClaudeRequestCostUsd({ ...usage, model: "claude-fable-5" })).toBeCloseTo(
      1 + 0.25 + 0.5 + 0.5,
      12,
    );
    expect(estimateClaudeRequestCostUsd({ ...usage, model: "claude-fable-5-1" })).toBeCloseTo(
      1 + 0.25 + 0.125 + 0.5,
      12,
    );
  });

  it("prices the 5.2 and 5.5 point releases at their own tiers, not their family's", () => {
    // 100k input, 10k output, 20k cache write, 500k cache read.
    const cost = (input: number, output: number, cacheWrite: number, cacheRead: number) =>
      0.1 * input + 0.01 * output + 0.02 * cacheWrite + 0.5 * cacheRead;
    const price = (model: string) => estimateClaudeRequestCostUsd({ ...usage, model });

    expect(price("claude-fable-5-2")).toBeCloseTo(cost(8, 40, 10, 0.2), 12);
    expect(price("claude-mythos-5-2")).toBeCloseTo(cost(8, 40, 10, 0.2), 12);
    expect(price("claude-mythos-5-1")).toBeCloseTo(cost(10, 50, 12.5, 0.25), 12);
    expect(price("claude-opus-5-5")).toBeCloseTo(cost(4, 20, 5, 0.2), 12);
    expect(price("claude-sonnet-5-5")).toBeCloseTo(cost(2, 10, 2.5, 0.1), 12);
    expect(price("claude-fable-5-1")).toBeCloseTo(cost(10, 50, 12.5, 0.25), 12);
    expect(price("claude-opus-5")).toBeCloseTo(cost(5, 25, 6.25, 0.5), 12);
  });

  it("does not price an unknown model or third-party Provider", () => {
    const usageWithoutModel = {
      requestId: usage.requestId,
      provider: usage.provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    };
    const usageWithoutProvider = {
      requestId: usage.requestId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    };

    expect(estimateClaudeRequestCostUsd({ ...usage, model: "custom-model" })).toBeUndefined();
    expect(estimateClaudeRequestCostUsd({ ...usage, provider: "bedrock" })).toBeUndefined();
    expect(estimateClaudeRequestCostUsd(usageWithoutProvider)).toBeUndefined();
    expect(estimateClaudeRequestCostUsd(usageWithoutModel)).toBeUndefined();
  });
});
