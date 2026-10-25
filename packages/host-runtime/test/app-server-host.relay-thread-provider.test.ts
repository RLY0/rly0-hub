import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { RLY0_THREAD_PROVIDER_LOCKED_CODE } from "@codexhost/shared-contracts";
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

let noAccount = false;

beforeEach(() => {
  noAccount = false;
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
  // Never the real ~/.codex/config.toml: the mode comes from this synthetic status only.
  vi.spyOn(Rly0RelayCodexConfigManager.prototype, "status").mockImplementation(
    async () =>
      (noAccount
        ? { noAccount: true, model: "gpt-6.1-sol", modelProvider: "rly0" }
        : { modelProvider: "rly0" }) as unknown as Awaited<
        ReturnType<Rly0RelayCodexConfigManager["status"]>
      >,
  );
});
afterEach(() => vi.restoreAllMocks());

type Fixture = ReturnType<typeof createFixture>;

function answer(fixture: Fixture, id: unknown, response: JsonObject): void {
  fixture.official.stdout.write(`${JSON.stringify({ id, ...response })}\n`);
}

async function desktop(fixture: Fixture, id: number, method: string, params: JsonObject) {
  writeRequest(fixture.desktopInput, { id, method, params });
  return fixture.collector.waitFor((message) => requestId(message, id));
}

/** Answers the Host's metadata-only `thread/read` with the Thread's stored route. */
async function answerStoredThread(fixture: Fixture, threadId: string, modelProvider: string) {
  const read = await readJsonLine(fixture.official.stdin);
  expect(read).toMatchObject({ method: "thread/read", params: { threadId, includeTurns: false } });
  answer(fixture, read.id, {
    result: {
      thread: { id: threadId, modelProvider, model: "gpt-5.5", status: { type: "notLoaded" } },
    },
  });
}

function resumed(threadId: string, model: string, modelProvider: string): JsonObject {
  return {
    result: { thread: { id: threadId, modelProvider, turns: [] }, model, modelProvider },
  };
}

const relayTurn = (threadId: string): JsonObject => ({
  threadId,
  input: [{ type: "text", text: "继续" }],
  model: null,
  effort: null,
  collaborationMode: {
    mode: "default",
    settings: { model: RELAY_MODEL, reasoning_effort: null, developer_instructions: null },
  },
});

describe("SYNTHETIC relay model on an older official-provider Thread", () => {
  it("no-account mode resumes the old openai Thread on the rly0 provider, so turns go to the relay", async () => {
    noAccount = true;
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 11,
        method: "thread/resume",
        params: { threadId: "old-pay", model: null },
      });
      await answerStoredThread(fixture, "old-pay", "openai");
      const resume = await readJsonLine(fixture.official.stdin);
      expect(resume).toMatchObject({
        method: "thread/resume",
        params: {
          threadId: "old-pay",
          model: RELAY_MODEL,
          modelProvider: "rly0",
          config: {
            "model_providers.rly0": {
              base_url: "http://127.0.0.1:25917/v1",
              requires_openai_auth: false,
            },
          },
        },
      });
      answer(fixture, resume.id, resumed("old-pay", RELAY_MODEL, "rly0"));
      expect(await fixture.collector.waitFor((message) => requestId(message, 11))).toHaveProperty(
        "result",
      );

      writeRequest(fixture.desktopInput, {
        id: 12,
        method: "turn/start",
        params: relayTurn("old-pay"),
      });
      const turn = await readJsonLine(fixture.official.stdin);
      expect(turn).toMatchObject({
        method: "turn/start",
        params: {
          threadId: "old-pay",
          collaborationMode: { settings: { model: RELAY_MODEL } },
        },
      });
      answer(fixture, turn.id, { result: { turn: { id: "turn-1", status: "inProgress" } } });
      expect(await fixture.collector.waitFor((message) => requestId(message, 12))).toHaveProperty(
        "result",
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it("refuses a relay turn on a Thread loaded on openai with a Chinese, actionable error", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 21,
        method: "thread/resume",
        params: { threadId: "loaded-official" },
      });
      const resume = await readJsonLine(fixture.official.stdin);
      expect(resume).toMatchObject({ method: "thread/resume" });
      expect((resume.params as JsonObject).modelProvider).toBeUndefined();
      answer(fixture, resume.id, resumed("loaded-official", "gpt-5.5", "openai"));
      await fixture.collector.waitFor((message) => requestId(message, 21));

      // Manual relay pick while no-account mode is off; Codex cannot switch a loaded Thread.
      const refused = await desktop(fixture, 22, "turn/start", relayTurn("loaded-official"));
      const error = refused.error as JsonObject;
      expect(error.message).toContain("在新对话里继续（带上之前的内容）");
      expect(error.message).toContain(RLY0_THREAD_PROVIDER_LOCKED_CODE);
      expect(error.message).not.toContain(RELAY_MODEL);
      expect(fixture.official.stdin.read()).toBeNull();

      // The same Thread keeps working with its official model.
      writeRequest(fixture.desktopInput, {
        id: 23,
        method: "turn/start",
        params: { threadId: "loaded-official", input: [], model: "gpt-5.5" },
      });
      const official = await readJsonLine(fixture.official.stdin);
      expect(official).toMatchObject({ method: "turn/start", params: { model: "gpt-5.5" } });
      answer(fixture, official.id, { result: { turn: { id: "turn-2", status: "inProgress" } } });
      await fixture.collector.waitFor((message) => requestId(message, 23));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("continues a refused Thread in a new Codex Thread on the relay model", async () => {
    const fixture = createFixture();
    let done = false;
    const seen: JsonObject[] = [];
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 61,
        method: "thread/resume",
        params: { threadId: "pay-old" },
      });
      const resume = await readJsonLine(fixture.official.stdin);
      answer(fixture, resume.id, resumed("pay-old", "gpt-5.5", "openai"));
      await fixture.collector.waitFor((message) => requestId(message, 61));
      const refused = await desktop(fixture, 62, "turn/start", relayTurn("pay-old"));
      expect(refused).toHaveProperty("error");

      const responder = (async () => {
        while (!done) {
          let request: JsonObject;
          try {
            request = await readJsonLine(fixture.official.stdin, 200);
          } catch {
            continue;
          }
          seen.push(request);
          const params = (request.params ?? {}) as JsonObject;
          if (request.method === "thread/read") {
            answer(fixture, request.id, {
              result: {
                thread: {
                  id: String(params.threadId),
                  cwd: "/synthetic",
                  modelProvider: "openai",
                  status: { type: "idle" },
                  turns: [
                    {
                      id: "t1",
                      status: "completed",
                      items: [
                        {
                          type: "userMessage",
                          id: "u1",
                          content: [{ type: "text", text: "做支付" }],
                        },
                        { type: "agentMessage", id: "a1", text: "好的，先建订单表" },
                      ],
                    },
                  ],
                },
              },
            });
          } else if (request.method === "thread/start") {
            answer(fixture, request.id, resumed("pay-continued", RELAY_MODEL, "rly0"));
          } else if (request.method === "turn/start") {
            answer(fixture, request.id, { result: { turn: { id: "ct1", status: "inProgress" } } });
          } else {
            answer(fixture, request.id, { result: {} });
          }
        }
      })();
      const handoff = await desktop(fixture, 63, "codexhost/thread/handoff", {
        threadId: "pay-old",
        targetHarnessId: "codex",
        requestId: "click-relay-0001",
        followUp: "继续",
      });
      done = true;
      await responder;
      expect(handoff).toMatchObject({ result: { threadId: "pay-continued", mode: "created" } });
      expect(seen.find((request) => request.method === "thread/start")).toMatchObject({
        params: {
          model: RELAY_MODEL,
          modelProvider: "rly0",
          config: { "model_providers.rly0": { base_url: "http://127.0.0.1:25917/v1" } },
        },
      });
      expect(seen.find((request) => request.method === "turn/start")).toMatchObject({
        params: {
          threadId: "pay-continued",
          model: RELAY_MODEL,
          input: [{ type: "text", text: expect.stringContaining("继续") }],
        },
      });
    } finally {
      done = true;
      await stopFixture(fixture);
    }
  });

  it("a later turn without a model still counts the relay choice from thread/settings/update", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 31,
        method: "thread/resume",
        params: { threadId: "settings-thread" },
      });
      const resume = await readJsonLine(fixture.official.stdin);
      answer(fixture, resume.id, resumed("settings-thread", "gpt-5.5", "openai"));
      await fixture.collector.waitFor((message) => requestId(message, 31));
      writeRequest(fixture.desktopInput, {
        id: 32,
        method: "thread/settings/update",
        params: { threadId: "settings-thread", model: RELAY_MODEL },
      });
      const update = await readJsonLine(fixture.official.stdin);
      answer(fixture, update.id, { result: {} });
      await fixture.collector.waitFor((message) => requestId(message, 32));
      const refused = await desktop(fixture, 33, "turn/start", {
        threadId: "settings-thread",
        input: [],
      });
      expect((refused.error as JsonObject).message).toContain(RLY0_THREAD_PROVIDER_LOCKED_CODE);
      expect(fixture.official.stdin.read()).toBeNull();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("switching back to an official model with no-account off resumes on the original provider", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 41,
        method: "thread/resume",
        params: { threadId: "moved-thread", model: "gpt-5.5" },
      });
      await answerStoredThread(fixture, "moved-thread", "rly0");
      const resume = await readJsonLine(fixture.official.stdin);
      expect(resume).toMatchObject({
        method: "thread/resume",
        params: { threadId: "moved-thread", model: "gpt-5.5", modelProvider: "openai" },
      });
      answer(fixture, resume.id, resumed("moved-thread", "gpt-5.5", "openai"));
      expect(await fixture.collector.waitFor((message) => requestId(message, 41))).toHaveProperty(
        "result",
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it("leaves new Threads alone: relay start on rly0, official start untouched, no thread/read", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 51,
        method: "thread/start",
        params: { model: RELAY_MODEL, cwd: "/synthetic" },
      });
      const relayStart = await readJsonLine(fixture.official.stdin);
      expect(relayStart).toMatchObject({
        method: "thread/start",
        params: { model: RELAY_MODEL, modelProvider: "rly0" },
      });
      answer(fixture, relayStart.id, resumed("new-relay", RELAY_MODEL, "rly0"));
      await fixture.collector.waitFor((message) => requestId(message, 51));

      writeRequest(fixture.desktopInput, {
        id: 52,
        method: "thread/start",
        params: { model: "gpt-5.5", cwd: "/synthetic" },
      });
      const officialStart = await readJsonLine(fixture.official.stdin);
      expect(officialStart).toMatchObject({ method: "thread/start", params: { model: "gpt-5.5" } });
      expect((officialStart.params as JsonObject).modelProvider).toBeUndefined();
      answer(fixture, officialStart.id, resumed("new-official", "gpt-5.5", "openai"));
      await fixture.collector.waitFor((message) => requestId(message, 52));

      writeRequest(fixture.desktopInput, {
        id: 53,
        method: "turn/start",
        params: relayTurn("new-relay"),
      });
      const turn = await readJsonLine(fixture.official.stdin);
      expect(turn).toMatchObject({ method: "turn/start", params: { threadId: "new-relay" } });
      answer(fixture, turn.id, { result: { turn: { id: "turn-3", status: "inProgress" } } });
      await fixture.collector.waitFor((message) => requestId(message, 53));
    } finally {
      await stopFixture(fixture);
    }
  });
});
