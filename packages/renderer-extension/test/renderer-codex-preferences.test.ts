import { describe, expect, it, vi } from "vitest";
import {
  harnessPreferenceSnapshotSchema,
  type HarnessPreferencePatch,
} from "@codexhost/shared-contracts";

import {
  CODEX_PREFERENCES_APPLIED_STORAGE_KEY,
  applyCodexPreferences,
} from "../src/renderer-codex-preferences.js";
import {
  installRendererHarnessPreferenceSync,
  rendererHarnessPreferenceStatus,
} from "../src/renderer-harness-preferences.js";
import type { RendererModelClient } from "../src/renderer-model-client.js";

function owner() {
  const store = new Map<string, string>();
  const setProperty = vi.fn();
  const events: string[] = [];
  const target = new EventTarget();
  const documentTarget = new EventTarget();
  const window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: (event: Event) => {
      events.push(event.type);
      return target.dispatchEvent(event);
    },
    document: {
      documentElement: { style: { setProperty } },
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
    },
  } as unknown as Window;
  return { window, store, setProperty, events };
}

describe("Codex preferences set in the Hub window", () => {
  it("applies each field and confirms the Host idle policy once per Hub change", async () => {
    const f = owner();
    let snapshot = harnessPreferenceSnapshotSchema.parse({
      scope: "external",
      revision: 0,
      values: {},
    });
    const patch = vi.fn(async (input: HarnessPreferencePatch) => {
      for (const operation of input.operations) {
        if (operation.kind === "idleRelease")
          snapshot = {
            ...snapshot,
            revision: snapshot.revision + 1,
            values: { ...snapshot.values, idleRelease: operation.value },
          };
      }
      return snapshot;
    });
    const sync = installRendererHarnessPreferenceSync(f.window);
    sync.connect("local", {
      getHarnessPreferences: async () => snapshot,
      patchHarnessPreferences: patch,
    } as unknown as RendererModelClient);
    try {
      await vi.waitFor(() => expect(rendererHarnessPreferenceStatus()).toBe("applied"));
      const preferences = {
        updatedAt: 10,
        reasoningSoftWrap: true,
        accentColor: "blue" as const,
        quotaRefresh: "3m" as const,
        quotaAlert: { enabled: true, thresholdPercent: 15 },
        idleRelease: { enabled: false, timeoutMinutes: 60 },
      };
      expect(await applyCodexPreferences(f.window, preferences)).toBe(true);
      expect(f.store.get("codexhost.reasoning-soft-wrap.v1")).toBe("true");
      expect(f.store.get("codexhost.rly0-accent.v1")).toBe("blue");
      expect(f.store.get("codexhost.rly0-quota-refresh.v1")).toBe("3m");
      expect(f.store.get("codexhost.rly0-quota-alert-enabled.v1")).toBe("true");
      expect(f.store.get("codexhost.rly0-quota-alert-threshold.v1")).toBe("15");
      expect(snapshot.values.idleRelease).toEqual({
        enabled: false,
        timeoutMinutes: 60,
      });
      expect(patch).toHaveBeenCalledOnce();
      expect(f.setProperty).toHaveBeenCalledWith("--codexhost-rly0-accent", expect.any(String));
      expect(f.store.get(CODEX_PREFERENCES_APPLIED_STORAGE_KEY)).toBe("10");

      // The same Hub change is not applied again, so a later change made in Codex sticks.
      f.store.set("codexhost.rly0-accent.v1", "rose");
      expect(await applyCodexPreferences(f.window, preferences)).toBe(false);
      expect(patch).toHaveBeenCalledOnce();
      expect(f.store.get("codexhost.rly0-accent.v1")).toBe("rose");
      // Fields the Hub did not set stay as they are.
      expect(await applyCodexPreferences(f.window, { updatedAt: 11, quotaRefresh: "30s" })).toBe(
        true,
      );
      expect(f.store.get("codexhost.rly0-accent.v1")).toBe("rose");
      expect(f.store.get("codexhost.rly0-quota-refresh.v1")).toBe("30s");
      expect(await applyCodexPreferences(f.window, null)).toBe(false);
    } finally {
      sync.dispose();
    }
  });

  it("leaves the change retryable when the Host cannot confirm the idle policy", async () => {
    const f = owner();
    expect(
      await applyCodexPreferences(f.window, {
        updatedAt: 12,
        idleRelease: { enabled: false, timeoutMinutes: 60 },
      }),
    ).toBe(false);
    expect(f.store.has(CODEX_PREFERENCES_APPLIED_STORAGE_KEY)).toBe(false);
  });
});
