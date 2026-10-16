import { describe, expect, it, vi } from "vitest";
import type { Rly0Relay } from "@codexhost/shared-contracts";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
}));

import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import {
  createRelaySettingsPage,
  parseRelayModels,
  relayCodexModelOptions,
  RLY0_RELAY_PROMO_URL,
  type RendererRelayClient,
} from "../../src/settings/relay-page.js";

class FakeElement {
  children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (event?: unknown) => void>();
  className = "";
  textContent = "";
  title = "";
  type = "";
  name = "";
  value = "";
  href = "";
  target = "";
  rel = "";
  placeholder = "";
  autocomplete = "";
  spellcheck = true;
  rows = 0;
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  constructor(readonly tagName: string) {}
  get lastChild(): unknown {
    return this.children[this.children.length - 1] ?? null;
  }
  addEventListener(name: string, listener: (event?: unknown) => void): void {
    this.listeners.set(name, listener);
  }
  append(...children: unknown[]): void {
    this.children.push(...children);
  }
  insertBefore(node: unknown, reference: unknown): void {
    const index = this.children.indexOf(reference);
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }
  replaceChildren(...children: unknown[]): void {
    this.children = [...children];
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  querySelector(selector: string): FakeElement | null {
    const token = selector.replace(/^\./u, "");
    return (
      descendants(this)
        .slice(1)
        .find((el) => el.className.split(/\s+/u).includes(token)) ?? null
    );
  }
  focus(): void {
    // Focus is not modelled.
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
    this.listeners.get("close")?.();
  }
  remove(): void {
    this.removed = true;
  }
  removed = false;
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}
function allText(root: FakeElement): string {
  return descendants(root)
    .flatMap((el) => [el.textContent, el.value, el.title, ...el.attributes.values()])
    .filter(Boolean)
    .join(" | ");
}
function buttonByText(root: FakeElement, label: string): FakeElement {
  const found = descendants(root).find(
    (el) => (el.tagName === "button" || el.tagName === "a") && el.textContent === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function openDialog(root: FakeElement): FakeElement {
  const found = descendants(root).find((el) => el.tagName === "dialog" && el.open && !el.removed);
  if (!found) throw new Error("No open dialog");
  return found;
}
function inputByName(root: FakeElement, name: string): FakeElement {
  const found = descendants(root).find((el) => el.name === name);
  if (!found) throw new Error(`Missing input ${name}`);
  return found;
}
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

const settingsMessages = rendererSettingsMessages("zh-CN");
const messages = settingsMessages.relay;
const SECRET = "sk-test-secret-value-should-never-render";

function mountPage(client: RendererRelayClient | null, storage: Record<string, string> = {}) {
  const view = {
    localStorage: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
    },
  };
  const document = {
    defaultView: view,
    createElement: (tagName: string) => new FakeElement(tagName),
  };
  const root = new FakeElement("div");
  Object.assign(root, { ownerDocument: document });
  const page = createRelaySettingsPage(settingsMessages, () => client);
  const scope = new RendererSettingsPageScope();
  page.mount({
    content: root as unknown as HTMLElement,
    signal: scope.signal,
    runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
  });
  return { root, storage, scope, page };
}

const relay: Rly0Relay = {
  id: "relay-1",
  name: "Main relay",
  baseUrl: "https://api.example.com/v1",
  protocol: "responses",
  models: ["gpt-5", "gpt-5-mini", "claude-*"],
  enabled: true,
  hasKey: true,
  keyMask: "sk-…abcd",
};

const running = {
  available: true as const,
  running: true as const,
  port: 18_765,
  baseUrl: "http://127.0.0.1:18765/v1",
  requests: 3,
  routed: 2,
  unrouted: 1,
  failed: 0,
  recent: [
    {
      at: Math.floor(Date.now() / 1000),
      method: "POST",
      path: "/v1/responses",
      model: "gpt-5",
      relay: "Main relay",
      status: 200,
      ms: 321,
    },
  ],
};

const codexStatus = {
  configPath: "/tmp/codex-home/config.toml",
  configExists: true,
  providerPresent: false,
  applied: false,
};

function fullClient(overrides: Partial<RendererRelayClient> = {}): RendererRelayClient {
  let relays: Rly0Relay[] = [relay];
  return {
    listRly0Relays: vi.fn(async () => ({ available: true as const, relays })),
    addRly0Relay: vi.fn(async (input) => {
      const created: Rly0Relay = {
        id: "relay-2",
        name: input.name,
        baseUrl: input.baseUrl,
        protocol: "responses",
        models: input.models ?? [],
        enabled: true,
        hasKey: Boolean(input.apiKey),
        ...(input.apiKey ? { keyMask: "sk-…alue" } : {}),
      };
      relays = [...relays, created];
      return { available: true as const, id: created.id, relay: created };
    }),
    updateRly0Relay: vi.fn(async (input) => {
      const updated = {
        ...(relays[0] as Rly0Relay),
        ...(input.models ? { models: input.models } : {}),
      };
      relays = [updated, ...relays.slice(1)];
      return { available: true as const, relay: updated };
    }),
    removeRly0Relay: vi.fn(async () => {
      relays = [];
      return { available: true as const, ok: true };
    }),
    setRly0RelayEnabled: vi.fn(async (input) => {
      const updated = { ...(relays[0] as Rly0Relay), enabled: input.enabled };
      relays = [updated];
      return { available: true as const, relay: updated };
    }),
    testRly0Relay: vi.fn(async () => ({
      available: true as const,
      ok: true,
      latencyMs: 120,
      modelCount: 2,
      models: ["gpt-5", "o4-mini"],
    })),
    rly0ProxyStatus: vi.fn(async () => running),
    rly0ProxyStart: vi.fn(async () => running),
    rly0ProxyStop: vi.fn(async () => ({ available: true as const, stopped: true })),
    rly0RelayCodexConfigStatus: vi.fn(async () => codexStatus),
    rly0RelayCodexConfigApply: vi.fn(async (input) => ({
      ok: true,
      status: {
        ...codexStatus,
        providerPresent: true,
        applied: true,
        providerBaseUrl: input.baseUrl,
        ...(input.setDefault ? { modelProvider: "rly0", model: input.model } : {}),
      },
    })),
    rly0RelayCodexConfigRestore: vi.fn(async () => ({ ok: true, status: codexStatus })),
    ...overrides,
  };
}

describe("relay page helpers", () => {
  it("parses model lists and rejects invalid names", () => {
    expect(parseRelayModels("gpt-5\n gpt-5-mini , gpt-5\n\n")).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(parseRelayModels("bad model")).toBeNull();
    expect(parseRelayModels('quote"model')).toBeNull();
  });

  it("offers only concrete models of enabled relays for the Codex default", () => {
    expect(
      relayCodexModelOptions([relay, { ...relay, id: "relay-2", enabled: false, models: ["x"] }]),
    ).toEqual(["gpt-5", "gpt-5-mini"]);
  });
});

describe("Relay settings page", () => {
  it("registers as the relay page and says rly0-core is required without the bridge", async () => {
    const { root, page } = mountPage({
      listRly0Relays: async () => ({ available: false }),
      rly0RelayCodexConfigStatus: async () => codexStatus,
    });
    await flush();
    expect(page.id).toBe("relay");
    expect(page.label).toBe("中转站");
    expect(allText(root)).toContain(messages.unavailable);
    expect(() => buttonByText(root, messages.add)).toThrow();
    // The Codex config card is host-side and stays visible.
    expect(allText(root)).toContain(messages.codexTitle);
  });

  it("shows the proxy status, relay cards and only the key mask", async () => {
    const { root } = mountPage(fullClient());
    await flush();
    const text = allText(root);
    expect(text).toContain(messages.proxyRunning);
    expect(text).toContain("http://127.0.0.1:18765/v1");
    expect(text).toContain("/v1/responses");
    expect(text).toContain("Main relay");
    expect(text).toContain("https://api.example.com/v1");
    expect(text).toContain("sk-…abcd");
    expect(text).toContain(messages.modelCount.replace("{n}", "3"));
    expect(text).toContain("claude-*");
  });

  it("sends the API key only to add and never keeps it in the page", async () => {
    const client = fullClient();
    const { root } = mountPage(client);
    await flush();
    buttonByText(root, messages.add).listeners.get("click")?.();
    const dialog = openDialog(root);
    inputByName(dialog, "relay-name").value = "Second";
    inputByName(dialog, "relay-base-url").value = "https://relay.example.org/v1";
    const keyInput = inputByName(dialog, "relay-api-key");
    expect(keyInput.type).toBe("password");
    keyInput.value = SECRET;
    inputByName(dialog, "relay-models").value = "gpt-5, o4-mini";
    buttonByText(dialog, messages.formSave).listeners.get("click")?.();
    await flush();
    expect(client.addRly0Relay).toHaveBeenCalledWith({
      name: "Second",
      baseUrl: "https://relay.example.org/v1",
      models: ["gpt-5", "o4-mini"],
      apiKey: SECRET,
    });
    expect(keyInput.value).toBe("");
    expect(dialog.open).toBe(false);
    expect(allText(root)).not.toContain(SECRET);
    expect(allText(root)).toContain("Second");
  });

  it("shows requests handed back to the official account and saves the catch-all switch", async () => {
    const client = fullClient({
      rly0ProxyStatus: vi.fn(async () => ({
        ...running,
        official: 4,
        recent: [
          {
            at: Math.floor(Date.now() / 1000),
            method: "POST",
            path: "/v1/responses",
            model: "gpt-5.5",
            route: "official" as const,
            status: 200,
            ms: 88,
          },
        ],
      })),
    });
    const { root } = mountPage(client);
    await flush();
    const text = allText(root);
    expect(text).toContain(messages.proxyOfficial);
    expect(text).toContain(`gpt-5.5 · ${messages.routeOfficial}`);

    buttonByText(root, messages.add).listeners.get("click")?.();
    const dialog = openDialog(root);
    expect(inputByName(dialog, "relay-route-locked").checked).toBe(false);
    inputByName(dialog, "relay-name").value = "Catch all";
    inputByName(dialog, "relay-base-url").value = "https://relay.example.org/v1";
    inputByName(dialog, "relay-route-locked").checked = true;
    buttonByText(dialog, messages.formSave).listeners.get("click")?.();
    await flush();
    expect(client.addRly0Relay).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Catch all", routeLocked: true }),
    );
  });

  it("keeps the saved key when editing with an empty key field", async () => {
    const client = fullClient();
    const { root } = mountPage(client);
    await flush();
    buttonByText(root, messages.edit).listeners.get("click")?.();
    const dialog = openDialog(root);
    expect(allText(dialog)).toContain("sk-…abcd");
    buttonByText(dialog, messages.formSave).listeners.get("click")?.();
    await flush();
    const call = vi.mocked(client.updateRly0Relay)?.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty("apiKey");
    expect(call).toMatchObject({ id: "relay-1", name: "Main relay" });
  });

  it("rejects an invalid form without calling the core", async () => {
    const client = fullClient();
    const { root } = mountPage(client);
    await flush();
    buttonByText(root, messages.add).listeners.get("click")?.();
    const dialog = openDialog(root);
    inputByName(dialog, "relay-name").value = "x";
    inputByName(dialog, "relay-base-url").value = "ftp://nope";
    buttonByText(dialog, messages.formSave).listeners.get("click")?.();
    await flush();
    expect(client.addRly0Relay).not.toHaveBeenCalled();
    expect(allText(dialog)).toContain(messages.formInvalid);
  });

  it("tests a relay and fills the discovered models with one click", async () => {
    const client = fullClient();
    const { root } = mountPage(client);
    await flush();
    buttonByText(root, messages.test).listeners.get("click")?.();
    await flush();
    expect(client.testRly0Relay).toHaveBeenCalledWith({ id: "relay-1" });
    expect(allText(root)).toContain(messages.testOk.replace("{ms}", "120").replace("{count}", "2"));
    buttonByText(root, messages.fillModels.replace("{n}", "2")).listeners.get("click")?.();
    await flush();
    expect(client.updateRly0Relay).toHaveBeenCalledWith({
      id: "relay-1",
      models: ["gpt-5", "o4-mini"],
    });
  });

  it("fills an empty model list straight from the test, without an extra click", async () => {
    const client = fullClient();
    const { root } = mountPage(client);
    await flush();
    buttonByText(root, messages.add).listeners.get("click")?.();
    const dialog = openDialog(root);
    inputByName(dialog, "relay-name").value = "Fresh";
    inputByName(dialog, "relay-base-url").value = "https://relay.example.org/v1";
    inputByName(dialog, "relay-api-key").value = SECRET;
    buttonByText(dialog, messages.formTest).listeners.get("click")?.();
    await flush();
    expect(inputByName(dialog, "relay-models").value).toBe(["gpt-5", "o4-mini"].join("\n"));
    expect(allText(dialog)).toContain(messages.formTestFilled.replace("{n}", "2"));
    expect(
      descendants(dialog).some(
        (el) =>
          el.tagName === "button" && el.textContent === messages.formTestFill.replace("{n}", "2"),
      ),
    ).toBe(false);
  });

  it("deletes only after confirmation", async () => {
    const client = fullClient();
    const { root } = mountPage(client);
    await flush();
    buttonByText(root, messages.remove).listeners.get("click")?.();
    const dialog = openDialog(root);
    expect(client.removeRly0Relay).not.toHaveBeenCalled();
    buttonByText(dialog, messages.cancel).listeners.get("click")?.();
    expect(client.removeRly0Relay).not.toHaveBeenCalled();
    buttonByText(root, messages.remove).listeners.get("click")?.();
    buttonByText(openDialog(root), messages.removeConfirm).listeners.get("click")?.();
    await flush();
    expect(client.removeRly0Relay).toHaveBeenCalledWith({ id: "relay-1" });
    expect(allText(root)).toContain(messages.relaysEmpty);
  });

  it("toggles a relay and stops the proxy", async () => {
    const client = fullClient();
    const { root } = mountPage(client);
    await flush();
    const toggle = descendants(root).find((el) => el.tagName === "input" && el.type === "checkbox");
    if (!toggle) throw new Error("Missing enable toggle");
    toggle.checked = false;
    toggle.listeners.get("change")?.();
    await flush();
    expect(client.setRly0RelayEnabled).toHaveBeenCalledWith({ id: "relay-1", enabled: false });
    buttonByText(root, messages.proxyStop).listeners.get("click")?.();
    await flush();
    expect(client.rly0ProxyStop).toHaveBeenCalled();
  });

  it("warns when another tool owns Codex's default provider, but not for official or RLY/0", async () => {
    const notice = (provider: string) =>
      messages.codexForeignProvider.replace("{provider}", provider);
    const foreign = mountPage(
      fullClient({
        rly0RelayCodexConfigStatus: async () => ({ ...codexStatus, modelProvider: "aimai1" }),
      }),
    );
    await flush();
    expect(allText(foreign.root)).toContain(notice("aimai1"));
    for (const provider of ["openai", "rly0"]) {
      const own = mountPage(
        fullClient({
          rly0RelayCodexConfigStatus: async () => ({ ...codexStatus, modelProvider: provider }),
        }),
      );
      await flush();
      expect(allText(own.root)).not.toContain(notice(provider));
    }
  });

  it("writes the Codex config only after a confirmation that mentions backup and the in-place reload", async () => {
    const client = fullClient();
    const { root } = mountPage(client);
    await flush();
    buttonByText(root, messages.codexApply).listeners.get("click")?.();
    const dialog = openDialog(root);
    expect(client.rly0RelayCodexConfigApply).not.toHaveBeenCalled();
    const body = allText(dialog);
    expect(body).toContain("config.toml");
    expect(body).toContain("自动备份");
    expect(body).toContain("窗口不会关闭");
    const setDefault = inputByName(dialog, "relay-set-default");
    setDefault.checked = true;
    setDefault.listeners.get("change")?.();
    const model = inputByName(dialog, "relay-model");
    expect(model.disabled).toBe(false);
    model.value = "gpt-5-mini";
    model.listeners.get("change")?.();
    buttonByText(dialog, messages.codexConfirm).listeners.get("click")?.();
    await flush();
    expect(client.rly0RelayCodexConfigApply).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:18765/v1",
      setDefault: true,
      model: "gpt-5-mini",
    });
    expect(allText(root)).toContain(messages.codexApplyDone);

    buttonByText(root, messages.codexRestore).listeners.get("click")?.();
    const restoreDialog = openDialog(root);
    expect(client.rly0RelayCodexConfigRestore).not.toHaveBeenCalled();
    buttonByText(restoreDialog, messages.codexConfirm).listeners.get("click")?.();
    await flush();
    expect(client.rly0RelayCodexConfigRestore).toHaveBeenCalledTimes(1);
    expect(allText(root)).toContain(messages.codexRestoreDone);
  });

  it("shows the live official catalog, the appended relay models, and checks on demand", async () => {
    const fetchedAt = Date.now() - 5 * 60_000;
    const catalogStatus = vi.fn(async (input?: { refresh?: boolean }) =>
      input?.refresh
        ? {
            official: { fetchedAt: Date.now(), count: 12, via: "hub" as const },
            appended: ["claude-opus-5"],
            shadowed: ["gpt-5.5"],
          }
        : {
            official: { fetchedAt, count: 11, via: "codex" as const },
            appended: ["claude-opus-5"],
            shadowed: [],
          },
    );
    const { root } = mountPage(fullClient({ rly0RelayModelCatalogStatus: catalogStatus }));
    await flush();
    const card = root.querySelector(".settings-rly0-relay__catalog");
    if (!card) throw new Error("expected the catalog card");
    const text = allText(card);
    expect(text).toContain(messages.catalogLive);
    expect(text).toContain("11");
    expect(text).toContain("5 分钟前");
    expect(text).toContain(messages.catalogViaCodex);
    expect(text).toContain(messages.catalogAppended.replace("{models}", "claude-opus-5"));
    expect(catalogStatus).toHaveBeenLastCalledWith({});

    const check = buttonByText(card, messages.catalogCheck);
    expect(check.title).toBe(messages.catalogCheckHint);
    check.listeners.get("click")?.();
    await flush();
    expect(catalogStatus).toHaveBeenLastCalledWith({ refresh: true });
    const after = allText(root.querySelector(".settings-rly0-relay__catalog") as FakeElement);
    expect(after).toContain("12");
    expect(after).toContain(messages.catalogViaHub);
    expect(after).toContain(messages.catalogShadowed.replace("{models}", "gpt-5.5"));
  });

  it("says when the official list was never read or the last check failed", async () => {
    const { root } = mountPage(
      fullClient({
        rly0RelayModelCatalogStatus: async () => ({
          official: null,
          lastError: { at: Date.now(), message: "OFFICIAL_CATALOG_FAILED" },
          appended: [],
          shadowed: [],
        }),
      }),
    );
    await flush();
    const card = root.querySelector(".settings-rly0-relay__catalog") as FakeElement;
    const text = allText(card);
    expect(text).toContain(messages.catalogNotRead);
    expect(text).toContain(messages.catalogNone);
    expect(text).toContain(messages.catalogAppendedNone);
    expect(text).toContain(messages.catalogError.replace("{time}", "刚刚"));
    expect(text).not.toContain(messages.catalogLive);
  });

  it("lets Claude Code run through a relay and offers a restart when the choice changes", async () => {
    let saved: string | null = null;
    const agentsSet = vi.fn(async ({ claudeCode }: { claudeCode: string | null }) => {
      saved = claudeCode;
      return { claudeCode, active: { claudeCode: null }, restartRequired: claudeCode !== null };
    });
    const restart = vi.fn(async () => ({ supported: true as const, ok: true }));
    const { root } = mountPage(
      fullClient({
        rly0RelayAgentsGet: async () => ({
          claudeCode: saved,
          active: { claudeCode: null },
          restartRequired: false,
        }),
        rly0RelayAgentsSet: agentsSet,
        rly0MaintenanceRestartCodex: restart,
      }),
    );
    await flush();
    const card = root.querySelector(".settings-rly0-relay__agents");
    if (!card) throw new Error("expected the agents card");
    expect(card.hidden).toBe(false);
    expect(allText(card)).toContain(messages.agentsOwnLogin);
    expect(allText(card)).toContain(relay.name);
    const select = descendants(card).find((el) => el.tagName === "select");
    if (!select) throw new Error("expected the Claude Code select");
    select.value = relay.id;
    select.listeners.get("change")?.();
    await flush();
    expect(agentsSet).toHaveBeenCalledWith({ claudeCode: relay.id });
    const updated = root.querySelector(".settings-rly0-relay__agents") as FakeElement;
    expect(allText(updated)).toContain(messages.agentsRestart);
    buttonByText(updated, messages.agentsRestartNow).listeners.get("click")?.();
    await flush();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("hides the catalog card when the host does not offer it", async () => {
    const { root } = mountPage(fullClient());
    await flush();
    expect(root.querySelector(".settings-rly0-relay__catalog")?.hidden).toBe(true);
  });

  it("disables writing the Codex config while the proxy is stopped", async () => {
    const client = fullClient({
      rly0ProxyStatus: async () => ({ available: true, running: false, defaultPort: 18_765 }),
    });
    const { root } = mountPage(client);
    await flush();
    expect(buttonByText(root, messages.codexApply).disabled).toBe(true);
    expect(buttonByText(root, messages.proxyStart).disabled).toBe(false);
  });

  it("always shows the author-run promo, which only links out and cannot be closed", async () => {
    const client = fullClient();
    const { root, storage } = mountPage(client);
    await flush();
    const link = buttonByText(root, messages.promoOpen);
    expect(link.tagName).toBe("a");
    expect(link.href).toBe(RLY0_RELAY_PROMO_URL);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.listeners.size).toBe(0);
    expect(allText(root)).toContain("作者自营");
    expect(allText(root)).not.toContain("关闭");
    expect(client.addRly0Relay).not.toHaveBeenCalled();

    storage["codexhost.rly0-relay-promo-dismissed.v1"] = "1";
    const again = mountPage(fullClient(), storage);
    await flush();
    expect(buttonByText(again.root, messages.promoOpen).tagName).toBe("a");
  });
});
