import {
  harnessModelCatalogSchema,
  harnessPermissionModeCatalogSchema,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  RLY0_AGENT_DEFAULTS_STORAGE_KEY,
  newThreadPermissionModeDefault,
  readHubAgentDefaults,
  withHubModelDefaults,
  writeHubAgentDefaults,
} from "../src/renderer-agent-defaults.js";

const catalog = harnessModelCatalogSchema.parse({
  models: [
    { ref: { id: "opus" }, label: "Opus", supportedThinkingOptionIds: ["auto", "medium", "high"] },
    { ref: { id: "haiku" }, label: "Haiku", supportedThinkingOptionIds: ["auto"] },
  ],
  defaultModel: { id: "opus" },
  thinkingOptions: [
    { id: "auto", label: "Auto" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
  defaultThinkingOptionId: "auto",
});
const claudeModes = harnessPermissionModeCatalogSchema.parse({
  defaultModeId: "default",
  modes: [
    { id: "plan", label: "Plan" },
    { id: "default", label: "Default" },
    { id: "bypassPermissions", label: "Bypass permissions", dangerous: true },
  ],
});
const rootModes = harnessPermissionModeCatalogSchema.parse({
  defaultModeId: "default",
  modes: [
    { id: "plan", label: "Plan" },
    { id: "default", label: "Default" },
  ],
});
const model = (id: string) => ({ id }) as HarnessModelRef;
const thinking = (id: string) => id as HarnessThinkingOptionId;
const mode = (id: string) => id as HarnessPermissionModeId;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("Hub new-Thread defaults in the renderer", () => {
  it("stores the Hub's defaults and reads one Agent's entry for local Threads only", () => {
    const storage = memoryStorage();
    writeHubAgentDefaults(storage, {
      "claude-code": { permissionModeId: mode("plan"), model: model("haiku") },
      opencode: { model: model("gpt-5.5") },
    });
    expect(JSON.parse(storage.values.get(RLY0_AGENT_DEFAULTS_STORAGE_KEY) ?? "{}")).toHaveProperty(
      "opencode",
    );
    expect(readHubAgentDefaults("claude-code", "local", storage)).toEqual({
      permissionModeId: "plan",
      model: { id: "haiku" },
    });
    expect(readHubAgentDefaults("grok", "local", storage)).toBeUndefined();
    // The Hub configures this computer; a remote Host keeps its own remembered choices.
    expect(readHubAgentDefaults("claude-code", "remote-host", storage)).toBeUndefined();
    expect(readHubAgentDefaults("claude-code", null, storage)).toBeUndefined();
  });

  it("ignores a broken or malformed stored value instead of failing the draft", () => {
    const storage = memoryStorage();
    storage.values.set(RLY0_AGENT_DEFAULTS_STORAGE_KEY, "{ not json");
    expect(readHubAgentDefaults("claude-code", "local", storage)).toBeUndefined();
    storage.values.set(
      RLY0_AGENT_DEFAULTS_STORAGE_KEY,
      JSON.stringify({ "claude-code": { model: { id: "bad id with spaces" } } }),
    );
    expect(readHubAgentDefaults("claude-code", "local", storage)).toBeUndefined();
    expect(readHubAgentDefaults("claude-code", "local", null)).toBeUndefined();
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readHubAgentDefaults("claude-code", "local", throwing)).toBeUndefined();
    expect(() => writeHubAgentDefaults(throwing, {})).not.toThrow();
  });

  it("puts the Hub Model and Thinking over the remembered choice", () => {
    const remembered = {
      model: model("haiku"),
      thinkingOptionId: thinking("auto"),
      permissionModeId: mode("plan"),
    };
    expect(
      withHubModelDefaults(
        catalog,
        { model: model("opus"), thinkingOptionId: thinking("high") },
        remembered,
      ),
    ).toEqual({ model: { id: "opus" }, thinkingOptionId: "high", permissionModeId: "plan" });
  });

  it("keeps the remembered choice, then the Agent default, for each unset field", () => {
    const remembered = { model: model("opus"), thinkingOptionId: thinking("medium") };
    expect(withHubModelDefaults(catalog, undefined, remembered)).toBe(remembered);
    expect(withHubModelDefaults(catalog, {}, remembered)).toEqual(remembered);
    // Only Thinking set: the remembered Model stays.
    expect(
      withHubModelDefaults(catalog, { thinkingOptionId: thinking("high") }, remembered),
    ).toEqual({ model: { id: "opus" }, thinkingOptionId: "high" });
    // Nothing remembered: the Agent's own default Model is the target for the Hub Thinking.
    expect(
      withHubModelDefaults(catalog, { thinkingOptionId: thinking("high") }, undefined),
    ).toEqual({ thinkingOptionId: "high" });
    expect(withHubModelDefaults(catalog, {}, undefined)).toBeUndefined();
  });

  it("falls back when a Hub value is no longer in the catalog", () => {
    const remembered = { model: model("opus"), thinkingOptionId: thinking("medium") };
    expect(
      withHubModelDefaults(
        catalog,
        { model: model("retired-model"), thinkingOptionId: thinking("ultra") },
        remembered,
      ),
    ).toEqual(remembered);
    expect(
      withHubModelDefaults(catalog, { model: model("retired-model") }, undefined),
    ).toBeUndefined();
    // Haiku offers only Auto: the Hub's High and the remembered Medium are both dropped.
    expect(
      withHubModelDefaults(
        catalog,
        { model: model("haiku"), thinkingOptionId: thinking("high") },
        remembered,
      ),
    ).toEqual({ model: { id: "haiku" } });
  });

  it("starts a new Thread with the Hub permission default when the catalog lists it", () => {
    expect(
      newThreadPermissionModeDefault("claude-code", "local", claudeModes, {
        permissionModeId: mode("plan"),
      }),
    ).toBe("plan");
    expect(
      newThreadPermissionModeDefault("grok", "local", claudeModes, {
        permissionModeId: mode("default"),
      }),
    ).toBe("default");
  });

  it("keeps bypassed permissions for local Claude Code while no Hub default is set", () => {
    expect(newThreadPermissionModeDefault("claude-code", "local", claudeModes, undefined)).toBe(
      "bypassPermissions",
    );
    expect(newThreadPermissionModeDefault("claude-code", "local", claudeModes, {})).toBe(
      "bypassPermissions",
    );
    expect(
      newThreadPermissionModeDefault("claude-code", "local", claudeModes, {
        model: model("opus"),
      }),
    ).toBe("bypassPermissions");
    expect(newThreadPermissionModeDefault("grok", "local", claudeModes, undefined)).toBeUndefined();
    expect(
      newThreadPermissionModeDefault("claude-code", "remote", claudeModes, undefined),
    ).toBeUndefined();
    expect(newThreadPermissionModeDefault("claude-code", "local", rootModes, undefined)).toBe(
      undefined,
    );
  });

  it("returns no override for a stale Hub permission so the remembered choice applies", () => {
    // e.g. bypass chosen in the Hub, but this Claude Code runs as root without a sandbox.
    expect(
      newThreadPermissionModeDefault("claude-code", "local", rootModes, {
        permissionModeId: mode("bypassPermissions"),
      }),
    ).toBeUndefined();
    expect(
      newThreadPermissionModeDefault("claude-code", "local", undefined, {
        permissionModeId: mode("plan"),
      }),
    ).toBeUndefined();
  });
});
