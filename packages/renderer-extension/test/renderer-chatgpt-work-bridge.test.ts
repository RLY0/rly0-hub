// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writePreference = vi.hoisted(() => vi.fn());
vi.mock("../src/renderer-new-thread-preference.js", () => ({
  writeNewThreadAgentPreference: writePreference,
}));

import {
  CHATGPT_WORK_BRIDGE_ATTRIBUTE,
  chatGptWorkComposer,
  chatGptWorkMenuPlacement,
  findProductModeControl,
  installChatGptWorkBridge,
  openAgentInCodexMode,
  projectNewChatButton,
} from "../src/renderer-chatgpt-work-bridge.js";

// Synthetic React fiber chains shaped like Codex Desktop 26.1117.4957's published props.
function attachFiber(element: Element, chain: Record<string, unknown>[]): void {
  let parent: object | null = null;
  const fibers = [...chain].reverse().map((memoizedProps) => {
    const fiber: { memoizedProps: Record<string, unknown>; return: object | null } = {
      memoizedProps,
      return: parent,
    };
    parent = fiber;
    return fiber;
  });
  Object.defineProperty(element, "__reactFiber$test", { value: fibers.at(-1), configurable: true });
}

function workForm(props: { isWork?: boolean; origin?: string | null; projectId?: string | null }) {
  const form = document.createElement("form");
  form.setAttribute("data-thread-find-composer", "true");
  form.innerHTML =
    '<div contenteditable="true"></div><div><div><button type="button" aria-label="听写"></button></div><button type="submit" aria-label="发送"></button></div>';
  attachFiber(form, [
    { className: "relative" },
    { conversationId: "local-chatgpt:1", isWork: props.isWork ?? true, isHome: true },
    {
      conversationOrigin: props.origin === undefined ? "tpp" : props.origin,
      projectId: props.projectId ?? null,
    },
  ]);
  return form;
}

function modeSwitch(initial: string, codexAvailable = true) {
  const state = { mode: initial };
  const trigger = document.createElement("button");
  trigger.setAttribute("aria-haspopup", "menu");
  const onModeSelect = vi.fn((mode: string) => {
    state.mode = mode;
    attachFiber(trigger, [{ type: "button" }, chainProps()]);
  });
  const chainProps = () => ({ mode: state.mode, codexAvailable, onModeSelect, disabled: false });
  attachFiber(trigger, [{ type: "button" }, chainProps()]);
  document.body.append(trigger);
  return { trigger, onModeSelect, state };
}

function projectRow(id: string) {
  const row = document.createElement("div");
  row.setAttribute("data-app-action-sidebar-project-id", id);
  const menu = document.createElement("button");
  menu.setAttribute("aria-haspopup", "menu");
  menu.setAttribute("aria-label", "项目操作");
  const newChat = document.createElement("button");
  newChat.setAttribute("aria-label", "在 项目 中开启新聊天");
  row.append(menu, newChat);
  document.body.append(row);
  return { menu, newChat };
}

beforeEach(() => {
  document.body.replaceChildren();
  writePreference.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("ChatGPT Work composer classification", () => {
  it("recognizes a Work composer of a ChatGPT-orchestrated conversation", () => {
    expect(chatGptWorkComposer(workForm({ projectId: "g-p-1" }))).toEqual({ projectId: "g-p-1" });
    expect(chatGptWorkComposer(workForm({}))).toEqual({ projectId: null });
  });

  it("ignores ChatGPT chat composers, other origins and Codex composers", () => {
    expect(chatGptWorkComposer(workForm({ isWork: false }))).toBeNull();
    expect(chatGptWorkComposer(workForm({ origin: null }))).toBeNull();
    const codex = workForm({});
    codex.firstElementChild?.setAttribute("data-codex-composer-root", "");
    expect(chatGptWorkComposer(codex)).toBeNull();
    const plain = document.createElement("form");
    expect(chatGptWorkComposer(plain)).toBeNull();
  });
});

describe("switching to a Codex-mode new chat", () => {
  it("finds Codex's mode switch through its published props", () => {
    const { onModeSelect } = modeSwitch("work");
    const control = findProductModeControl(document);
    expect(control?.mode).toBe("work");
    control?.select("codex");
    expect(onModeSelect).toHaveBeenCalledWith("codex");
  });

  it("picks the project row's new-chat action, not its menu", () => {
    const { newChat } = projectRow("g-p-1");
    expect(projectNewChatButton(document, "g-p-1")).toBe(newChat);
    expect(projectNewChatButton(document, "g-p-2")).toBeNull();
  });

  it("preselects the agent, switches mode and opens a chat in the same project", async () => {
    const { onModeSelect } = modeSwitch("work");
    const { newChat } = projectRow("g-p-1");
    const click = vi.fn();
    newChat.addEventListener("click", click);
    await expect(openAgentInCodexMode(document, "claude-code", "g-p-1", 500)).resolves.toBe(
      "opened",
    );
    expect(writePreference).toHaveBeenCalledWith("claude-code");
    expect(onModeSelect).toHaveBeenCalledWith("codex");
    expect(click).toHaveBeenCalledOnce();
  });

  it("falls back to Codex's New chat without a project row", async () => {
    modeSwitch("codex");
    const newChat = document.createElement("button");
    newChat.textContent = "新聊天";
    const click = vi.fn();
    newChat.addEventListener("click", click);
    document.body.append(newChat);
    await expect(openAgentInCodexMode(document, "codex", null, 500)).resolves.toBe("opened");
    expect(click).toHaveBeenCalledOnce();
  });

  it("reports when the mode cannot be switched, after keeping the preference", async () => {
    await expect(openAgentInCodexMode(document, "claude-code", null, 100)).resolves.toBe(
      "noModeSwitch",
    );
    expect(writePreference).toHaveBeenCalledWith("claude-code");
    document.body.replaceChildren();
    const { onModeSelect } = modeSwitch("work", false);
    await expect(openAgentInCodexMode(document, "claude-code", null, 100)).resolves.toBe(
      "noModeSwitch",
    );
    expect(onModeSelect).not.toHaveBeenCalled();
  });

  it("reports a missing New chat button after switching", async () => {
    modeSwitch("work");
    await expect(openAgentInCodexMode(document, "codex", "g-p-9", 500)).resolves.toBe("noNewChat");
  });
});

describe("ChatGPT Work bridge control", () => {
  it("mounts a picker labelled like the Agent picker and removes it with the composer", async () => {
    const form = workForm({});
    document.body.append(form);
    const bridge = installChatGptWorkBridge(document, {
      readTargets: () => [
        { agent: "codex", label: "Codex" },
        { agent: "claude-code", label: "Claude Code" },
      ],
      readZh: () => true,
    });
    const root = form.querySelector(`[${CHATGPT_WORK_BRIDGE_ATTRIBUTE}]`);
    expect(root).not.toBeNull();
    // Placed before the trailing voice/send cluster.
    expect(root?.nextElementSibling?.querySelector('[aria-label="听写"]')).not.toBeNull();
    const trigger = root?.querySelector("button");
    expect(trigger?.getAttribute("aria-label")).toBe("Select Agent, current ChatGPT Work");
    trigger?.click();
    const items = [...(root?.querySelectorAll('[role="menuitemradio"]') ?? [])].map(
      (item) => (item as HTMLElement).dataset.agent,
    );
    expect(items).toEqual(["chatgpt-work", "codex", "claude-code"]);
    const claude = root?.querySelector('[role="menuitemradio"][data-agent="claude-code"]');
    expect(claude?.querySelector("span:last-child")?.textContent).toBe("Claude Code");
    form.remove();
    bridge.refresh();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(root?.isConnected).toBe(false);
    bridge.dispose();
  });

  it("isolates a composer whose props throw: the others still mount and nothing escapes", () => {
    const broken = document.createElement("form");
    broken.setAttribute("data-thread-find-composer", "true");
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("synthetic props failure");
        },
      },
    );
    attachFiber(broken, [hostile as Record<string, unknown>]);
    const good = workForm({});
    document.body.append(broken, good);
    const bridge = installChatGptWorkBridge(document, {
      readTargets: () => [{ agent: "codex", label: "Codex" }],
      readZh: () => true,
    });
    expect(broken.querySelector(`[${CHATGPT_WORK_BRIDGE_ATTRIBUTE}]`)).toBeNull();
    expect(good.querySelector(`[${CHATGPT_WORK_BRIDGE_ATTRIBUTE}]`)).not.toBeNull();
    bridge.dispose();
    expect(good.querySelector(`[${CHATGPT_WORK_BRIDGE_ATTRIBUTE}]`)).toBeNull();
  });

  it("disconnects its observer when the install itself fails", () => {
    const observe = vi
      .spyOn(window.MutationObserver.prototype, "observe")
      .mockImplementation(() => {
        throw new Error("synthetic observe failure");
      });
    const disconnect = vi.spyOn(window.MutationObserver.prototype, "disconnect");
    try {
      expect(() =>
        installChatGptWorkBridge(document, { readTargets: () => [], readZh: () => false }),
      ).toThrow("synthetic observe failure");
      expect(disconnect).toHaveBeenCalled();
    } finally {
      observe.mockRestore();
      disconnect.mockRestore();
    }
  });

  it("throttles rescans while the page keeps changing", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "performance"],
    });
    const scans = vi.spyOn(document, "querySelectorAll");
    const bridge = installChatGptWorkBridge(document, {
      readTargets: () => [],
      readZh: () => false,
    });
    const count = () =>
      scans.mock.calls.filter(([selector]) => String(selector).includes("form")).length;
    expect(count()).toBe(1); // the initial scan
    for (let frame = 0; frame < 6; frame += 1) {
      document.body.append(document.createElement("div"));
      await Promise.resolve(); // MutationObserver delivery
      vi.advanceTimersByTime(16);
    }
    expect(count()).toBe(1); // ~100 ms of streaming: still within the interval
    vi.advanceTimersByTime(100);
    expect(count()).toBe(2); // one rescan for the whole burst
    // An explicit refresh is not throttled.
    bridge.refresh();
    vi.advanceTimersByTime(16);
    expect(count()).toBe(3);
    bridge.dispose();
    scans.mockRestore();
  });

  it("leaves ordinary composers alone", () => {
    const form = workForm({ isWork: false });
    document.body.append(form);
    const bridge = installChatGptWorkBridge(document, {
      readTargets: () => [],
      readZh: () => false,
    });
    expect(form.querySelector(`[${CHATGPT_WORK_BRIDGE_ATTRIBUTE}]`)).toBeNull();
    bridge.dispose();
  });
});

describe("menu placement", () => {
  it("stays inside the viewport and honors the window zoom", () => {
    expect(
      chatGptWorkMenuPlacement({ right: 900, top: 500 }, { width: 1000, height: 800 }, 1),
    ).toEqual({
      left: 644,
      bottom: 306,
    });
    expect(
      chatGptWorkMenuPlacement({ right: 100, top: 500 }, { width: 1000, height: 800 }, 2).left,
    ).toBe(8);
    expect(
      chatGptWorkMenuPlacement({ right: 900, top: 500 }, { width: 1000, height: 800 }, NaN).left,
    ).toBe(644);
  });
});
