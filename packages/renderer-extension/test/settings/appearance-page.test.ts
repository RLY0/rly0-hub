import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
}));

import {
  createAppearanceSettingsPage,
  type RendererAppearanceClient,
} from "../../src/settings/appearance-page.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import {
  RENDERER_THEME_STORAGE_KEY,
  RENDERER_ACCENT_STORAGE_KEY,
  RENDERER_QUOTA_REFRESH_STORAGE_KEY,
  RENDERER_QUOTA_ALERT_ENABLED_STORAGE_KEY,
  RENDERER_QUOTA_ALERT_THRESHOLD_STORAGE_KEY,
} from "../../src/renderer-appearance-preferences.js";

class FakeStyle {
  private readonly props = new Map<string, string>();
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? "";
  }
}

class FakeElement {
  readonly children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  readonly style = new FakeStyle();
  readonly attributes = new Map<string, string>();
  className = "";
  textContent = "";
  type = "";
  value = "";
  id = "";
  htmlFor = "";
  min = "";
  max = "";
  step = "";
  title = "";
  scope = "";
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  constructor(readonly tagName: string) {}
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  removeEventListener(name: string): void {
    this.listeners.delete(name);
  }
  append(...children: unknown[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: unknown[]): void {
    this.children.length = 0;
    this.children.push(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setCustomValidity(): void {
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
  // Minimal <table>/<thead>/<tbody>/<tr> surface used by the (unrelated) loaded
  // sessions table that mounts as part of the shared idle-release section.
  createTHead(): FakeElement {
    const thead = new FakeElement("thead");
    this.append(thead);
    return thead;
  }
  createTBody(): FakeElement {
    const tbody = new FakeElement("tbody");
    this.append(tbody);
    return tbody;
  }
  insertRow(): FakeElement {
    const row = new FakeElement("tr");
    this.append(row);
    return row;
  }
  insertCell(): FakeElement {
    const cell = new FakeElement("td");
    this.append(cell);
    return cell;
  }
}

class FakeDocumentElement extends FakeElement {
  override readonly attributes = new Map<string, string>();
  constructor() {
    super("html");
  }
  override setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function createFakeWindow(initialMatches: boolean) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const mediaListeners = new Set<() => void>();
  const media = {
    matches: initialMatches,
    addEventListener: (_type: string, listener: () => void) => {
      mediaListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      mediaListeners.delete(listener);
    },
  };
  const target = new EventTarget();
  const window = Object.assign(target, {
    localStorage: storage,
    matchMedia: () => media,
    // Stubbed out: the (unrelated) loaded sessions table schedules a refresh
    // timer as part of mounting the shared idle-release section. Tests never
    // wait for it, so it is never actually scheduled.
    setTimeout: () => 0 as unknown as ReturnType<typeof globalThis.setTimeout>,
    clearTimeout: () => undefined,
  }) as unknown as Window;
  return { window, values, media, mediaListeners };
}

function createFakeDocument(window: Window): {
  document: Document;
  documentElement: FakeDocumentElement;
} {
  const documentElement = new FakeDocumentElement();
  const document = {
    createElement: (tagName: string) => {
      const element = new FakeElement(tagName);
      Object.assign(element, { ownerDocument: document });
      return element;
    },
    documentElement: documentElement as unknown as HTMLElement,
    defaultView: window,
  } as unknown as Document;
  return { document, documentElement };
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}
function text(root: FakeElement): string {
  return descendants(root)
    .map((el) => el.textContent)
    .filter(Boolean)
    .join(" | ");
}
function selectByIdPrefix(root: FakeElement, prefix: string): FakeElement {
  const found = descendants(root).find((el) => el.tagName === "select" && el.id.startsWith(prefix));
  if (!found) throw new Error(`Missing select with id prefix ${prefix}`);
  return found;
}
function switchByIdPrefix(root: FakeElement, prefix: string): FakeElement {
  const found = descendants(root).find(
    (el) => el.tagName === "input" && el.type === "checkbox" && el.id.startsWith(prefix),
  );
  if (!found) throw new Error(`Missing switch with id prefix ${prefix}`);
  return found;
}
function numberFieldByIdPrefix(root: FakeElement, prefix: string): FakeElement {
  const found = descendants(root).find(
    (el) => el.tagName === "input" && el.type === "number" && el.id.startsWith(prefix),
  );
  if (!found) throw new Error(`Missing number field with id prefix ${prefix}`);
  return found;
}

const messages = rendererSettingsMessages("zh-CN");
const extra = messages.appearanceExtra;

function mountPage(
  window: Window,
  document: Document,
  getAppearanceClient: () => RendererAppearanceClient | null = () => null,
) {
  const page = createAppearanceSettingsPage(messages, () => null, getAppearanceClient);
  const root = new FakeElement("div") as unknown as HTMLElement;
  Object.assign(root, { ownerDocument: document });
  const scope = new RendererSettingsPageScope();
  const unmount = page.mount({
    content: root,
    signal: scope.signal,
    runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
  });
  return { root: root as unknown as FakeElement, scope, unmount };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("Appearance settings page", () => {
  it("does not access preferences when its document has no Window", () => {
    const page = createAppearanceSettingsPage(rendererSettingsMessages("en"));
    const context = {
      content: { ownerDocument: { defaultView: null } },
    } as unknown as Parameters<typeof page.mount>[0];
    expect(page.mount(context)).toBeUndefined();
  });

  it("resolves the system theme against prefers-color-scheme and persists explicit changes", () => {
    const { window, values } = createFakeWindow(false);
    const { document, documentElement } = createFakeDocument(window);
    const { root } = mountPage(window, document);

    // No stored preference: defaults to "system", resolved to light (matches=false).
    expect(documentElement.attributes.get("data-rly0-theme")).toBe("light");
    const themeSelect = selectByIdPrefix(root, "codexhost-theme-");
    expect(themeSelect.value).toBe("system");

    themeSelect.value = "dark";
    themeSelect.listeners.get("change")?.();

    expect(values.get(RENDERER_THEME_STORAGE_KEY)).toBe("dark");
    expect(documentElement.attributes.get("data-rly0-theme")).toBe("dark");
  });

  it("resolves the system theme to dark when the OS prefers dark colors", () => {
    const { window } = createFakeWindow(true);
    const { document, documentElement } = createFakeDocument(window);
    mountPage(window, document);

    expect(documentElement.attributes.get("data-rly0-theme")).toBe("dark");
  });

  it("applies the accent color as a CSS variable and persists changes", () => {
    const { window, values } = createFakeWindow(false);
    const { document, documentElement } = createFakeDocument(window);
    const { root } = mountPage(window, document);

    expect(documentElement.style.getPropertyValue("--codexhost-rly0-accent")).toBe("#3b82f6");
    const accentSelect = selectByIdPrefix(root, "codexhost-accent-");
    expect(accentSelect.value).toBe("blue");

    accentSelect.value = "purple";
    accentSelect.listeners.get("change")?.();

    expect(values.get(RENDERER_ACCENT_STORAGE_KEY)).toBe("purple");
    expect(documentElement.style.getPropertyValue("--codexhost-rly0-accent")).toBe("#8b5cf6");
  });

  it("loads autostart status on mount and toggles it through the injected client", async () => {
    const { window } = createFakeWindow(false);
    const { document } = createFakeDocument(window);
    const status = vi.fn().mockResolvedValue({ supported: true, enabled: false });
    const set = vi.fn().mockResolvedValue({ supported: true, enabled: true });
    const client: RendererAppearanceClient = {
      rly0AppearanceAutostartStatus: status,
      rly0AppearanceAutostartSet: set,
    };
    const { root } = mountPage(window, document, () => client);
    await flush();

    expect(status).toHaveBeenCalledTimes(1);
    const toggle = switchByIdPrefix(root, "codexhost-autostart-");
    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.listeners.get("change")?.();
    await flush();

    expect(set).toHaveBeenCalledWith({ enabled: true });
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
  });

  it("disables the autostart toggle and explains when it is unsupported", async () => {
    const { window } = createFakeWindow(false);
    const { document } = createFakeDocument(window);
    const client: RendererAppearanceClient = {
      rly0AppearanceAutostartStatus: vi
        .fn()
        .mockResolvedValue({ supported: false, enabled: false }),
    };
    const { root } = mountPage(window, document, () => client);
    await flush();

    const toggle = switchByIdPrefix(root, "codexhost-autostart-");
    expect(toggle.disabled).toBe(true);
    expect(text(root)).toContain(extra.autostartUnsupported);
  });

  it("persists the data refresh frequency", () => {
    const { window, values } = createFakeWindow(false);
    const { document } = createFakeDocument(window);
    const { root } = mountPage(window, document);

    const refreshSelect = selectByIdPrefix(root, "codexhost-quota-refresh-");
    expect(refreshSelect.value).toBe("1m");

    refreshSelect.value = "5m";
    refreshSelect.listeners.get("change")?.();

    expect(values.get(RENDERER_QUOTA_REFRESH_STORAGE_KEY)).toBe("5m");
  });

  it("persists the low-quota alert toggle and validates the threshold", () => {
    const { window, values } = createFakeWindow(false);
    const { document } = createFakeDocument(window);
    const { root } = mountPage(window, document);

    const alertToggle = switchByIdPrefix(root, "codexhost-quota-alert-");
    expect(alertToggle.checked).toBe(false);
    alertToggle.checked = true;
    alertToggle.listeners.get("change")?.();
    expect(values.get(RENDERER_QUOTA_ALERT_ENABLED_STORAGE_KEY)).toBe("true");

    const thresholdField = numberFieldByIdPrefix(root, "codexhost-quota-alert-threshold-");
    expect(thresholdField.value).toBe("10");
    const thresholdDescription = (): FakeElement => {
      const found = descendants(root).find((el) => "invalid" in el.dataset);
      if (!found) throw new Error("Missing threshold description with invalid state");
      return found;
    };

    thresholdField.value = "50";
    thresholdField.listeners.get("change")?.();
    expect(values.get(RENDERER_QUOTA_ALERT_THRESHOLD_STORAGE_KEY)).toBe("50");
    expect(thresholdDescription().dataset.invalid).toBe("false");

    thresholdField.value = "99";
    thresholdField.listeners.get("change")?.();
    expect(values.get(RENDERER_QUOTA_ALERT_THRESHOLD_STORAGE_KEY)).toBe("50");
    expect(thresholdDescription().dataset.invalid).toBe("true");
    expect(text(root)).toContain(extra.quotaAlertThresholdInvalid);
  });
});
