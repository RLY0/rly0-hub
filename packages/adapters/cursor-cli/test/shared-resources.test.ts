import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedResourcesProvider } from "@codexhost/harness-adapter/plugin";

import { CursorTransport, CURSOR_SHARED_CONTEXT_REQUEST, CURSOR_SHARED_MCP_REQUEST } from "../src/transport.js";

vi.mock("../src/command.js", () => ({
  cursorInvocation: () => ({
    command: process.execPath,
    arguments: [path.resolve("packages/adapters/cursor-cli/test/fixtures/acp.mjs"), "echo"],
    windowsVerbatimArguments: false,
  }),
}));
const callbacks = {
  update: () => {},
  permission: async () => ({ outcome: { outcome: "cancelled" as const } }),
  extension: async () => ({ outcome: { outcome: "cancelled" as const } }),
};
const transports: CursorTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});
const provider = vi.fn<SharedResourcesProvider>(async (_cwd, request) =>
  request?.mcp
    ? { mcpServers: { rly0_memory: { type: "stdio", command: "node", args: ["m.js"], env: {} } }, context: "" }
    : { mcpServers: {}, context: "[RLY/0 shared resources] index" },
);

describe("Cursor shared resources", () => {
  it("attaches shared MCP to real sessions and prefixes prompts", async () => {
    const native = new CursorTransport({ cwd: process.cwd(), environment: process.env, sharedSession: true, loadModelCatalog: false, sharedResources: provider });
    transports.push(native);
    const info = await native.open();
    expect((info as { _meta?: { mcpServers: unknown } })._meta?.mcpServers).toEqual([
      { name: "rly0_memory", command: "node", args: ["m.js"], env: [] },
    ]);
    const result = (await native.prompt("hi", callbacks)) as unknown as {
      _meta?: { prompt: { text: string }[] };
    };
    expect(result._meta?.prompt[0]?.text).toBe("[RLY/0 shared resources] index\n\n[Current user request]\nhi");
    expect(provider).toHaveBeenCalledWith(process.cwd(), CURSOR_SHARED_MCP_REQUEST);
    expect(provider).toHaveBeenCalledWith(process.cwd(), CURSOR_SHARED_CONTEXT_REQUEST);
  });

  it("leaves inspection and history replay sessions alone", async () => {
    provider.mockClear();
    const probe = new CursorTransport({ cwd: process.cwd(), environment: process.env, loadModelCatalog: false, sharedResources: provider });
    transports.push(probe);
    const info = await probe.open();
    expect((info as { _meta?: { mcpServers: unknown } })._meta?.mcpServers).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  });
});
