import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  sanitizeResponsesRequest,
  UnifiedResponsesForwarder,
} from "../src/rly0-relay/unified-responses-forwarder.js";

const relayHistory = [
  { type: "message", role: "user", id: "item_u1", content: [{ type: "input_text", text: "hi" }] },
  { type: "reasoning", id: "rs_1", encrypted_content: "x", summary: [] },
  { type: "function_call", id: "item_f1", call_id: "call_1", name: "shell", arguments: "{}" },
  { type: "function_call_output", call_id: "call_1", output: "ok" },
  { type: "custom_tool_call", id: "ctc_ok", call_id: "call_2", name: "apply_patch", input: "" },
  { type: "message", role: "assistant", id: "msg_ok", content: [] },
  { type: "web_search_call", id: "item_w1", status: "completed" },
];

describe("unified channel: other upstreams' item ids", () => {
  it("drops only the ids the official API would refuse; content and call ids stay", () => {
    const cleaned = sanitizeResponsesRequest({ model: "gpt", input: relayHistory });
    expect(cleaned?.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      relayHistory[1],
      { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
      relayHistory[3],
      relayHistory[4],
      relayHistory[5],
      { type: "web_search_call", status: "completed" },
    ]);
    expect(sanitizeResponsesRequest({ input: [relayHistory[5]] })).toBeNull();
    expect(sanitizeResponsesRequest({ input: "text" })).toBeNull();
    expect(
      sanitizeResponsesRequest({ input: [{ type: "reasoning", id: "item_r", summary: [] }] })
        ?.input,
    ).toEqual([]);
    expect(
      sanitizeResponsesRequest({ input: [relayHistory[1], relayHistory[5]] }, true)?.input,
    ).toEqual([relayHistory[5]]);
  });
});

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let servers: http.Server[] = [];
const forwarders: UnifiedResponsesForwarder[] = [];
afterEach(() => {
  for (const server of servers) server.close();
  for (const forwarder of forwarders) forwarder.close();
  servers = [];
});

async function upstream(answer: (seen: Seen, index: number) => [number, string]) {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        path: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(entry);
      const [status, body] = answer(entry, seen.length - 1);
      response.writeHead(status, { "content-type": "text/event-stream" });
      response.end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const forwarder = new UnifiedResponsesForwarder();
  forwarders.push(forwarder);
  const base = await forwarder.url(`http://127.0.0.1:${port}/u/v1`);
  return { seen, base };
}

describe("unified channel forwarder", () => {
  it("sends the cleaned history, keeps the login header and streams the answer back", async () => {
    const { seen, base } = await upstream(() => [200, "data: done\n\n"]);
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/u\/v1$/u);
    const response = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer chatgpt", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6.1", input: relayHistory }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: done\n\n");
    expect(seen[0]?.path).toBe("/u/v1/responses");
    expect(seen[0]?.headers.authorization).toBe("Bearer chatgpt");
    const sent = JSON.parse(seen[0]?.body ?? "{}") as { input: Array<{ id?: string }> };
    expect(sent.input.map((item) => item.id ?? null)).toEqual([
      null,
      "rs_1",
      null,
      null,
      "ctc_ok",
      "msg_ok",
      null,
    ]);
  });

  it("reads a compressed body and passes other requests through untouched", async () => {
    const { seen, base } = await upstream(() => [200, "{}"]);
    const body = zlib.gzipSync(JSON.stringify({ input: relayHistory.slice(0, 1) }));
    await fetch(`${base}/responses`, {
      method: "POST",
      headers: { "content-encoding": "gzip", "content-type": "application/json" },
      body,
    });
    expect(seen[0]?.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    // Codex compresses its requests to the ChatGPT backend with zstd.
    await fetch(`${base}/responses`, {
      method: "POST",
      headers: { "content-encoding": "zstd" },
      body: zlib.zstdCompressSync(JSON.stringify({ input: relayHistory.slice(2, 3) })),
    });
    expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({
      input: [{ type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" }],
    });
    await fetch(`${base}/models`);
    expect(seen[2]?.path).toBe("/u/v1/models");
  });

  it("sends once more without reasoning when the upstream cannot read another's", async () => {
    const { seen, base } = await upstream((_seen, index) =>
      index === 0
        ? [
            400,
            JSON.stringify({
              error: { message: "The encrypted content for item rs_1 could not be verified." },
            }),
          ]
        : [200, "data: ok\n\n"],
    );
    const response = await fetch(`${base}/responses`, {
      method: "POST",
      body: JSON.stringify({ input: [relayHistory[1], relayHistory[5]] }),
    });
    expect(await response.text()).toBe("data: ok\n\n");
    expect(seen).toHaveLength(2);
    expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({ input: [relayHistory[5]] });
  });

  it("passes any other rejection on as it is", async () => {
    const { seen, base } = await upstream(() => [400, '{"error":{"message":"bad model"}}']);
    const response = await fetch(`${base}/responses`, {
      method: "POST",
      body: JSON.stringify({ input: [relayHistory[1]] }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":{"message":"bad model"}}');
    expect(seen).toHaveLength(1);
  });
});
