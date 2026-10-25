import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedResourcesProvider } from "@codexhost/harness-adapter/plugin";

import type * as KimiCommand from "../src/command.js";
import {
  KimiAcpTransport,
  KIMI_SHARED_CONTEXT_REQUEST,
  KIMI_SHARED_MCP_REQUEST,
} from "../src/acp-transport.js";

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

vi.mock("../src/command.js", async (original) => ({
  ...(await original<typeof KimiCommand>()),
  resolveKimiExecutable: () => process.execPath,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawn: () => peer.start(),
}));

/** A fake `kimi acp`: records what the Session and the prompt received. */
class FakeKimi {
  readonly child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    pid: undefined,
    kill: () => true,
  });
  readonly received: RpcMessage[] = [];
  send(message: Record<string, unknown>) {
    this.child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  start() {
    let buffered = "";
    this.child.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) {
        const message = JSON.parse(buffered.slice(0, index)) as RpcMessage;
        buffered = buffered.slice(index + 1);
        this.received.push(message);
        if (message.id === undefined || !message.method) continue;
        if (message.method === "initialize") this.send({ id: message.id, result: { protocolVersion: 1 } });
        else if (message.method === "session/new") this.send({ id: message.id, result: { sessionId: "native" } });
        else if (message.method === "session/prompt")
          this.send({ id: message.id, result: { stopReason: "end_turn" } });
        else this.send({ id: message.id, result: {} });
      }
    });
    queueMicrotask(() => this.child.emit("spawn"));
    return this.child;
  }
}
let peer: FakeKimi;
let transport: KimiAcpTransport | undefined;
afterEach(async () => {
  await transport?.close().catch(() => undefined);
  transport = undefined;
});

describe("Kimi shared resources", () => {
  it("attaches MCP and rly0-memory natively at session/new and prefixes each prompt with context", async () => {
    peer = new FakeKimi();
    const provider = vi.fn<SharedResourcesProvider>(async (_cwd, request) =>
      request?.mcp
        ? {
            mcpServers: {
              codex_docs: { type: "http", url: "https://docs.invalid/mcp", headers: { Authorization: "Bearer t" } },
              rly0_memory: { type: "stdio", command: "node", args: ["memory.js"], env: { RLY0_MEMORY_AGENT: "kimi-code" } },
            },
            context: "",
          }
        : { mcpServers: {}, context: "[RLY/0 shared resources] skills" },
    );
    transport = new KimiAcpTransport({ cwd: process.cwd(), sharedResources: provider, commandTimeoutMs: 2000 });
    await transport.openSession({ kind: "create" });
    await transport.prompt("hello", {} as never);
    const created = peer.received.find((m) => m.method === "session/new");
    expect(created?.params?.mcpServers).toEqual([
      { name: "codex_docs", type: "http", url: "https://docs.invalid/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] },
      { name: "rly0_memory", command: "node", args: ["memory.js"], env: [{ name: "RLY0_MEMORY_AGENT", value: "kimi-code" }] },
    ]);
    const prompt = peer.received.find((m) => m.method === "session/prompt");
    expect(JSON.stringify(prompt?.params?.prompt)).toContain("[RLY/0 shared resources] skills\\n\\n[Current user request]\\nhello");
    expect(JSON.stringify(prompt?.params?.prompt)).not.toContain("Bearer t");
    expect(provider).toHaveBeenCalledWith(process.cwd(), KIMI_SHARED_MCP_REQUEST);
    expect(provider).toHaveBeenCalledWith(process.cwd(), KIMI_SHARED_CONTEXT_REQUEST);
  });

  it("opens with no MCP servers when the Host provides none", async () => {
    peer = new FakeKimi();
    transport = new KimiAcpTransport({ cwd: process.cwd(), commandTimeoutMs: 2000 });
    await transport.openSession({ kind: "create" });
    expect(peer.received.find((m) => m.method === "session/new")?.params?.mcpServers).toEqual([]);
  });
});
