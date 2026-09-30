import { describe, expect, it, vi } from "vitest";

import { createRendererModelClient } from "../src/renderer-model-client.js";
import {
  RENDERER_RLY0_FORWARDED_METHODS,
  createRendererRly0Forwarders,
} from "../src/renderer-rly0-forwarding.js";

describe("RLY/0 forwarding through the adapter facade", () => {
  it("forwards every RLY/0 method the model client offers", () => {
    const client = createRendererModelClient([{ sendRequest: vi.fn() }]);
    if (!client) throw new Error("expected a model client");
    const offered = Object.keys(client).filter(
      (key) => /rly0/i.test(key) && typeof (client as Record<string, unknown>)[key] === "function",
    );
    expect(offered.length).toBeGreaterThan(0);
    expect([...RENDERER_RLY0_FORWARDED_METHODS].sort()).toEqual(offered.sort());
  });

  it("resolves the current client on each call", async () => {
    const sendRequest = vi.fn(async () => ({
      available: true,
      name: "rly0-core",
      version: "0.1.0",
      capabilities: ["accounts"],
    }));
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client) throw new Error("expected a model client");
    const current = vi.fn(() => client);
    const forwarders = createRendererRly0Forwarders(current);
    expect(current).not.toHaveBeenCalled();
    await expect(forwarders.rly0CoreStatus()).resolves.toMatchObject({ available: true });
    expect(current).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledWith("codexhost/rly0/core/status", {});
  });
});
