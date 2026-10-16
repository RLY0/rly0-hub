import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_RELAY_TOKEN,
  Rly0AgentRelaySettings,
  claudeCodeRelayEnvironment,
} from "../src/rly0-relay/agent-relays.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Claude Code through a relay", () => {
  it("points Claude Code at the local proxy pinned to the relay, without any real key", () => {
    const environment = claudeCodeRelayEnvironment(
      {
        PATH: "C:/bin",
        ANTHROPIC_API_KEY: "sk-ant-own-key",
        ANTHROPIC_AUTH_TOKEN: "own-token",
        ANTHROPIC_BASE_URL: "https://elsewhere.example",
      },
      "http://127.0.0.1:25917/v1",
      "relay-1",
    );
    expect(environment).toEqual({
      PATH: "C:/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:25917/r/relay-1",
      ANTHROPIC_AUTH_TOKEN: CLAUDE_CODE_RELAY_TOKEN,
    });
    expect(JSON.stringify(environment)).not.toContain("sk-ant-own-key");
  });

  it("stores the choice in RLY/0 Hub's data and ignores invalid ids", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-agent-relays-"));
    const settings = new Rly0AgentRelaySettings({ environment: { CODEXHOST_DATA_DIR: directory } });
    expect(await settings.get()).toEqual({ claudeCode: null });
    await settings.set({ claudeCode: "relay-1" });
    expect(await settings.get()).toEqual({ claudeCode: "relay-1" });
    await fs.writeFile(settings.path(), JSON.stringify({ version: 1, claudeCode: "../evil" }));
    expect(await settings.get()).toEqual({ claudeCode: null });
    await settings.set({ claudeCode: null });
    expect(await settings.get()).toEqual({ claudeCode: null });
  });
});
