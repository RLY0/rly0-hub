import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";

import {
  CLAUDE_CODE_RELAY_TOKEN,
  Rly0AgentRelaySettings,
  claudeCodeRelayEnvironment,
  claudeCodeRelayQuotaBlock,
  hermesRelayEnvironment,
  opencodeRelayEnvironment,
  piRelayEnvironment,
  piRelayExtension,
  pinnedRelayUrl,
  withSessionEnvironment,
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

  it("names why a pinned Claude Code cannot report plan windows", () => {
    expect(claudeCodeRelayQuotaBlock({ baseUrl: "https://api.anthropic.com" })).toBe(
      "proxiedCredential",
    );
    expect(claudeCodeRelayQuotaBlock({ baseUrl: "https://API.Anthropic.com/v1" })).toBe(
      "proxiedCredential",
    );
    expect(claudeCodeRelayQuotaBlock({ baseUrl: "https://api.rly0.com/v1" })).toBe("relay");
    expect(claudeCodeRelayQuotaBlock({ baseUrl: "not a url" })).toBe("relay");
  });

  it("stores the choice in RLY/0 Hub's data and ignores invalid ids", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-agent-relays-"));
    const settings = new Rly0AgentRelaySettings({ environment: { CODEXHOST_DATA_DIR: directory } });
    expect(await settings.get()).toEqual({ claudeCode: null, agents: {} });
    await settings.set({ claudeCode: "relay-1" });
    expect(await settings.get()).toEqual({ claudeCode: "relay-1", agents: {} });
    await fs.writeFile(settings.path(), JSON.stringify({ version: 1, claudeCode: "../evil" }));
    expect(await settings.get()).toEqual({ claudeCode: null, agents: {} });
    await settings.set({ claudeCode: null });
    expect(await settings.get()).toEqual({ claudeCode: null, agents: {} });
  });

  it("keeps a relay and default model per third-party agent next to Claude Code's", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-agent-relays-"));
    const settings = new Rly0AgentRelaySettings({ environment: { CODEXHOST_DATA_DIR: directory } });
    await settings.set({ claudeCode: "relay-1" });
    await settings.setAgent("hermes", { relayId: "relay-2", model: "gpt-5.4" });
    await settings.setAgent("pi", { relayId: "relay-2", model: "bad model!" });
    expect(await settings.get()).toEqual({
      claudeCode: "relay-1",
      agents: {
        hermes: { relayId: "relay-2", model: "gpt-5.4" },
        pi: { relayId: "relay-2", model: null },
      },
    });
    await settings.set({ claudeCode: null });
    await settings.setAgent("pi", null);
    expect(await settings.get()).toEqual({
      claudeCode: null,
      agents: { hermes: { relayId: "relay-2", model: "gpt-5.4" } },
    });
  });

  it("builds each agent's relay environment around the local proxy", () => {
    const url = pinnedRelayUrl("http://127.0.0.1:25917/v1", "relay-2");
    expect(url).toBe("http://127.0.0.1:25917/r/relay-2/v1");
    const hermes = hermesRelayEnvironment({ PATH: "x" }, url, "gpt-5.4");
    expect(hermes).toMatchObject({
      PATH: "x",
      HERMES_IGNORE_USER_CONFIG: "1",
      HERMES_INFERENCE_PROVIDER: "custom",
      CUSTOM_BASE_URL: url,
      OPENAI_BASE_URL: url,
      HERMES_MODEL: "gpt-5.4",
    });
    const opencode = JSON.parse(
      opencodeRelayEnvironment({}, url, ["gpt-5.4", "claude-*"], "gpt-5.4")
        .OPENCODE_CONFIG_CONTENT!,
    );
    expect(opencode.model).toBe("rly0/gpt-5.4");
    expect(Object.keys(opencode.provider.rly0.models)).toEqual(["gpt-5.4"]);
    expect(opencode.provider.rly0.options.baseURL).toBe(url);
    const extension = piRelayExtension(url, ["gpt-5.4"]);
    expect(extension).toContain('pi.registerProvider("rly0"');
    expect(extension).toContain(url);
    expect(piRelayEnvironment({}, "C:/x/pi.ts", "gpt-5.4")).toMatchObject({
      RLY0_PI_EXTENSION: "C:/x/pi.ts",
      RLY0_PI_MODEL: "gpt-5.4",
    });
  });

  it("puts the relay into every session's own environment, which replaces the adapter's", async () => {
    const fake = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const seen: (Record<string, string | undefined> | undefined)[] = [];
    const original = fake.open.bind(fake);
    fake.open = async (input) => {
      seen.push(input.environment);
      return original(input);
    };
    const adapter: HarnessAdapter = withSessionEnvironment(fake, (environment) =>
      claudeCodeRelayEnvironment(environment, "http://127.0.0.1:25917/v1", "relay-1"),
    );
    // The Host passes its own environment, without the relay and with the person's own key.
    await adapter.open({
      kind: "create",
      cwd: "/work",
      environment: {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk-ant-own",
        CODEXHOST_DELEGATION_THREAD_ID: "t1",
      },
    });
    expect(seen[0]).toEqual({
      PATH: "/bin",
      CODEXHOST_DELEGATION_THREAD_ID: "t1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:25917/r/relay-1",
      ANTHROPIC_AUTH_TOKEN: CLAUDE_CODE_RELAY_TOKEN,
    });
    // Without a per-session environment the adapter keeps its own (already relay-aware) one.
    await adapter.open({ kind: "create", cwd: "/work" });
    expect(seen[1]).toBeUndefined();
    // Everything else still reaches the adapter.
    expect(adapter.harnessId).toBe("claude-code");
    await adapter.inspect();
    expect(fake.inspectionCalls).toBe(1);
  });
});
