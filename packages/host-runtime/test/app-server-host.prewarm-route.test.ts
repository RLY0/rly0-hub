import { describe, expect, it } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
  hostThreadIdSchema,
  THREAD_PREWARM_DISCARD_METHOD,
} from "@codexhost/shared-contracts";
import {
  JsonLineCollector,
  completePiTurn,
  createFixture,
  requiredMessageId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;

const MISMATCH = /DRAFT_ROUTE_MISMATCH/u;

/** Collect official traffic and answer every request with an empty page. */
function officialTraffic(f: Fixture): JsonObject[] {
  const official = new JsonLineCollector(f.official.stdin);
  const seen: JsonObject[] = [];
  f.official.stdin.on("data", () => {
    for (const request of official.messages.splice(0)) {
      seen.push(request);
      writeRequest(f.official.stdout, {
        id: requiredMessageId(request),
        result: { data: [], nextCursor: null, backwardsCursor: null },
      });
    }
  });
  return seen;
}

/** Desktop names the Turn's Model in its collaboration mode, with no top-level Model. */
async function turnWithMode(f: Fixture, id: number, threadId: string, model: string) {
  writeRequest(f.desktopInput, {
    id,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: "synthetic" }],
      collaborationMode: { mode: "default", settings: { model } },
    },
  });
  return f.collector.waitFor((message) => message.id === id);
}

function turnStarts(f: Fixture, threadId: string) {
  return f.collector.messages.filter(
    (message) =>
      message.method === "turn/started" && (message.params as JsonObject)?.threadId === threadId,
  );
}

describe("route of the first Turn on a shared Desktop prewarm", () => {
  it("refuses another Agent's carrier and keeps the prewarm discardable", async () => {
    const f = createFixture();
    officialTraffic(f);
    try {
      const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
        codexhostPrewarm: true,
      });
      const claude = encodeHarnessPluginRoute(
        harnessPluginRouteSchema.parse({ harnessId: "claude-code", model: { id: "synthetic" } }),
      );
      const refused = await turnWithMode(f, 2, threadId, claude);
      expect(refused).toMatchObject({
        error: { code: -32602, message: expect.stringMatching(MISMATCH) },
      });
      expect(turnStarts(f, threadId)).toEqual([]);
      expect(await f.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).toMatchObject({
        state: "creating",
        turnMappings: [],
      });

      // Nothing was submitted, so the owning draft can still discard it.
      writeRequest(f.desktopInput, {
        id: 3,
        method: THREAD_PREWARM_DISCARD_METHOD,
        params: { threadId },
      });
      const discarded = await f.collector.waitFor((message) => message.id === 3);
      expect(discarded).toMatchObject({ result: { discarded: true } });
      expect(await f.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).toBeNull();
    } finally {
      await stopFixture(f);
    }
  });

  it("refuses an undecodable carrier on an external prewarm", async () => {
    const f = createFixture();
    officialTraffic(f);
    try {
      const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
        codexhostPrewarm: true,
      });
      const refused = await turnWithMode(f, 2, threadId, "codexhost/plugin-v1@zz");
      expect(refused).toHaveProperty("error");
      expect(turnStarts(f, threadId)).toEqual([]);
    } finally {
      await stopFixture(f);
    }
  });

  it("accepts official Model names on a prewarm, as the legacy Composer sends them", async () => {
    const f = createFixture();
    officialTraffic(f);
    try {
      const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
        codexhostPrewarm: true,
      });
      // Older Desktop routes only `thread/start`; its first Turn keeps the native Model.
      const accepted = await turnWithMode(f, 2, threadId, "gpt-6.1-sol");
      expect(accepted).not.toHaveProperty("error");
      const own = await turnWithMode(f, 3, threadId, "codexhost/pi-native");
      expect(own).toHaveProperty("error"); // already running: the first Turn went through
    } finally {
      await stopFixture(f);
    }
  });

  it("keeps submitted external Threads on their existing Turn handling", async () => {
    const f = createFixture();
    officialTraffic(f);
    try {
      const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
        codexhostPrewarm: true,
      });
      await completePiTurn(f, threadId, 2);
      // Not a prewarm any more: an official name in the mode is ignored, as before.
      const next = await turnWithMode(f, 3, threadId, "gpt-6.1-sol");
      expect(next).not.toHaveProperty("error");
    } finally {
      await stopFixture(f);
    }
  });

  it("does not forward an External Harness carrier to an official Thread", async () => {
    const f = createFixture();
    const official = officialTraffic(f);
    await f.ready;
    try {
      const refused = await turnWithMode(f, 2, "official-native-prewarm", "codexhost/pi-native");
      expect(refused).toMatchObject({
        error: { code: -32602, message: expect.stringMatching(MISMATCH) },
      });
      expect(official.some((request) => request.method === "turn/start")).toBe(false);

      // Official Models on official Threads are forwarded unchanged.
      writeRequest(f.desktopInput, {
        id: 3,
        method: "turn/start",
        params: {
          threadId: "official-native-prewarm",
          input: [{ type: "text", text: "synthetic" }],
          collaborationMode: { mode: "default", settings: { model: "gpt-6.1-sol" } },
        },
      });
      await expect
        .poll(() => official.some((request) => request.method === "turn/start"))
        .toBe(true);
    } finally {
      await stopFixture(f);
    }
  });
});
