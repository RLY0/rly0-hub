import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { RLY0_THREAD_CONTINUED_CODE } from "@codexhost/shared-contracts";
import { Rly0CoreBridge } from "../src/rly0-core/index.js";
import { Rly0RelayCodexConfigManager } from "../src/rly0-relay/codex-config.js";
import {
  createFixture,
  readJsonLine,
  requestId,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const RELAY_MODEL = "rly0/f484ef57d8f9/gpt-6.1-sol";
const UNIFIED_BASE = "http://127.0.0.1:25917/u/v1";

beforeEach(() => {
  vi.spyOn(Rly0CoreBridge.prototype, "listRelays").mockResolvedValue({
    available: true,
    relays: [
      {
        id: "f484ef57d8f9",
        name: "零号中转",
        baseUrl: "https://relay.example/v1",
        protocol: "responses",
        models: ["gpt-6.1-sol"],
        enabled: true,
        hasKey: true,
      },
    ],
  } as Awaited<ReturnType<Rly0CoreBridge["listRelays"]>>);
  vi.spyOn(Rly0CoreBridge.prototype, "proxyStatus").mockResolvedValue({
    available: true,
    running: true,
    port: 25917,
    baseUrl: "http://127.0.0.1:25917/v1",
    requests: 0,
    routed: 0,
    unrouted: 0,
    failed: 0,
    recent: [],
  } as Awaited<ReturnType<Rly0CoreBridge["proxyStatus"]>>);
  vi.spyOn(Rly0CoreBridge.prototype, "proxyCustomProviders").mockResolvedValue({
    available: true,
    count: 0,
  });
  vi.spyOn(Rly0RelayCodexConfigManager.prototype, "status").mockResolvedValue({
    modelProvider: "openai",
  } as unknown as Awaited<ReturnType<Rly0RelayCodexConfigManager["status"]>>);
});
afterEach(() => vi.restoreAllMocks());

type Fixture = ReturnType<typeof createFixture>;

/** 统一渠道 is on by default; Codex's home is an empty temporary directory, never ~/.codex. */
function unifiedFixture(): Fixture {
  return createFixture({
    environment: { CODEX_HOME: mkdtempSync(path.join(tmpdir(), "rly0-unified-codex-")) },
  });
}

function answer(fixture: Fixture, id: unknown, response: JsonObject): void {
  fixture.official.stdout.write(`${JSON.stringify({ id, ...response })}\n`);
}

function loaded(threadId: string, model: string, modelProvider: string): JsonObject {
  return {
    result: { thread: { id: threadId, modelProvider, turns: [] }, model, modelProvider },
  };
}

const turn = (threadId: string, model: string): JsonObject => ({
  threadId,
  input: [{ type: "text", text: "继续" }],
  model: null,
  collaborationMode: { mode: "default", settings: { model } },
});

describe("SYNTHETIC 统一渠道 on the Codex wire", () => {
  it("resumes the old ChatGPT-login Thread on rly0, so a relay turn needs no new conversation", async () => {
    const fixture = unifiedFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "thread/resume",
        params: { threadId: "old" },
      });
      const read = await readJsonLine(fixture.official.stdin);
      expect(read).toMatchObject({ method: "thread/read", params: { threadId: "old" } });
      answer(fixture, read.id, {
        result: { thread: { id: "old", modelProvider: "openai", model: "gpt-5.5" } },
      });
      const resume = await readJsonLine(fixture.official.stdin);
      expect(resume).toMatchObject({
        method: "thread/resume",
        params: {
          threadId: "old",
          model: "gpt-5.5",
          modelProvider: "rly0",
          config: {
            "model_providers.rly0": { base_url: UNIFIED_BASE, requires_openai_auth: true },
          },
        },
      });
      answer(fixture, resume.id, loaded("old", "gpt-5.5", "rly0"));
      await fixture.collector.waitFor((message) => requestId(message, 1));

      for (const [id, model] of [
        [2, RELAY_MODEL],
        [3, "gpt-5.5"],
      ] as const) {
        writeRequest(fixture.desktopInput, {
          id,
          method: "turn/start",
          params: turn("old", model),
        });
        const sent = await readJsonLine(fixture.official.stdin);
        expect(sent).toMatchObject({
          method: "turn/start",
          params: { threadId: "old", collaborationMode: { settings: { model } } },
        });
        answer(fixture, sent.id, { result: { turn: { id: `t${id}`, status: "inProgress" } } });
        expect(await fixture.collector.waitFor((message) => requestId(message, id))).toHaveProperty(
          "result",
        );
      }
    } finally {
      await stopFixture(fixture);
    }
  });

  it("forks a Thread still loaded on openai onto rly0 for a relay turn; official turns stay put", async () => {
    const fixture = unifiedFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 11,
        method: "thread/resume",
        params: { threadId: "running" },
      });
      const read = await readJsonLine(fixture.official.stdin);
      answer(fixture, read.id, {
        result: { thread: { id: "running", modelProvider: "openai", model: "gpt-5.5" } },
      });
      const resume = await readJsonLine(fixture.official.stdin);
      // Codex ignores overrides for a running Thread and answers with the provider it keeps.
      answer(fixture, resume.id, loaded("running", "gpt-5.5", "openai"));
      await fixture.collector.waitFor((message) => requestId(message, 11));

      writeRequest(fixture.desktopInput, {
        id: 12,
        method: "turn/start",
        params: turn("running", "gpt-5.5"),
      });
      const official = await readJsonLine(fixture.official.stdin);
      expect(official).toMatchObject({ method: "turn/start", params: { threadId: "running" } });
      answer(fixture, official.id, { result: { turn: { id: "o1", status: "inProgress" } } });
      await fixture.collector.waitFor((message) => requestId(message, 12));

      writeRequest(fixture.desktopInput, {
        id: 13,
        method: "turn/start",
        params: turn("running", RELAY_MODEL),
      });
      const fork = await readJsonLine(fixture.official.stdin);
      expect(fork).toMatchObject({
        method: "thread/fork",
        params: {
          threadId: "running",
          model: RELAY_MODEL,
          modelProvider: "rly0",
          config: { "model_providers.rly0": { base_url: UNIFIED_BASE } },
        },
      });
      answer(fixture, fork.id, loaded("running-fork", RELAY_MODEL, "rly0"));
      const moved = await readJsonLine(fixture.official.stdin);
      expect(moved).toMatchObject({
        method: "turn/start",
        params: { threadId: "running-fork", input: [{ type: "text", text: "继续" }] },
      });
      answer(fixture, moved.id, { result: { turn: { id: "f1", status: "inProgress" } } });
      const reply = await fixture.collector.waitFor((message) => requestId(message, 13));
      expect((reply.error as JsonObject).message).toContain(
        `${RLY0_THREAD_CONTINUED_CODE}:running-fork`,
      );
      expect((reply.error as JsonObject).message).toContain("已在新对话里继续（原对话保留）");
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([RELAY_MODEL, "gpt-5.5", null])(
    "forwards an empty continue turn/start on a rly0 Thread unchanged (model %s)",
    async (model) => {
      const fixture = unifiedFixture();
      try {
        await fixture.ready;
        writeRequest(fixture.desktopInput, {
          id: 31,
          method: "thread/start",
          params: { model: "gpt-5.5" },
        });
        const start = await readJsonLine(fixture.official.stdin);
        answer(fixture, start.id, loaded("stopped", "gpt-5.5", "rly0"));
        await fixture.collector.waitFor((message) => requestId(message, 31));

        const params = {
          threadId: "stopped",
          input: [],
          model: null,
          ...(model ? { collaborationMode: { mode: "default", settings: { model } } } : {}),
        };
        writeRequest(fixture.desktopInput, { id: 32, method: "turn/start", params });
        const sent = await readJsonLine(fixture.official.stdin);
        expect(sent).toMatchObject({ method: "turn/start", params });
        answer(fixture, sent.id, { result: { turn: { id: "c1", status: "inProgress" } } });
        expect(await fixture.collector.waitFor((message) => requestId(message, 32))).toHaveProperty(
          "result",
        );
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("starts new Threads on rly0", async () => {
    const fixture = unifiedFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 21,
        method: "thread/start",
        params: { model: "gpt-5.5" },
      });
      const start = await readJsonLine(fixture.official.stdin);
      expect(start).toMatchObject({
        method: "thread/start",
        params: {
          model: "gpt-5.5",
          modelProvider: "rly0",
          config: { "model_providers.rly0": { base_url: UNIFIED_BASE } },
        },
      });
      answer(fixture, start.id, loaded("new", "gpt-5.5", "rly0"));
      await fixture.collector.waitFor((message) => requestId(message, 21));
    } finally {
      await stopFixture(fixture);
    }
  });
});
