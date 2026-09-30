import { describe, expect, it } from "vitest";
import type { Rly0SkillsListResult } from "@codexhost/shared-contracts";

import {
  createSkillsSettingsPage,
  type RendererSkillsClient,
} from "../../src/settings/skills-page.js";
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
function findByText(root: FakeElement, value: string): FakeElement | undefined {
  return descendants(root).find((el) => el.textContent === value);
}

const messages = rendererSettingsMessages("zh-CN");

function mountPage(getClient: () => RendererSkillsClient | null) {
  const page = createSkillsSettingsPage(messages, getClient);
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

describe("createSkillsSettingsPage", () => {
  it("renders installed skills with their title and description on the Installed tab", async () => {
    const listResult: Rly0SkillsListResult = {
      rootExists: true,
      skillsRoot: "/tmp/fake/skills",
      installedCount: 1,
      installed: [
        {
          name: "pdf-tools",
          title: "PDF Tools",
          description: "Extract and merge PDF files.",
        },
      ],
      backups: [],
    };
    const { root } = mountPage(() => ({
      listRly0Skills: async () => listResult,
    }));
    await flush();

    const rendered = text(root);
    expect(rendered).toContain("PDF Tools");
    expect(rendered).toContain("Extract and merge PDF files.");
    expect(rendered).toContain(String(listResult.installedCount));
  });

  it("switches to the Backup tab and shows backup entries", async () => {
    const listResult: Rly0SkillsListResult = {
      rootExists: true,
      skillsRoot: "/tmp/fake/skills",
      installedCount: 0,
      installed: [],
      backups: [
        {
          backupId: "pdf-tools-20260101T000000000Z",
          name: "pdf-tools",
          title: "PDF Tools",
          backedUpAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const { root } = mountPage(() => ({
      listRly0Skills: async () => listResult,
    }));
    await flush();

    const backupTabButton = findByText(root, messages.skills.tabBackup);
    expect(backupTabButton).toBeDefined();
    backupTabButton?.listeners.get("click")?.();
    await flush();

    const rendered = text(root);
    expect(rendered).toContain("PDF Tools");
    expect(rendered).toContain("2026-01-01T00:00:00.000Z");
  });

  it("shows the empty state when nothing is installed", async () => {
    const { root } = mountPage(() => ({
      listRly0Skills: async () => ({
        rootExists: true,
        skillsRoot: "/tmp/fake/skills",
        installedCount: 0,
        installed: [],
        backups: [],
      }),
    }));
    await flush();

    expect(text(root)).toContain(messages.skills.emptyInstalled);
  });

  it("shows a missing-root notice when the skills directory does not exist", async () => {
    const { root } = mountPage(() => ({
      listRly0Skills: async () => ({
        rootExists: false,
        skillsRoot: "/tmp/fake/skills",
        installedCount: 0,
        installed: [],
        backups: [],
      }),
    }));
    await flush();

    expect(text(root)).toContain(messages.skills.rootMissing);
  });

  it("shows the load-failure notice when the client throws", async () => {
    const { root } = mountPage(() => ({
      listRly0Skills: async () => {
        throw new Error("boom");
      },
    }));
    await flush();

    expect(text(root)).toContain(messages.skills.loadFailed);
  });
});
