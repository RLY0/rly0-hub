import { describe, expect, it, vi } from "vitest";
import type {
  Rly0ThreadEntry,
  Rly0ThreadsListResult,
  Rly0ThreadsListTrashResult,
} from "@codexhost/shared-contracts";

import {
  createThreadsSettingsPage,
  formatByteSize,
  groupThreadsByProject,
  type RendererThreadsClient,
} from "../../src/settings/threads-page.js";
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

function mountPage(getClient: () => RendererThreadsClient | null) {
  const page = createThreadsSettingsPage(messages, getClient);
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

function entry(relPath: string, overrides: Partial<Rly0ThreadEntry> = {}): Rly0ThreadEntry {
  const fileName = relPath.split("/").at(-1) ?? relPath;
  return {
    relPath,
    fileName,
    title: fileName,
    titleFromMessage: false,
    mtimeMs: Date.UTC(2026, 8, 1),
    sizeBytes: 2048,
    ...overrides,
  };
}

const listResult: Rly0ThreadsListResult = {
  sessionsRoot: "/tmp/fake/sessions",
  rootExists: true,
  stats: { totalThreads: 3, totalBytes: 6144, activeDays: 2, averagePerActiveDay: 1.5 },
  threads: [
    entry("2026/09/02/rollout-a.jsonl", {
      title: "Fix build",
      titleFromMessage: true,
      cwd: "/p/app",
    }),
    entry("2026/09/02/rollout-b.jsonl"),
    entry("2026/09/01/rollout-c.jsonl", { title: "Docs", titleFromMessage: true, cwd: "/p/app" }),
  ],
  truncated: false,
};

const emptyTrash: Rly0ThreadsListTrashResult = {
  trashRoot: "/tmp/fake/trash",
  totalCount: 0,
  threads: [],
  truncated: false,
};

describe("threads helpers", () => {
  it("formats byte sizes", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1536)).toBe("1.5 KB");
    expect(formatByteSize(3 * 1024 * 1024)).toBe("3 MB");
  });

  it("groups by cwd and puts entries without cwd under the unknown project", () => {
    const groups = groupThreadsByProject(listResult.threads, "未知项目");
    expect(groups.map((group) => [group.label, group.threads.length, group.unknown])).toEqual([
      ["/p/app", 2, false],
      ["未知项目", 1, true],
    ]);
  });
});

describe("createThreadsSettingsPage", () => {
  it("renders stats, project groups, titles and sizes", async () => {
    const { root } = mountPage(() => ({
      listRly0Threads: async () => listResult,
      listRly0ThreadsTrash: async () => emptyTrash,
    }));
    await flush();
    const rendered = text(root);
    expect(rendered).toContain("/p/app (2)");
    expect(rendered).toContain(`${messages.threads.unknownProject} (1)`);
    expect(rendered).toContain("Fix build");
    expect(rendered).toContain("rollout-b.jsonl");
    expect(rendered).toContain("2 KB");
    expect(rendered).toContain("6 KB");
    expect(rendered).toContain("1.5");
  });

  it("moves selected threads to trash and restores from the trash tab", async () => {
    let trashed: Rly0ThreadEntry[] = [];
    const trash = vi.fn(async ({ relPaths }: { relPaths: string[] }) => {
      trashed = listResult.threads.filter((thread) => relPaths.includes(thread.relPath));
      return { movedCount: relPaths.length, failed: [] };
    });
    const restore = vi.fn(async ({ relPaths }: { relPaths: string[] }) => ({
      movedCount: relPaths.length,
      failed: [],
    }));
    const { root } = mountPage(() => ({
      listRly0Threads: async () => listResult,
      listRly0ThreadsTrash: async () => ({
        ...emptyTrash,
        totalCount: trashed.length,
        threads: trashed,
      }),
      trashRly0Threads: trash,
      restoreRly0Threads: restore,
    }));
    await flush();

    const trashButton = button(root, messages.threads.trashAction);
    expect(trashButton.disabled).toBe(true);
    const checkboxes = descendants(root).filter(
      (el) => el.className === "settings-rly0-threads__check",
    );
    expect(checkboxes).toHaveLength(3);
    const box0 = checkboxes[0];
    if (!box0) throw new Error("missing checkbox");
    box0.checked = true;
    box0.listeners.get("change")?.();
    // Grouped by project: [/p/app: a, c], [unknown: b].
    const box1 = checkboxes[1];
    if (!box1) throw new Error("missing checkbox");
    box1.checked = true;
    box1.listeners.get("change")?.();
    expect(trashButton.disabled).toBe(false);
    expect(text(root)).toContain("已选 2 项");

    trashButton.listeners.get("click")?.();
    const dialog = descendants(root).find((el) => el.tagName === "dialog");
    expect(dialog?.open).toBe(true);
    const confirm = descendants(dialog as FakeElement).find(
      (el) => el.tagName === "button" && el.textContent === messages.threads.trashConfirm,
    );
    confirm?.listeners.get("click")?.();
    await flush();
    expect(trash).toHaveBeenCalledWith({
      relPaths: ["2026/09/02/rollout-a.jsonl", "2026/09/01/rollout-c.jsonl"],
    });

    button(root, messages.threads.tabTrash).listeners.get("click")?.();
    await flush();
    expect(text(root)).toContain("Fix build");
    const restoreButtons = descendants(root).filter(
      (el) => el.tagName === "button" && el.textContent === messages.threads.restoreAction,
    );
    expect(restoreButtons).toHaveLength(2);
    restoreButtons[0]?.listeners.get("click")?.();
    await flush();
    expect(restore).toHaveBeenCalledWith({ relPaths: ["2026/09/02/rollout-a.jsonl"] });
  });

  it("shows a notice when the sessions folder is missing or loading fails", async () => {
    const missing = mountPage(() => ({
      listRly0Threads: async () => ({
        ...listResult,
        rootExists: false,
        threads: [],
        stats: { totalThreads: 0, totalBytes: 0, activeDays: 0, averagePerActiveDay: 0 },
      }),
      listRly0ThreadsTrash: async () => emptyTrash,
    }));
    await flush();
    expect(text(missing.root)).toContain(messages.threads.rootMissing);
    expect(text(missing.root)).toContain(messages.threads.empty);

    const failing = mountPage(() => ({}));
    await flush();
    expect(text(failing.root)).toContain(messages.threads.loadFailed);
  });
});
