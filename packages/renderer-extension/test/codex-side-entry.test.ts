import { describe, expect, it, vi } from "vitest";
import { codexSideSettingsEntry } from "../src/settings/codex-side-entry.js";

function fixture() {
  const shell = {
    supported: true,
    registry: {
      getPage: (id: string) =>
        ["remote-connections", "usage-statistics"].includes(id) ? { label: id } : undefined,
    },
    openSettings: vi.fn(() => true),
  };
  const owner = { __codexhostSettingsShellV1: shell as typeof shell | undefined };
  return { shell, owner, window: owner as unknown as Window };
}
describe("Codex-side entry integration", () => {
  it("opens the requested page in the supplied window, including statistics navigation", () => {
    const f = fixture();
    expect(codexSideSettingsEntry("remote-connections", f.window)?.open()).toBe(true);
    expect(codexSideSettingsEntry("usage-statistics", f.window)?.open()).toBe(true);
    expect(f.shell.openSettings.mock.calls).toEqual([
      [undefined, "remote-connections"],
      [undefined, "usage-statistics"],
    ]);
  });
  it("reads the current shell after locale remount instead of retaining the old one", () => {
    const f = fixture();
    const entry = codexSideSettingsEntry("remote-connections", f.window);
    const current = { ...f.shell, openSettings: vi.fn(() => true) };
    f.owner.__codexhostSettingsShellV1 = current;
    expect(entry?.open()).toBe(true);
    expect(current.openSettings).toHaveBeenCalledOnce();
    expect(f.shell.openSettings).not.toHaveBeenCalled();
  });
  it("does not advertise unsupported pages or reactivate a disposed shell", () => {
    const f = fixture();
    f.shell.supported = false;
    expect(codexSideSettingsEntry("remote-connections", f.window)).toBeNull();
    f.shell.supported = true;
    const entry = codexSideSettingsEntry("remote-connections", f.window);
    f.owner.__codexhostSettingsShellV1 = undefined;
    expect(entry?.open()).toBe(false);
    expect(f.shell.openSettings).not.toHaveBeenCalled();
  });
});
