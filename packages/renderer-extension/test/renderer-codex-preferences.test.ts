import { describe, expect, it, vi } from "vitest";

import {
  CODEX_PREFERENCES_APPLIED_STORAGE_KEY,
  applyCodexPreferences,
} from "../src/renderer-codex-preferences.js";
import { RLY0_AGENT_DEFAULTS_STORAGE_KEY } from "../src/renderer-agent-defaults.js";

function owner() {
  const store = new Map<string, string>();
  const setProperty = vi.fn();
  const events: string[] = [];
  const window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
    dispatchEvent: (event: Event) => {
      events.push(event.type);
      return true;
    },
    document: { documentElement: { style: { setProperty } } },
  } as unknown as Window;
  return { window, store, setProperty, events };
}

describe("Codex preferences set in the Hub window", () => {
  it("applies each field to the renderer's own settings once per Hub change", () => {
    const f = owner();
    const preferences = {
      updatedAt: 10,
      reasoningSoftWrap: true,
      accentColor: "blue" as const,
      quotaRefresh: "3m" as const,
      quotaAlert: { enabled: true, thresholdPercent: 15 },
      idleRelease: { enabled: false, timeoutMinutes: 60 },
    };
    expect(applyCodexPreferences(f.window, preferences)).toBe(true);
    expect(f.store.get("codexhost.reasoning-soft-wrap.v1")).toBe("true");
    expect(f.store.get("codexhost.rly0-accent.v1")).toBe("blue");
    expect(f.store.get("codexhost.rly0-quota-refresh.v1")).toBe("3m");
    expect(f.store.get("codexhost.rly0-quota-alert-enabled.v1")).toBe("true");
    expect(f.store.get("codexhost.rly0-quota-alert-threshold.v1")).toBe("15");
    expect(JSON.parse(f.store.get("codexhost.idle-release.v1") ?? "null")).toEqual({
      enabled: false,
      timeoutMinutes: 60,
    });
    expect(f.setProperty).toHaveBeenCalledWith("--codexhost-rly0-accent", expect.any(String));
    expect(f.store.get(CODEX_PREFERENCES_APPLIED_STORAGE_KEY)).toBe("10");

    // The same Hub change is not applied again, so a later change made in Codex sticks.
    f.store.set("codexhost.rly0-accent.v1", "rose");
    expect(applyCodexPreferences(f.window, preferences)).toBe(false);
    expect(f.store.get("codexhost.rly0-accent.v1")).toBe("rose");
    // Fields the Hub did not set stay as they are.
    expect(applyCodexPreferences(f.window, { updatedAt: 11, quotaRefresh: "30s" })).toBe(true);
    expect(f.store.get("codexhost.rly0-accent.v1")).toBe("rose");
    expect(f.store.get("codexhost.rly0-quota-refresh.v1")).toBe("30s");
    expect(applyCodexPreferences(f.window, null)).toBe(false);
  });

  it("copies the Hub's new-Thread defaults whole, so a cleared Agent disappears", () => {
    const f = owner();
    const first = {
      updatedAt: 20,
      agentDefaults: {
        "claude-code": { permissionModeId: "plan", model: { id: "opus" } },
        opencode: { model: { id: "gpt-5.5" } },
      },
    } as never;
    expect(applyCodexPreferences(f.window, first)).toBe(true);
    expect(JSON.parse(f.store.get(RLY0_AGENT_DEFAULTS_STORAGE_KEY) ?? "null")).toEqual({
      "claude-code": { permissionModeId: "plan", model: { id: "opus" } },
      opencode: { model: { id: "gpt-5.5" } },
    });
    const cleared = { updatedAt: 21, agentDefaults: { opencode: { model: { id: "gpt-5.5" } } } };
    expect(applyCodexPreferences(f.window, cleared as never)).toBe(true);
    expect(JSON.parse(f.store.get(RLY0_AGENT_DEFAULTS_STORAGE_KEY) ?? "null")).toEqual({
      opencode: { model: { id: "gpt-5.5" } },
    });
    // A later change without agentDefaults leaves them as they are.
    expect(applyCodexPreferences(f.window, { updatedAt: 22, quotaRefresh: "1m" })).toBe(true);
    expect(f.store.get(RLY0_AGENT_DEFAULTS_STORAGE_KEY)).toContain("opencode");
  });
});
