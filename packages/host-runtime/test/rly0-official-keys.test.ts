import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  keyFromAccountExport,
  officialVendorOf,
  Rly0OfficialKeyModels,
  RLY0_OFFICIAL_VENDORS,
} from "../src/rly0-relay/official-keys.js";

describe("official vendor API keys", () => {
  it("recognises each vendor's own API host only", () => {
    expect(officialVendorOf({ baseUrl: "https://api.openai.com/v1" })).toBe("openai");
    expect(officialVendorOf({ baseUrl: "https://api.anthropic.com" })).toBe("anthropic");
    expect(officialVendorOf({ baseUrl: RLY0_OFFICIAL_VENDORS.google.baseUrl })).toBe("google");
    expect(officialVendorOf({ baseUrl: "https://api.x.ai/v1" })).toBe("xai");
    expect(officialVendorOf({ baseUrl: "https://api.openai.com.evil.dev/v1" })).toBeNull();
    expect(officialVendorOf({ baseUrl: "https://api.rly0.com/v1" })).toBeNull();
    expect(RLY0_OFFICIAL_VENDORS.xai.pattern.test("xai-abcdefghijklmnopqrstuvwxyz")).toBe(true);
  });

  it("keeps vendor model lists apart from the relay entry", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-official-"));
    const store = new Rly0OfficialKeyModels({ CODEXHOST_DATA_DIR: directory });
    await store.set("google", ["models/gemini-2.5-pro", "models/gemini-2.5-flash", "bad id!"]);
    await store.set("xai", ["grok-4"]);
    expect(await store.read()).toEqual({
      google: ["gemini-2.5-pro", "gemini-2.5-flash"],
      xai: ["grok-4"],
    });
    // A vendor key's relay entry lists no models; agents get the official list instead.
    expect(await store.modelsFor({ baseUrl: "https://api.x.ai/v1", models: [] })).toEqual([
      "grok-4",
    ]);
    expect(
      await store.modelsFor({ baseUrl: "https://api.rly0.com/v1", models: ["gpt-5"] }),
    ).toEqual(["gpt-5"]);
    await store.set("xai", null);
    expect((await store.read()).xai).toBeUndefined();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("takes the vendor's key out of a Sub2API account export", () => {
    const exported = JSON.stringify({
      type: "sub2api-data",
      accounts: [
        { platform: "openai", credentials: { access_token: "eyJ" } },
        {
          platform: "gemini",
          type: "apikey",
          credentials: { api_key: "AIzaSyA-abcdefghijklmnopqrstuvwxyz012" },
        },
        { platform: "grok", credentials: { api_key: "xai-abcdefghijklmnopqrstuvwxyz" } },
      ],
    });
    expect(keyFromAccountExport(exported, "google")).toBe("AIzaSyA-abcdefghijklmnopqrstuvwxyz012");
    expect(keyFromAccountExport(exported, "xai")).toBe("xai-abcdefghijklmnopqrstuvwxyz");
    expect(() => keyFromAccountExport(exported, "anthropic")).toThrow("AUTH_FILE_NOT_A_LOGIN");
    expect(() => keyFromAccountExport("nope", "xai")).toThrow("AUTH_FILE_INVALID");
    expect(
      keyFromAccountExport(JSON.stringify({ api_key: "xai-abcdefghijklmnopqrstuvwxyz" }), "xai"),
    ).toBe("xai-abcdefghijklmnopqrstuvwxyz");
  });
});
