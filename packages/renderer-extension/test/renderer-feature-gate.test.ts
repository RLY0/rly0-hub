import { afterEach, expect, it, vi } from "vitest";
import { installRendererFeature } from "../src/renderer-feature-gate.js";
import type { CodexRendererPolicy } from "@codexhost/shared-contracts";
const state = globalThis as typeof globalThis & {
  __codexhostFeaturePolicyV1?: CodexRendererPolicy;
  __codexhostFeatureFailuresV1?: string[];
};
afterEach(() => {
  delete state.__codexhostFeaturePolicyV1;
  delete state.__codexhostFeatureFailuresV1;
});
it("isolates a failed feature and still installs its sibling", () => {
  const sibling = vi.fn(() => "installed");
  expect(
    installRendererFeature(
      "settings",
      () => {
        throw new Error("synthetic unsupported DOM");
      },
      () => "disabled",
    ),
  ).toBe("disabled");
  expect(installRendererFeature("sidebar-icons", sibling, () => "disabled")).toBe("installed");
  expect(state.__codexhostFeatureFailuresV1).toEqual(["settings"]);
  expect(sibling).toHaveBeenCalledOnce();
});
it("never invokes a remotely disabled installer", () => {
  state.__codexhostFeaturePolicyV1 = { schemaVersion: 1, mode: "full", disabled: ["questions"] };
  const installer = vi.fn(() => true);
  expect(installRendererFeature("questions", installer, () => false)).toBe(false);
  expect(installer).not.toHaveBeenCalled();
});
it("core mode only permits passive usage; safe permits no feature", () => {
  state.__codexhostFeaturePolicyV1 = { schemaVersion: 1, mode: "core", disabled: [] };
  expect(
    installRendererFeature(
      "usage",
      () => true,
      () => false,
    ),
  ).toBe(true);
  expect(
    installRendererFeature(
      "composer",
      () => true,
      () => false,
    ),
  ).toBe(false);
  state.__codexhostFeaturePolicyV1.mode = "safe";
  expect(
    installRendererFeature(
      "usage",
      () => true,
      () => false,
    ),
  ).toBe(false);
});
