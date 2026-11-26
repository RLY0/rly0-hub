import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_STATUS_FILE,
  requestAgentCheck,
} from "../src/rly0-maintenance/backend-reload-channel.js";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";

// The Host skips a request left from before it started; give its 2 s check one empty look first.
const settle = () => new Promise((resolve) => setTimeout(resolve, 2_500));

describe("AppServerHost answering the Hub's connection check", () => {
  it("answers from the Host that runs the agents", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      await settle();
      const report = await requestAgentCheck(fixture.mappingStoreDirectory, {
        timeoutMs: 8_000,
        pollMs: 100,
      });
      expect(report).not.toBeNull();
    } finally {
      await stopFixture(fixture);
    }
  }, 20_000);

  it("stays silent in a Desktop-side Host that hands Threads to the shared Host", async () => {
    const bridge = new SharedThreadBridge({
      connect: async () => null,
      delegateCreates: true,
      diagnose: () => {},
    });
    const fixture = createFixture({ sharedThreads: bridge });
    try {
      await fixture.ready;
      await settle();
      // Its empty report used to arrive before the shared Host's real one and win.
      const report = await requestAgentCheck(fixture.mappingStoreDirectory, {
        timeoutMs: 4_500,
        pollMs: 100,
      });
      expect(report).toBeNull();
      await expect(
        fs.access(path.join(fixture.mappingStoreDirectory, AGENT_STATUS_FILE)),
      ).rejects.toThrow();
    } finally {
      await stopFixture(fixture);
    }
  }, 20_000);
});
