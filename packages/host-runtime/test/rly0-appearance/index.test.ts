import { describe, expect, it } from "vitest";

import { Rly0AppearanceManager } from "../../src/rly0-appearance/index.js";
import type { Rly0AutostartRegistry } from "../../src/rly0-appearance/autostart-registry.js";

class FakeRegistry implements Rly0AutostartRegistry {
  value: string | null = null;
  getCalls = 0;
  setCalls: string[] = [];
  removeCalls = 0;

  async get(): Promise<string | null> {
    this.getCalls += 1;
    return this.value;
  }

  async set(command: string): Promise<void> {
    this.setCalls.push(command);
    this.value = command;
  }

  async remove(): Promise<void> {
    this.removeCalls += 1;
    this.value = null;
  }
}

describe("Rly0AppearanceManager", () => {
  it("reports unsupported on a non-Windows platform even with a registry injected", async () => {
    const registry = new FakeRegistry();
    const manager = new Rly0AppearanceManager({ registry, platform: "darwin" });
    expect(manager.supported).toBe(false);
    expect(await manager.autostartStatus()).toEqual({ supported: false, enabled: false });
    expect(await manager.setAutostart(true)).toEqual({ supported: false, enabled: false });
    expect(registry.setCalls).toHaveLength(0);
  });

  it("reports unsupported on Windows when no registry implementation is wired up", async () => {
    const manager = new Rly0AppearanceManager({ platform: "win32" });
    expect(manager.supported).toBe(false);
    expect(await manager.autostartStatus()).toEqual({ supported: false, enabled: false });
  });

  it("reflects the fake registry's current value on Windows", async () => {
    const registry = new FakeRegistry();
    const manager = new Rly0AppearanceManager({
      registry,
      platform: "win32",
      launcherCommand: '"C:\\rly0-hub.exe"',
    });
    expect(await manager.autostartStatus()).toEqual({ supported: true, enabled: false });

    const enabled = await manager.setAutostart(true);
    expect(enabled).toEqual({ supported: true, enabled: true });
    expect(registry.setCalls).toEqual(['"C:\\rly0-hub.exe"']);

    const disabled = await manager.setAutostart(false);
    expect(disabled).toEqual({ supported: true, enabled: false });
    expect(registry.removeCalls).toBe(1);
  });

  it("never touches a real registry: the fake is the only implementation exercised", async () => {
    const registry = new FakeRegistry();
    const manager = new Rly0AppearanceManager({ registry, platform: "win32" });
    await manager.setAutostart(true);
    await manager.autostartStatus();
    expect(registry.setCalls).toHaveLength(1);
    expect(registry.getCalls).toBeGreaterThan(0);
  });
});
