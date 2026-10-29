import { afterEach, describe, expect, it, vi } from "vitest";

import {
  reconcileComposerNativeControls,
  type ComposerAgentControl,
} from "../src/renderer-composer-dom.js";

class NativeElement {
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  className = "";
  mutations = 0;

  get hidden(): boolean {
    return this.attributes.has("hidden");
  }
  set hidden(value: boolean) {
    if (value) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    this.mutations += 1;
  }
  removeAttribute(name: string): void {
    if (this.attributes.delete(name)) this.mutations += 1;
  }
  matches(selector: string): boolean {
    return selector === 'button[aria-haspopup="menu"]';
  }
  closest(): null {
    return null;
  }
  contains(): boolean {
    return false;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("Native Composer control reconciliation stability", () => {
  it.each([
    { hidden: false, ariaHidden: "false" },
    { hidden: true, ariaHidden: null },
  ])("does not retrigger attribute observers for stable $hidden/$ariaHidden", (baseline) => {
    vi.stubGlobal("HTMLElement", NativeElement);
    vi.stubGlobal("document", { activeElement: null });
    const model = new NativeElement();
    model.setAttribute("data-codex-intelligence-trigger", "true");
    model.setAttribute("data-composer-navigation-target", "reasoning");
    model.hidden = baseline.hidden;
    if (baseline.ariaHidden !== null) model.setAttribute("aria-hidden", baseline.ariaHidden);
    // No native request surface (CodexHost 0.15.0 suspends controls while one is open).
    const composer = {
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === 'button[aria-haspopup="menu"]' ? [model] : [],
    } as unknown as Element;
    const control = {
      composer,
      composerId: "synthetic-stability",
      nativeModelControl: { element: model, ...baseline },
      nativeContextUsageControl: null,
      nativePermissionModeControl: null,
      modelPicker: { trigger: new NativeElement(), root: { parentElement: null } },
      usage: { anchor: null, root: { remove: vi.fn() } },
      credits: { anchor: null, root: { remove: vi.fn() } },
    } as unknown as ComposerAgentControl;

    model.mutations = 0;
    for (let scan = 0; scan < 5; scan += 1) {
      reconcileComposerNativeControls(control, false, false);
    }
    expect(model.mutations).toBe(0);

    // A real native visibility change must still be restored before becoming stable.
    model.hidden = !baseline.hidden;
    model.setAttribute("aria-hidden", "changed");
    reconcileComposerNativeControls(control, false, false);
    expect(model.hidden).toBe(baseline.hidden);
    expect(model.getAttribute("aria-hidden")).toBe(baseline.ariaHidden);
    model.mutations = 0;
    reconcileComposerNativeControls(control, false, false);
    expect(model.mutations).toBe(0);
  });
});
