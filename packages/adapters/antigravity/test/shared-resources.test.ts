import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_SHARED_RESOURCE_REQUEST,
  antigravityTextWithSharedContext,
} from "../src/antigravity-adapter.js";

describe("Antigravity shared Codex resources", () => {
  it("never asks for MCP servers, which its CLI transport cannot attach", () => {
    expect(ANTIGRAVITY_SHARED_RESOURCE_REQUEST).toEqual({
      harnessId: "antigravity",
      skills: true,
      memory: true,
    });
    expect(ANTIGRAVITY_SHARED_RESOURCE_REQUEST).not.toHaveProperty("mcp");
  });

  it("prefixes the reference context to the person's request only when there is one", () => {
    expect(antigravityTextWithSharedContext("[RLY/0 shared resources]", "hi")).toBe(
      "[RLY/0 shared resources]\n\n[Current user request]\nhi",
    );
    expect(antigravityTextWithSharedContext("", "hi")).toBe("hi");
  });
});
