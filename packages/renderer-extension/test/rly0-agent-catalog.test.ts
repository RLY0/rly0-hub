import { describe, expect, it } from "vitest";

import { createAgentGroupPreferenceStore } from "../src/agent-group-preference.js";
import {
  KNOWN_RENDERER_AGENTS,
  RLY0_AGENT_DISPLAY_ORDER,
  RLY0_HIDDEN_RENDERER_AGENTS,
} from "../src/agent-selection-state.js";

describe("RLY/0 Hub agent catalog in Codex", () => {
  it("offers official agents first, then third-party ones, and hides the rest", () => {
    // Agent IDs now come from the Host plugin directory; the store only orders that catalog.
    const catalog = KNOWN_RENDERER_AGENTS.map((id) => ({ id, name: id }));
    const order = createAgentGroupPreferenceStore(null)
      .list(undefined, catalog)
      .map((entry) => entry.agent);
    expect(order.slice(0, 8)).toEqual(RLY0_AGENT_DISPLAY_ORDER.filter((a) => a !== "codex"));
    for (const hidden of RLY0_HIDDEN_RENDERER_AGENTS) {
      // Still known, so old threads with these agents keep working.
      expect(KNOWN_RENDERER_AGENTS).toContain(hidden);
      expect(RLY0_AGENT_DISPLAY_ORDER).not.toContain(hidden);
    }
  });

  it("orders plugins the Host reports even when RLY/0 has never seen them", () => {
    const order = createAgentGroupPreferenceStore(null)
      .list(undefined, [
        { id: "new-plugin", name: "New Plugin" },
        { id: "pi", name: "Pi" },
        { id: "claude-code", name: "Claude Code" },
      ])
      .map((entry) => entry.agent);
    expect(order).toEqual(["claude-code", "pi", "new-plugin"]);
  });
});
