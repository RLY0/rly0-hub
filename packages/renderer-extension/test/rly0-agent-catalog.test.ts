import { describe, expect, it } from "vitest";

import { createAgentGroupPreferenceStore } from "../src/agent-group-preference.js";
import {
  KNOWN_RENDERER_AGENTS,
  RLY0_AGENT_DISPLAY_ORDER,
  RLY0_HIDDEN_RENDERER_AGENTS,
} from "../src/agent-selection-state.js";

describe("RLY/0 Hub agent catalog in Codex", () => {
  it("offers official agents first, then third-party ones, and hides the rest", () => {
    const order = createAgentGroupPreferenceStore(null)
      .list()
      .map((entry) => entry.agent);
    expect(order.slice(0, 8)).toEqual(RLY0_AGENT_DISPLAY_ORDER.filter((a) => a !== "codex"));
    for (const hidden of RLY0_HIDDEN_RENDERER_AGENTS) {
      // Still known, so old threads with these agents keep working.
      expect(KNOWN_RENDERER_AGENTS).toContain(hidden);
      expect(RLY0_AGENT_DISPLAY_ORDER).not.toContain(hidden);
    }
  });
});
