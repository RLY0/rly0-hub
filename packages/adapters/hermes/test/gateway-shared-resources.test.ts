import { describe, expect, it, vi } from "vitest";
import type { SharedResourcesProvider } from "@codexhost/harness-adapter/plugin";

import { HermesGatewayTransport } from "../src/gateway-transport.js";
import {
  HERMES_SHARED_CONTEXT_REQUEST,
  hermesSharedSkillBootstrap,
} from "../src/gateway-shared-resources.js";

describe("Hermes shared resources", () => {
  it("registers each skill folder in the gateway process and skips unsafe names", () => {
    const script = hermesSharedSkillBootstrap([
      { name: "review", directory: String.raw`C:\Users\me\.codex\skills\review\\` },
      { name: 'bad name"); import os', directory: "C:/x" },
    ]);
    expect(script).toContain('PluginManifest(name="rly0-shared")');
    expect(script).toContain(
      JSON.stringify([["review", String.raw`C:\Users\me\.codex\skills\review/SKILL.md`]]),
    );
    expect(script).not.toContain("import os");
    expect(script.startsWith("import hermes_bootstrap\n")).toBe(true);
    expect(hermesSharedSkillBootstrap([])).toBe("");
  });

  it("asks only for the memory digest per prompt", async () => {
    const provider = vi.fn<SharedResourcesProvider>(async () => ({ mcpServers: {}, context: "digest" }));
    const transport = new HermesGatewayTransport("python", process.cwd(), {}, 1000, provider);
    expect(await transport.sharedContext()).toBe("digest");
    expect(provider).toHaveBeenCalledWith(process.cwd(), HERMES_SHARED_CONTEXT_REQUEST);
    expect(await new HermesGatewayTransport("python", process.cwd(), {}).sharedContext()).toBeUndefined();
  });
});
