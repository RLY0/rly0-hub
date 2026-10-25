import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SharedResourcesProvider } from "@codexhost/harness-adapter/plugin";

import {
  OPENCODE_SHARED_RESOURCE_REQUEST,
  openCodeSharedEnvironment,
  renderOpenCodeMcp,
} from "../src/shared-resources.js";

const provider = vi.fn<SharedResourcesProvider>(async () => ({
  mcpServers: {
    codex_docs: { type: "http", url: "https://docs.invalid/mcp", headers: { Authorization: "Bearer t" } },
    rly0_memory: { type: "stdio", command: "node", args: ["m.js"], env: { RLY0_MEMORY_AGENT: "opencode" } },
  },
  context: "[RLY/0 shared resources] index",
}));

describe("OpenCode shared resources", () => {
  it("renders OpenCode's local and remote MCP shapes", () => {
    expect(
      renderOpenCodeMcp({
        a: { type: "stdio", command: "npx", args: ["-y", "x"], env: {} },
        b: { type: "http", url: "https://b.invalid", headers: {} },
      }),
    ).toEqual({
      a: { type: "local", enabled: true, command: ["npx", "-y", "x"] },
      b: { type: "remote", enabled: true, url: "https://b.invalid" },
    });
  });

  it("merges MCP and an instructions file into OPENCODE_CONFIG_CONTENT and removes the file on dispose", async () => {
    const result = await openCodeSharedEnvironment(provider, process.cwd(), {
      PATH: "x",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "allow", mcp: { mine: { type: "local", command: ["a"] } } }),
    });
    expect(provider).toHaveBeenCalledWith(process.cwd(), OPENCODE_SHARED_RESOURCE_REQUEST);
    expect(result.environment.PATH).toBe("x");
    const config = JSON.parse(result.environment.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      permission: string;
      mcp: Record<string, unknown>;
      instructions: string[];
    };
    expect(config.permission).toBe("allow");
    expect(Object.keys(config.mcp)).toEqual(["mine", "codex_docs", "rly0_memory"]);
    expect(config.mcp.rly0_memory).toEqual({ type: "local", enabled: true, command: ["node", "m.js"], environment: { RLY0_MEMORY_AGENT: "opencode" } });
    const file = config.instructions[0] ?? "";
    expect(readFileSync(file, "utf8")).toContain("[RLY/0 shared resources] index");
    expect(readFileSync(file, "utf8")).not.toContain("Bearer t");
    await result.dispose();
    expect(existsSync(file)).toBe(false);
  });

  it("leaves the environment alone without a provider or with unreadable config content", async () => {
    const environment = { OPENCODE_CONFIG_CONTENT: "not json" };
    expect((await openCodeSharedEnvironment(provider, process.cwd(), environment)).environment).toBe(environment);
    expect((await openCodeSharedEnvironment(undefined, process.cwd(), environment)).environment).toBe(environment);
  });
});
