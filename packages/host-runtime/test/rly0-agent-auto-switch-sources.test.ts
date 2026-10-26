import { describe, expect, it } from "vitest";

import type { Rly0Relay } from "@codexhost/shared-contracts";

import { createAgentAutoSwitchSources } from "../src/rly0-hub-service/agent-auto-switch-sources.js";

const NOW = 1_800_000_000;

function token(id: string, last4: string): Rly0Relay {
  return {
    id,
    name: "Claude 订阅令牌",
    baseUrl: "https://api.anthropic.com",
    protocol: "responses",
    models: [],
    enabled: true,
    hasKey: true,
    keyMask: `sk-ant-oat01-…${last4}`,
    keyRevision: "a".repeat(64),
  };
}

describe("auto-switch sources: Claude subscription tokens", () => {
  it("decide on the numbers real replies carried and never ask Anthropic themselves", async () => {
    const calls: string[] = [];
    const usage = new Map<string, unknown>([
      // Current token: almost used up (live, from Claude Code's reply headers).
      ["aaaaaaaaaaaa", { windows: [{ kind: "primary", usedPercent: 97, resetsAt: NOW + 600 }] }],
      // Another token: its 5-hour window already reset since it was last seen.
      ["bbbbbbbbbbbb", { windows: [{ kind: "primary", usedPercent: 100, resetsAt: NOW - 1 }] }],
    ]);
    const sources = createAgentAutoSwitchSources({
      core: {
        claudeAccounts: async (method: string) => {
          calls.push(`claude/${method}`);
          return method === "list" ? { accounts: [] } : null;
        },
        grokAccounts: async () => null,
        listRelays: async () => ({
          available: true as const,
          relays: [
            token("aaaaaaaaaaaa", "1111"),
            token("bbbbbbbbbbbb", "2222"),
            token("cccccccccccc", "3333"),
          ],
        }),
      } as never,
      claudeSelection: async () => "aaaaaaaaaaaa",
      tokenUsage: async (relay) => usage.get(relay.id),
      nowSeconds: () => NOW,
      handle: async () => null,
    });
    const all = await sources.candidates("claude", "all");
    expect(all?.map((c) => [c.id, c.current, c.usage])).toEqual([
      [
        "aaaaaaaaaaaa",
        true,
        { windows: [{ kind: "primary", usedPercent: 97, resetsAt: NOW + 600 }] },
      ],
      [
        "bbbbbbbbbbbb",
        false,
        { windows: [{ kind: "primary", usedPercent: 0, resetsAt: NOW - 1 }] },
      ],
      // Never used here yet: unknown, not probed.
      ["cccccccccccc", false, null],
    ]);
    expect(calls).toEqual(["claude/list"]);
    expect(calls).not.toContain("claude/keyInfo");
  });
});
