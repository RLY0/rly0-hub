import { afterEach, describe, expect, it, vi } from "vitest";
import { Rly0CoreBridge } from "../src/rly0-core/index.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

afterEach(() => vi.restoreAllMocks());
describe("SYNTHETIC relay selector failure boundary", () => {
  it("never forwards unavailable selectors to the official runtime", async () => {
    vi.spyOn(Rly0CoreBridge.prototype, "listRelays").mockResolvedValue({
      available: true,
      relays: [],
    });
    const fixture = createFixture();
    try {
      await fixture.ready;
      for (const [id, method] of [
        [901, "turn/start"],
        [902, "thread/start"],
        [903, "thread/resume"],
      ] as const) {
        writeRequest(fixture.desktopInput, {
          id,
          method,
          params: {
            threadId: "synthetic-official",
            model: "rly0/aaaaaaaaaaaa/gpt-6.1-sol",
            input: [],
          },
        });
        expect(await fixture.collector.waitFor((message) => requestId(message, id))).toHaveProperty(
          "error",
        );
        expect(fixture.official.stdin.read()).toBeNull();
      }
    } finally {
      await stopFixture(fixture);
    }
  });
});
