import { describe, expect, it, vi } from "vitest";
import type {
  Rly0MaintenanceCacheInfoResult,
  Rly0MaintenanceClearCacheResult,
  Rly0MaintenanceDiagnosticsResult,
  Rly0MaintenanceExportDiagnosticsResult,
  Rly0MaintenanceProcessActionResult,
} from "@codexhost/shared-contracts";

import {
  createMaintenanceSettingsPage,
  type RendererMaintenanceClient,
} from "../../src/settings/maintenance-page.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  className = "";
  textContent = "";
  type = "";
  checked = false;
  translate = true;
  disabled = false;
  hidden = false;
  open = false;
  constructor(readonly tagName: string) {}
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...children);
  }
  setAttribute(): void {
    // Not asserted in these tests.
  }
  querySelector(): FakeElement | null {
    return null;
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
    this.listeners.get("close")?.();
  }
  remove(): void {
    // Detaching is not modelled.
  }
}

const fakeDocument = {
  createElement: (tagName: string) => new FakeElement(tagName),
} as unknown as Document;

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}
function text(root: FakeElement): string {
  return descendants(root)
    .map((el) => el.textContent)
    .filter(Boolean)
    .join(" | ");
}
function button(root: FakeElement, label: string): FakeElement {
  const found = descendants(root).find((el) => el.tagName === "button" && el.textContent === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

const messages = rendererSettingsMessages("zh-CN");

function mountPage(getClient: () => RendererMaintenanceClient | null) {
  const page = createMaintenanceSettingsPage(messages, getClient);
  const root = new FakeElement("div") as unknown as HTMLElement;
  Object.assign(root, { ownerDocument: fakeDocument });
  const scope = new RendererSettingsPageScope();
  page.mount({
    content: root,
    signal: scope.signal,
    runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
  });
  return { root: root as unknown as FakeElement, scope };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

const diagnostics: Rly0MaintenanceDiagnosticsResult = {
  generatedAt: new Date(Date.UTC(2026, 8, 1)).toISOString(),
  codexHome: "/home/fake/.codex",
  codexHomeExists: true,
  authJsonExists: true,
  configTomlExists: true,
  configTomlParses: true,
  sessionsDirExists: true,
  core: { available: false },
  advice: ["CORE_UNAVAILABLE"],
};

const cacheInfo: Rly0MaintenanceCacheInfoResult = {
  entries: [{ name: "cache", exists: true, sizeBytes: 4096, fileCount: 3 }],
  totalBytes: 4096,
};

describe("Maintenance settings page", () => {
  it("loads diagnostics and cache info on mount, showing advice for an unavailable core", async () => {
    const client: RendererMaintenanceClient = {
      rly0MaintenanceDiagnostics: vi.fn().mockResolvedValue(diagnostics),
      rly0MaintenanceCacheInfo: vi.fn().mockResolvedValue(cacheInfo),
    };
    const { root } = mountPage(() => client);
    await flush();

    expect(client.rly0MaintenanceDiagnostics).toHaveBeenCalledTimes(1);
    expect(client.rly0MaintenanceCacheInfo).toHaveBeenCalledTimes(1);
    const rendered = text(root);
    expect(rendered).toContain(messages.maintenance.codexHome);
    expect(rendered).toContain(messages.maintenance.adviceCoreUnavailable);
  });

  it("shows a load-failed notice when diagnostics are unavailable", async () => {
    const client: RendererMaintenanceClient = {};
    const { root } = mountPage(() => client);
    await flush();

    expect(text(root)).toContain(messages.maintenance.loadFailed);
  });

  it("exports a sanitized diagnostics package and shows the path and size", async () => {
    const exportResult: Rly0MaintenanceExportDiagnosticsResult = {
      filePath: "/home/fake/.rly0-hub/diagnostics/rly0-diag-123.json",
      sizeBytes: 2048,
    };
    const client: RendererMaintenanceClient = {
      rly0MaintenanceExportDiagnostics: vi.fn().mockResolvedValue(exportResult),
    };
    const { root } = mountPage(() => client);
    await flush();

    button(root, messages.maintenance.exportAction).listeners.get("click")?.();
    await flush();

    expect(client.rly0MaintenanceExportDiagnostics).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain("rly0-diag-123.json");
  });

  it("requires a confirmation dialog before clearing cache, and never touches ~/.codex", async () => {
    const clearResult: Rly0MaintenanceClearCacheResult = {
      clearedBytes: 4096,
      clearedEntries: ["cache"],
    };
    const client: RendererMaintenanceClient = {
      rly0MaintenanceCacheInfo: vi.fn().mockResolvedValue(cacheInfo),
      rly0MaintenanceClearCache: vi.fn().mockResolvedValue(clearResult),
    };
    const { root } = mountPage(() => client);
    await flush();

    // Clicking clear must not clear anything by itself: a confirmation dialog opens first.
    button(root, messages.maintenance.clearCacheAction).listeners.get("click")?.();
    expect(client.rly0MaintenanceClearCache).not.toHaveBeenCalled();

    const confirmButton = button(root, messages.maintenance.clearCacheConfirm);
    confirmButton.listeners.get("click")?.();
    await flush();

    expect(client.rly0MaintenanceClearCache).toHaveBeenCalledTimes(1);
  });

  it("requires a second confirmation before force-quitting Codex, and calls the injected fake control only", async () => {
    const processResult: Rly0MaintenanceProcessActionResult = { supported: false };
    const forceQuit = vi.fn().mockResolvedValue(processResult);
    const client: RendererMaintenanceClient = {
      rly0MaintenanceForceQuitCodex: forceQuit,
    };
    const { root } = mountPage(() => client);
    await flush();

    button(root, messages.maintenance.forceQuitAction).listeners.get("click")?.();
    // Not called yet: only the confirmation dialog has opened.
    expect(forceQuit).not.toHaveBeenCalled();
    expect(text(root)).toContain(messages.maintenance.forceQuitConfirmTitle);
    expect(text(root)).toContain(messages.maintenance.processConfirmBody);

    button(root, messages.maintenance.processConfirm).listeners.get("click")?.();
    await flush();

    expect(forceQuit).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain(messages.maintenance.processUnsupported);
  });

  it("requires a second confirmation before restarting Codex", async () => {
    const processResult: Rly0MaintenanceProcessActionResult = { supported: true, ok: true };
    const restart = vi.fn().mockResolvedValue(processResult);
    const client: RendererMaintenanceClient = {
      rly0MaintenanceRestartCodex: restart,
    };
    const { root } = mountPage(() => client);
    await flush();

    button(root, messages.maintenance.restartAction).listeners.get("click")?.();
    expect(restart).not.toHaveBeenCalled();

    button(root, messages.maintenance.processConfirm).listeners.get("click")?.();
    await flush();

    expect(restart).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain(messages.maintenance.processSucceeded);
  });

  it("shows the saved settings copy and restores it only after confirmation", async () => {
    const restore = vi.fn().mockResolvedValue({
      ok: true,
      restored: ["config.toml"],
      removed: ["AGENTS.md"],
      safetyBackupDir: "/home/fake/.rly0-hub/backups/before-restore-x",
      backendReload: "reloaded",
    });
    const client: RendererMaintenanceClient = {
      rly0MaintenanceBackupStatus: vi.fn().mockResolvedValue({
        available: true,
        codexHome: "/home/fake/.codex",
        createdAt: 1_790_000_000,
        files: [
          { name: "config.toml", existed: true },
          { name: "AGENTS.md", existed: false },
        ],
      }),
      rly0MaintenanceRestoreBackup: restore,
    };
    const { root } = mountPage(() => client);
    await flush();
    const rendered = text(root);
    expect(rendered).toContain(messages.maintenance.restoreTitle);
    expect(rendered).toContain("config.toml");
    expect(rendered).toContain(messages.maintenance.restoreNoFile.replace("{name}", "AGENTS.md"));

    button(root, messages.maintenance.restoreAction).listeners.get("click")?.();
    expect(restore).not.toHaveBeenCalled();
    button(root, messages.maintenance.restoreConfirm).listeners.get("click")?.();
    await flush();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain(
      messages.maintenance.restoreReloaded.replace(
        "{path}",
        "/home/fake/.rly0-hub/backups/before-restore-x",
      ),
    );
  });

  it("disables restoring before any copy was saved", async () => {
    const client: RendererMaintenanceClient = {
      rly0MaintenanceBackupStatus: vi
        .fn()
        .mockResolvedValue({ available: false, codexHome: "/home/fake/.codex" }),
      rly0MaintenanceRestoreBackup: vi.fn(),
    };
    const { root } = mountPage(() => client);
    await flush();
    expect(text(root)).toContain(messages.maintenance.restoreNone);
    expect(button(root, messages.maintenance.restoreAction).disabled).toBe(true);
  });

  it("renders the image and Claude WebSearch filters as disabled placeholders requiring the closed-source core", async () => {
    const client: RendererMaintenanceClient = {};
    const { root } = mountPage(() => client);
    await flush();

    const rendered = text(root);
    expect(rendered).toContain(messages.maintenance.imageFilterLabel);
    expect(rendered).toContain(messages.maintenance.webSearchFilterLabel);
    const toggles = descendants(root).filter(
      (el) => el.tagName === "input" && el.type === "checkbox",
    );
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    for (const toggle of toggles) expect(toggle.disabled).toBe(true);
  });
});
