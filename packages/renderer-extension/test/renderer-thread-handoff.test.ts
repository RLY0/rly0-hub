import { describe, expect, it, vi } from "vitest";

import {
  rendererHandoffSupported,
  startRendererThreadHandoff,
} from "../src/renderer-thread-handoff.js";
import {
  RENDERER_NEW_THREAD_PREFERENCE_KEY,
  writeNewThreadExternalConfigurationPreference,
} from "../src/renderer-new-thread-preference.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const readyInspection = {
  status: "ready",
  capabilities: {},
  catalog: {
    models: [
      { ref: { id: "claude-sonnet" }, label: "Sonnet", supportedThinkingOptionIds: ["high"] },
    ],
    defaultModel: { id: "claude-sonnet" },
  },
  permissionModes: {
    modes: [{ id: "acceptEdits", label: "Accept edits" }],
    defaultModeId: "acceptEdits",
  },
} as never;

const result = {
  threadId: "new-thread",
  mode: "created",
  title: "↪ 修复登录 · 接力 Claude Code",
  carried: { turns: 2, includedTurns: 2, omittedTurns: 0, commands: 1, files: 1, truncated: false },
} as never;

describe("Renderer thread handoff", () => {
  it("requests a handoff with the remembered Agent configuration and opens the new Thread", async () => {
    const storage = memoryStorage();
    writeNewThreadExternalConfigurationPreference(
      "claude-code",
      { id: "claude-sonnet" } as never,
      "high" as never,
      "acceptEdits" as never,
      storage,
    );
    expect(storage.getItem(RENDERER_NEW_THREAD_PREFERENCE_KEY)).not.toBeNull();
    const handoffThread = vi.fn(async () => result);
    const inspectHarness = vi.fn(async () => readyInspection);
    const open = vi.fn(async () => undefined);
    await expect(
      startRendererThreadHandoff({
        client: { handoffThread, inspectHarness },
        threadId: "source-thread",
        hostId: "local",
        agent: "claude-code",
        open,
        requestId: "click-0001",
        storage,
      }),
    ).resolves.toBe(result);
    expect(handoffThread).toHaveBeenCalledWith({
      threadId: "source-thread",
      targetHarnessId: "claude-code",
      requestId: "click-0001",
      model: { id: "claude-sonnet" },
      thinkingOptionId: "high",
      permissionModeId: "acceptEdits",
    });
    expect(open).toHaveBeenCalledWith("new-thread");
  });

  it("falls back to the Agent's own default when its catalog is unavailable", async () => {
    const handoffThread = vi.fn(async () => result);
    await startRendererThreadHandoff({
      client: {
        handoffThread,
        inspectHarness: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
      threadId: "source-thread",
      hostId: "local",
      agent: "grok",
      open: async () => undefined,
      requestId: "click-0002",
      storage: memoryStorage(),
    });
    expect(handoffThread).toHaveBeenCalledWith({
      threadId: "source-thread",
      targetHarnessId: "grok",
      requestId: "click-0002",
    });
  });

  it("hands back to Codex without inspecting an external catalog", async () => {
    const inspectHarness = vi.fn();
    const handoffThread = vi.fn(async () => result);
    await startRendererThreadHandoff({
      client: { handoffThread, inspectHarness },
      threadId: "source-thread",
      hostId: "local",
      agent: "codex",
      open: async () => undefined,
      requestId: "click-0003",
      storage: memoryStorage(),
    });
    expect(inspectHarness).not.toHaveBeenCalled();
  });

  it("reports an older Host without the handoff method as unsupported", () => {
    expect(rendererHandoffSupported(null)).toBe(false);
    expect(rendererHandoffSupported({})).toBe(false);
    expect(rendererHandoffSupported({ handoffThread: async () => result })).toBe(true);
  });
});
