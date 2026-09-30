import { describe, expect, it } from "vitest";
import type { Rly0McpListResult } from "@codexhost/shared-contracts";

import { createMcpSettingsPage, type RendererMcpClient } from "../../src/settings/mcp-page.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  className = "";
  textContent = "";
  title = "";
  type = "";
  disabled = false;
  hidden = false;
  tabIndex = -1;
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
  focus(): void {
    // Not asserted in these tests.
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

const messages = rendererSettingsMessages("zh-CN");

function mountPage(getClient: () => RendererMcpClient | null) {
  const page = createMcpSettingsPage(messages, getClient);
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
  await Promise.resolve();
  await Promise.resolve();
}

describe("createMcpSettingsPage", () => {
  it("renders totals and server rows, hiding secret values while keeping key names", async () => {
    const listResult: Rly0McpListResult = {
      configExists: true,
      configPath: "/tmp/fake/config.toml",
      totalCount: 2,
      enabledCount: 1,
      servers: [
        {
          name: "search",
          type: "stdio",
          enabled: true,
          command: "node",
          envKeys: ["API_TOKEN"],
        },
        {
          name: "remote",
          type: "http",
          enabled: false,
          url: "https://example.com/mcp",
          headerKeys: ["Authorization"],
        },
      ],
    };
    const { root } = mountPage(() => ({
      listRly0Mcp: async () => listResult,
    }));
    await flush();

    const rendered = text(root);
    expect(rendered).toContain("search");
    expect(rendered).toContain("remote");
    expect(rendered).toContain("API_TOKEN");
    expect(rendered).toContain("Authorization");
    expect(rendered).not.toContain("super-secret");
    expect(rendered).not.toContain("Bearer ");
    expect(rendered).toContain(String(listResult.totalCount));
    expect(rendered).toContain(String(listResult.enabledCount));
  });

  it("shows the empty state when no servers are configured", async () => {
    const { root } = mountPage(() => ({
      listRly0Mcp: async () => ({
        configExists: true,
        configPath: "/tmp/fake/config.toml",
        totalCount: 0,
        enabledCount: 0,
        servers: [],
      }),
    }));
    await flush();

    expect(text(root)).toContain(messages.mcp.empty);
  });

  it("shows a missing-config notice when config.toml does not exist", async () => {
    const { root } = mountPage(() => ({
      listRly0Mcp: async () => ({
        configExists: false,
        configPath: "/tmp/fake/config.toml",
        totalCount: 0,
        enabledCount: 0,
        servers: [],
      }),
    }));
    await flush();

    expect(text(root)).toContain(messages.mcp.configMissing);
  });

  it("shows the load-failure notice when the client throws", async () => {
    const { root } = mountPage(() => ({
      listRly0Mcp: async () => {
        throw new Error("boom");
      },
    }));
    await flush();

    expect(text(root)).toContain(messages.mcp.loadFailed);
  });

  it("shows the load-failure notice when no client is available", async () => {
    const { root } = mountPage(() => null);
    await flush();

    expect(text(root)).toContain(messages.mcp.loadFailed);
  });
});
