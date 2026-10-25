import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SharedResourcesProvider } from "@codexhost/harness-adapter/plugin";

import { piRpcProcessCommand } from "../src/pi-rpc-session.js";
import {
  PI_SHARED_RESOURCE_REQUEST,
  piSharedArguments,
  preparePiSharedResources,
} from "../src/pi-shared-resources.js";

const provider = vi.fn<SharedResourcesProvider>(async () => ({
  mcpServers: {
    codex_docs: { type: "http", url: "https://docs.invalid/mcp", headers: { Authorization: "Bearer t" } },
    rly0_memory: { type: "stdio", command: "node", args: ["m.js"], env: { RLY0_MEMORY_AGENT: "pi" } },
  },
  context: "[RLY/0 shared resources] use rly0-memory",
  skills: [{ name: "review", directory: "C:/skills/review" }],
}));

describe("Pi shared resources", () => {
  it("writes an extension that registers every server, skill folders and a prompt file", async () => {
    const launch = await preparePiSharedResources(provider, process.cwd());
    expect(provider).toHaveBeenCalledWith(process.cwd(), PI_SHARED_RESOURCE_REQUEST);
    const args = piSharedArguments(launch);
    expect(args).toEqual([
      "--extension",
      launch.extension,
      "--skill",
      "C:/skills/review",
      "--append-system-prompt",
      launch.systemPromptFile,
    ]);
    const registered: [string, unknown][] = [];
    const module = (await import(pathToFileURL(launch.extension ?? "").href)) as {
      default: (pi: unknown) => void;
    };
    module.default({ registerMcpServer: (name: string, config: unknown) => registered.push([name, config]) });
    expect(registered).toEqual([
      ["codex_docs", { type: "http", url: "https://docs.invalid/mcp", headers: { Authorization: "Bearer t" } }],
      ["rly0_memory", { type: "stdio", command: "node", args: ["m.js"], env: { RLY0_MEMORY_AGENT: "pi" } }],
    ]);
    // An older Pi without MCP support loads the extension without error.
    expect(() => module.default({})).not.toThrow();
    expect(readFileSync(launch.systemPromptFile ?? "", "utf8")).not.toContain("Bearer t");
    await launch.dispose();
    expect(existsSync(launch.extension ?? "")).toBe(false);
  });

  it("puts the arguments into the rpc command line", () => {
    const command = piRpcProcessCommand(
      { cwd: process.cwd(), command: process.execPath, environment: {}, sharedArguments: ["--skill", "C:/s"] },
      { platform: "linux", isExecutable: () => true },
    );
    expect(command.arguments).toEqual(["--mode", "rpc", "--skill", "C:/s"]);
  });

  it("adds nothing without a provider", async () => {
    expect(piSharedArguments(await preparePiSharedResources(undefined, process.cwd()))).toEqual([]);
  });
});
