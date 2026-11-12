import { describe, expect, it, vi } from "vitest";
import {
  createScopedDraftModelWriter,
  findScopedDraftModelBinding,
} from "../src/renderer-scoped-draft-model.js";
import { isolateRendererPrewarmConsumption } from "../src/renderer-prewarm-consumption.js";

const draftId = "client-new-thread:synthetic-1106";

/** Synthetic 26.1106 memo tuples from the reviewed slot mapping, not a live Desktop capture. */
function fixture() {
  const original = { modelSettings: { model: "gpt-native" }, isManuallyChanged: false };
  let draft: Record<string, unknown> = original;
  const update = vi.fn((updater: (current: typeof draft) => typeof draft) => {
    draft = updater(draft);
  });
  const draftRow = Object.assign(Array<unknown>(14).fill(null), {
    6: draftId,
    7: draftId,
    9: update,
    10: draft,
    11: true,
    12: update,
    13: { draftSettings: draft, isNewThreadDraft: true, updateDraftSettings: update },
  });
  const context = { usesAccountPreferences: true };
  const setModel = vi.fn();
  const modelSettings = { model: "gpt-native", reasoningEffort: "medium" };
  const modelRow = Object.assign(Array<unknown>(25).fill(null), {
    7: null,
    11: true,
    13: context,
    14: update,
    15: setModel,
    21: setModel,
    22: context,
    24: { ...context, modelSettings, setModelAndReasoningEffort: setModel },
  });
  const settings = { model: modelSettings.model, reasoning_effort: modelSettings.reasoningEffort };
  const activeMode = { mode: "default", settings };
  const collaboration = Object.assign(Array<unknown>(55).fill(null), {
    42: modelSettings.model,
    43: modelSettings.reasoningEffort,
    44: settings,
    47: activeMode,
    52: activeMode,
    54: { activeMode },
  });
  const data = [collaboration, modelRow, draftRow];
  const element = {
    parentElement: null,
    __reactFiber$synthetic: { updateQueue: { memoCache: { data } } },
  };
  return {
    element,
    modelRow,
    collaboration,
    data,
    activeMode,
    update,
    setModel,
    original,
    draft: () => draft,
  };
}

describe("26.1106 draft-scoped model binding", () => {
  it("binds the 25-slot model hook to the unchanged 14-slot draft identity", () => {
    const f = fixture();
    f.data.shift(); // Isolate the Model hook from collaboration-mode recognition.
    expect(findScopedDraftModelBinding(f.element, draftId)).toEqual({
      update: f.update,
      usesAccountPreferences: true,
    });
  });

  it("recognizes the 55-slot collaboration tuple independently of the new Model layout", () => {
    const f = fixture();
    f.modelRow.splice(8, 1); // Reviewed 24-slot Model layout, with the inserted slot removed.
    expect(findScopedDraftModelBinding(f.element, draftId)?.creationModes).toEqual([f.activeMode]);
  });

  it("selects an external Agent in a 25/55-slot draft and routes background creation", async () => {
    const f = fixture();
    const binding = findScopedDraftModelBinding(f.element, draftId);
    expect(binding).not.toBeNull();
    if (!binding) throw new Error("Synthetic 26.1106 draft binding unavailable");
    const writer = createScopedDraftModelWriter();
    writer.apply(draftId, binding, "codexhost/claude-code-native");
    expect(f.draft()).toMatchObject({
      modelSettings: { model: "codexhost/claude-code-native", usesAccountPreferences: true },
      modelSettingsPersistAsDefault: false,
    });
    expect(f.setModel).not.toHaveBeenCalled();
    const manager = {
      threadCreation: {
        params: {
          prewarmedThreadManager: {
            hasPrewarmedThread: () => false,
            consumePrewarmedThread: async () => null,
            deletePrewarmedThread: vi.fn(),
          },
        },
        createConversation: vi.fn(),
      },
      startConversation: vi.fn<(input: unknown, options: unknown) => Promise<unknown>>(
        async (input) => input,
      ),
    };
    const control = isolateRendererPrewarmConsumption(manager, vi.fn());
    expect(control).not.toBeNull();
    control?.selectDraft(draftId, "codexhost/claude-code-native", binding.creationModes);
    await expect(
      manager.startConversation(
        { collaborationMode: { ...f.activeMode, settings: { ...f.activeMode.settings } } },
        { clientThreadId: "client-new-thread:synthetic-background" },
      ),
    ).resolves.toMatchObject({
      collaborationMode: { settings: { model: "codexhost/claude-code-native" } },
    });
    control?.dispose();
    writer.dispose();
    expect(f.draft().modelSettings).toBe(f.original.modelSettings);
  });

  it.each([7, 11, 13, 14, 15, 21, 22, 24])(
    "rejects a 25-slot Model row whose identity/settings check at slot %i disagrees",
    (slot) => {
      const f = fixture();
      f.modelRow[slot] = "synthetic mismatch";
      expect(findScopedDraftModelBinding(f.element, draftId)).toBeNull();
    },
  );

  it.each([42, 43, 44, 47, 52, 54])(
    "does not use a 55-slot collaboration tuple with a mismatched slot %i",
    (slot) => {
      const f = fixture();
      f.collaboration[slot] = "synthetic mismatch";
      expect(findScopedDraftModelBinding(f.element, draftId)?.creationModes).toBeUndefined();
    },
  );

  it("rejects unreviewed lengths and a different draft identity", () => {
    const f = fixture();
    expect(findScopedDraftModelBinding(f.element, "client-new-thread:other")).toBeNull();
    f.modelRow.push(null);
    expect(findScopedDraftModelBinding(f.element, draftId)).toBeNull();
    f.modelRow.pop();
    f.collaboration.pop();
    expect(findScopedDraftModelBinding(f.element, draftId)?.creationModes).toBeUndefined();
  });
});
