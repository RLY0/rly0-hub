import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
import createLucideElement from "lucide/dist/esm/createElement.mjs";
import ArrowLeftRight from "lucide/dist/esm/icons/arrow-left-right.mjs";

import type { RendererAgent } from "./agent-selection-state.js";
import { createRendererAgentIcon } from "./renderer-agent-icon.js";
import {
  CODEX_COMPOSER_SELECTOR,
  sendButtonWithin,
  trailingActionAnchor,
} from "./renderer-composer-dom.js";
import { writeNewThreadAgentPreference } from "./renderer-new-thread-preference.js";
import { findNewChatButton } from "./settings/rly0-quick-start.js";

/**
 * Codex Desktop 26.1117.4957 (ChatGPT mode → Work) renders ChatGPT's own composer for a new
 * chat. Its conversations (`local-chatgpt:` drafts, `conversationOrigin: "tpp"`) are orchestrated
 * by the ChatGPT backend and only execute tools locally, so no app-server Thread exists that a
 * Harness could own. The Host cannot route such a message to another Agent. This bridge keeps the
 * Agent picker where people expect it and, on a choice, preselects the Agent for the next new
 * chat, switches Codex to its Codex mode and opens a new chat in the same project there, where the
 * regular Composer integration applies. It never intercepts the ChatGPT composer's submission.
 */

export const CHATGPT_WORK_BRIDGE_ATTRIBUTE = "data-codexhost-chatgpt-work-bridge";
export const CHATGPT_WORK_LABEL = "ChatGPT Work";
const WORK_COMPOSER_SELECTOR = "form[data-thread-find-composer]";
const PROJECT_ROW_ATTRIBUTE = "data-app-action-sidebar-project-id";
/** Work composer props sit within ~15 ancestors of the form; project ids may be further up. */
const COMPOSER_FIBER_DEPTH = 60;
/** The product-mode menu trigger is ~22 ancestors below its mode component. */
const MODE_CONTROL_FIBER_DEPTH = 40;
const MENU_WIDTH = 256;
const MODE_SWITCH_TIMEOUT_MS = 4_000;

export interface ChatGptWorkComposer {
  /** ChatGPT project of the conversation (also the sidebar project row id), when it has one. */
  readonly projectId: string | null;
}

export interface ProductModeControl {
  readonly mode: string;
  /** False when this Codex build or account does not offer the Codex mode. */
  readonly codexAvailable: boolean;
  select(mode: "codex"): void;
}

export type OpenInCodexModeResult = "opened" | "noModeSwitch" | "noNewChat";

export interface ChatGptWorkBridgeTarget {
  readonly agent: RendererAgent;
  readonly label: string;
  readonly plugin?: HarnessPluginDescriptor;
}

export interface ChatGptWorkBridgeOptions {
  /** Agents offered in the menu, Codex first; external ones only when ready to run. */
  readTargets(): readonly ChatGptWorkBridgeTarget[];
  readZh(): boolean;
}

export interface ChatGptWorkBridge {
  refresh(): void;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function reactFiberOf(element: Element): unknown {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
  return key ? Object.getOwnPropertyDescriptor(element, key)?.value : undefined;
}

function* boundedAncestorProps(
  element: Element,
  depth: number,
): Generator<Record<string, unknown>> {
  let visited = 0;
  for (const fiber of committedReactAncestors(reactFiberOf(element))) {
    if (visited++ >= depth) return;
    const props: unknown = fiber.memoizedProps;
    if (isRecord(props)) yield props;
  }
}

/**
 * A ChatGPT Work composer: published React props mark it as the Work surface (`isWork: true`)
 * of a ChatGPT-orchestrated conversation (`conversationOrigin: "tpp"`). Codex composers (with the
 * Codex root marker) and ordinary ChatGPT chat composers are never classified as one.
 */
export function chatGptWorkComposer(form: Element): ChatGptWorkComposer | null {
  if (form.closest(CODEX_COMPOSER_SELECTOR) || form.querySelector(CODEX_COMPOSER_SELECTOR))
    return null;
  let work = false;
  let tpp = false;
  let projectId: string | null = null;
  for (const props of boundedAncestorProps(form, COMPOSER_FIBER_DEPTH)) {
    if (props.isWork === true) work = true;
    if (props.conversationOrigin === "tpp") tpp = true;
    if (projectId === null && typeof props.projectId === "string" && props.projectId)
      projectId = props.projectId;
  }
  return work && tpp ? { projectId } : null;
}

/** Codex's own ChatGPT/Codex mode switch, found through its published React props. */
export function findProductModeControl(ownerDocument: Document): ProductModeControl | null {
  for (const trigger of ownerDocument.querySelectorAll('button[aria-haspopup="menu"]')) {
    for (const props of boundedAncestorProps(trigger, MODE_CONTROL_FIBER_DEPTH)) {
      if (typeof props.onModeSelect !== "function" || typeof props.mode !== "string") continue;
      const onModeSelect = props.onModeSelect as (mode: string) => void;
      return {
        mode: props.mode,
        codexAvailable: props.codexAvailable !== false && props.disabled !== true,
        select: (mode) => onModeSelect(mode),
      };
    }
  }
  return null;
}

/** The sidebar row's own "new chat" action (the row's other action is its menu). */
export function projectNewChatButton(
  ownerDocument: Document,
  projectId: string,
): HTMLButtonElement | null {
  const row = [...ownerDocument.querySelectorAll(`[${PROJECT_ROW_ATTRIBUTE}]`)].find(
    (element) => element.getAttribute(PROJECT_ROW_ATTRIBUTE) === projectId,
  );
  if (!row) return null;
  return (
    [...row.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        !button.disabled &&
        !button.hasAttribute("aria-haspopup") &&
        (button.getAttribute("aria-label") ?? "").trim() !== "",
    ) ?? null
  );
}

function waitFor(
  ownerWindow: Window,
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (condition()) {
      resolve(true);
      return;
    }
    const started = Date.now();
    const poll = ownerWindow.setInterval(() => {
      if (condition()) {
        ownerWindow.clearInterval(poll);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        ownerWindow.clearInterval(poll);
        resolve(false);
      }
    }, 50);
  });
}

/**
 * Preselects `agent` for the next new chat, switches Codex to its Codex mode and opens a new
 * chat there (in `projectId`'s sidebar project when it has a row, otherwise Codex's "New chat").
 * The preference is written first, so a person who finishes the switch by hand still gets it.
 */
export async function openAgentInCodexMode(
  ownerDocument: Document,
  agent: RendererAgent,
  projectId: string | null,
  timeoutMs = MODE_SWITCH_TIMEOUT_MS,
): Promise<OpenInCodexModeResult> {
  writeNewThreadAgentPreference(agent);
  const ownerWindow = ownerDocument.defaultView;
  const control = findProductModeControl(ownerDocument);
  if (!ownerWindow || !control) return "noModeSwitch";
  if (control.mode !== "codex") {
    if (!control.codexAvailable) return "noModeSwitch";
    control.select("codex");
    const switched = await waitFor(
      ownerWindow,
      () => findProductModeControl(ownerDocument)?.mode === "codex",
      timeoutMs,
    );
    if (!switched) return "noModeSwitch";
  }
  const newChat =
    (projectId ? projectNewChatButton(ownerDocument, projectId) : null) ??
    findNewChatButton(ownerDocument);
  if (!newChat) return "noNewChat";
  newChat.click();
  return "opened";
}

interface MountedBridge {
  readonly form: Element;
  readonly root: HTMLElement;
  readonly trigger: HTMLButtonElement;
  readonly menu: HTMLElement;
  readonly status: HTMLElement;
  projectId: string | null;
  busy: boolean;
}

function messages(zh: boolean) {
  return {
    triggerLabel: `Select Agent, current ${CHATGPT_WORK_LABEL}`,
    tooltip: zh
      ? "选助手：ChatGPT 工作模式由 OpenAI 云端运行，Hub 接管不了；选其他助手会切到 Codex 模式新开对话"
      : "Select Agent: ChatGPT Work runs in OpenAI's cloud and the Hub cannot take it over; picking an agent opens a new chat in Codex mode",
    note: zh
      ? "ChatGPT 工作模式的对话在 OpenAI 云端运行，Hub 接管不了。选一个助手，会切到 Codex 模式并新开对话。"
      : "ChatGPT Work chats run in OpenAI's cloud, so the Hub cannot take them over. Pick an agent to open a new chat in Codex mode.",
    current: zh ? "当前" : "Current",
    switching: zh ? "正在切到 Codex 模式…" : "Switching to Codex mode…",
    noModeSwitch: zh
      ? "没能自动切换。请在左上角把模式切到 Codex，再新建聊天，助手已经帮你选好。"
      : "Could not switch automatically. Switch the mode (top left) to Codex and start a new chat; the agent is already selected.",
    noNewChat: zh
      ? "已切到 Codex 模式。请点“新聊天”，助手已经帮你选好。"
      : "Switched to Codex mode. Start a new chat; the agent is already selected.",
  };
}

function styleTrigger(trigger: HTMLButtonElement): void {
  Object.assign(trigger.style, {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "30px",
    height: "28px",
    padding: "0",
    border: "0",
    borderRadius: "6px",
    background: "rgba(127, 127, 127, 0.08)",
    color: "inherit",
    cursor: "pointer",
  });
  trigger.addEventListener("pointerenter", () => {
    if (!trigger.disabled) trigger.style.background = "rgba(127, 127, 127, 0.16)";
  });
  trigger.addEventListener("pointerleave", () => {
    trigger.style.background = "rgba(127, 127, 127, 0.08)";
  });
}

function styleMenuRow(button: HTMLButtonElement): void {
  Object.assign(button.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    height: "36px",
    padding: "0 8px",
    border: "0",
    borderRadius: "4px",
    background: "transparent",
    color: "inherit",
    font: "500 13px/1 system-ui, sans-serif",
    letterSpacing: "0",
    textAlign: "left",
    cursor: "pointer",
  });
  const highlight = (active: boolean): void => {
    const selected = button.getAttribute("aria-checked") === "true";
    button.style.background =
      selected || (active && !button.disabled)
        ? `rgba(127, 127, 127, ${selected ? "0.16" : "0.1"})`
        : "transparent";
  };
  button.addEventListener("pointerenter", () => highlight(true));
  button.addEventListener("pointerleave", () => highlight(false));
  button.addEventListener("focus", () => highlight(true));
  button.addEventListener("blur", () => highlight(false));
  highlight(false);
}

/** Opens above the trigger, right-aligned to it, inside the viewport (Codex window zoom aware). */
export function chatGptWorkMenuPlacement(
  triggerRect: Pick<DOMRectReadOnly, "right" | "top">,
  viewport: { width: number; height: number },
  windowZoom: number,
): { left: number; bottom: number } {
  const zoom = Number.isFinite(windowZoom) && windowZoom > 0 ? windowZoom : 1;
  return {
    left: Math.max(
      8,
      Math.min(triggerRect.right / zoom - MENU_WIDTH, viewport.width / zoom - MENU_WIDTH - 8),
    ),
    bottom: Math.max(8, viewport.height / zoom - triggerRect.top / zoom + 6),
  };
}

function popoverOpen(menu: HTMLElement): boolean {
  try {
    return menu.matches(":popover-open");
  } catch {
    return !menu.hidden;
  }
}

/** Body-wide mutations arrive every frame while Codex streams; rescan at most this often. */
const SCAN_INTERVAL_MS = 150;

export function installChatGptWorkBridge(
  ownerDocument: Document,
  options: ChatGptWorkBridgeOptions,
): ChatGptWorkBridge {
  const ownerWindow = ownerDocument.defaultView ?? window;
  const mounted = new Map<Element, MountedBridge>();
  let disposed = false;
  let scheduled = false;
  let sequence = 0;
  let lastScan = Number.NEGATIVE_INFINITY;
  let timer: number | undefined;
  const now = (): number => ownerWindow.performance?.now() ?? Date.now();

  const closeMenu = (bridge: MountedBridge): void => {
    if (!popoverOpen(bridge.menu)) return;
    if (typeof bridge.menu.hidePopover === "function") bridge.menu.hidePopover();
    else bridge.menu.hidden = true;
    bridge.trigger.setAttribute("aria-expanded", "false");
  };

  const showStatus = (bridge: MountedBridge, text: string | null): void => {
    bridge.status.textContent = text ?? "";
    bridge.status.hidden = text === null;
  };

  const renderMenu = (bridge: MountedBridge): void => {
    const text = messages(options.readZh());
    bridge.trigger.setAttribute("aria-label", text.triggerLabel);
    bridge.trigger.title = text.tooltip;
    bridge.menu.replaceChildren();
    const note = ownerDocument.createElement("p");
    note.textContent = text.note;
    Object.assign(note.style, {
      margin: "0",
      padding: "6px 8px 8px",
      font: "400 12px/1.45 system-ui, sans-serif",
      opacity: "0.72",
    });
    const current = ownerDocument.createElement("button");
    current.type = "button";
    current.setAttribute("role", "menuitemradio");
    current.setAttribute("aria-checked", "true");
    current.dataset.agent = "chatgpt-work";
    styleMenuRow(current);
    const currentLabel = ownerDocument.createElement("span");
    currentLabel.textContent = CHATGPT_WORK_LABEL;
    currentLabel.style.flex = "1 1 auto";
    const currentTag = ownerDocument.createElement("span");
    currentTag.textContent = text.current;
    currentTag.setAttribute("aria-hidden", "true");
    Object.assign(currentTag.style, { font: "400 11px/1 system-ui, sans-serif", opacity: "0.6" });
    current.append(createSwitchIcon(ownerDocument), currentLabel, currentTag);
    current.addEventListener("click", () => {
      closeMenu(bridge);
      bridge.trigger.focus();
    });
    const divider = ownerDocument.createElement("div");
    divider.setAttribute("role", "separator");
    Object.assign(divider.style, {
      height: "1px",
      margin: "4px 4px",
      background: "rgba(127, 127, 127, 0.2)",
    });
    bridge.menu.append(note, current, divider);
    for (const target of options.readTargets()) {
      const row = ownerDocument.createElement("button");
      row.type = "button";
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", "false");
      row.dataset.agent = target.agent;
      row.disabled = bridge.busy;
      styleMenuRow(row);
      const label = ownerDocument.createElement("span");
      label.textContent = target.label;
      Object.assign(label.style, {
        minWidth: "0",
        flex: "1 1 auto",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      });
      row.append(createRendererAgentIcon(target.agent, 20, ownerDocument, target.plugin), label);
      row.addEventListener("click", () => void choose(bridge, target.agent));
      bridge.menu.append(row);
    }
    bridge.menu.append(bridge.status);
  };

  const openMenu = (bridge: MountedBridge): void => {
    if (bridge.trigger.disabled) return;
    renderMenu(bridge);
    const placement = chatGptWorkMenuPlacement(
      bridge.trigger.getBoundingClientRect(),
      { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight },
      Number.parseFloat(
        getComputedStyle(ownerDocument.documentElement)
          .getPropertyValue("--codex-window-zoom")
          .trim(),
      ),
    );
    bridge.menu.style.left = `${placement.left}px`;
    bridge.menu.style.bottom = `${placement.bottom}px`;
    if (!popoverOpen(bridge.menu)) {
      if (typeof bridge.menu.showPopover === "function") bridge.menu.showPopover();
      else bridge.menu.hidden = false;
    }
    bridge.trigger.setAttribute("aria-expanded", "true");
    queueMicrotask(() =>
      bridge.menu
        .querySelector<HTMLButtonElement>('[role="menuitemradio"]:not([disabled])')
        ?.focus(),
    );
  };

  const choose = async (bridge: MountedBridge, agent: RendererAgent): Promise<void> => {
    if (bridge.busy) return;
    const text = messages(options.readZh());
    bridge.busy = true;
    bridge.trigger.disabled = true;
    bridge.trigger.setAttribute("aria-busy", "true");
    showStatus(bridge, text.switching);
    closeMenu(bridge);
    let result: OpenInCodexModeResult;
    try {
      result = await openAgentInCodexMode(ownerDocument, agent, bridge.projectId);
    } catch {
      result = "noModeSwitch";
    }
    bridge.busy = false;
    bridge.trigger.disabled = false;
    bridge.trigger.removeAttribute("aria-busy");
    if (result === "opened" || !bridge.form.isConnected) {
      showStatus(bridge, null);
      return;
    }
    // Keep the explanation next to the picker that caused it.
    openMenu(bridge);
    showStatus(bridge, result === "noNewChat" ? text.noNewChat : text.noModeSwitch);
  };

  const mount = (form: Element, composer: ChatGptWorkComposer): void => {
    const send = sendButtonWithin(form);
    if (!send) return;
    const anchor = trailingActionAnchor(send);
    const id = `codexhost-chatgpt-work-${++sequence}`;
    const root = ownerDocument.createElement("div");
    root.setAttribute(CHATGPT_WORK_BRIDGE_ATTRIBUTE, id);
    Object.assign(root.style, {
      display: "inline-flex",
      alignItems: "center",
      alignSelf: "center",
      width: "30px",
      height: "28px",
      marginInline: "4px",
      color: "inherit",
    });
    const trigger = ownerDocument.createElement("button");
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    styleTrigger(trigger);
    const text = messages(options.readZh());
    trigger.setAttribute("aria-label", text.triggerLabel);
    trigger.title = text.tooltip;
    trigger.append(createSwitchIcon(ownerDocument));
    const menu = ownerDocument.createElement("div");
    menu.id = `${id}-menu`;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Agent");
    menu.setAttribute("popover", "auto");
    menu.hidden = typeof menu.showPopover !== "function";
    Object.assign(menu.style, {
      position: "fixed",
      inset: "auto",
      width: `${MENU_WIDTH}px`,
      padding: "4px",
      border: "0",
      borderRadius: "6px",
      background: "Canvas",
      color: "CanvasText",
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
      boxSizing: "border-box",
      maxHeight: "min(420px, calc(100vh - 16px))",
      overflowY: "auto",
      zIndex: "2147483647",
    });
    trigger.setAttribute("aria-controls", menu.id);
    const status = ownerDocument.createElement("p");
    status.setAttribute("role", "status");
    status.hidden = true;
    Object.assign(status.style, {
      margin: "4px 0 0",
      padding: "6px 8px",
      font: "400 12px/1.45 system-ui, sans-serif",
    });
    const bridge: MountedBridge = {
      form,
      root,
      trigger,
      menu,
      status,
      projectId: composer.projectId,
      busy: false,
    };
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (popoverOpen(menu)) closeMenu(bridge);
      else openMenu(bridge);
    });
    menu.addEventListener("toggle", () => {
      if (!popoverOpen(menu)) trigger.setAttribute("aria-expanded", "false");
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const rows = [
        ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not([disabled])'),
      ];
      const index = rows.indexOf(ownerDocument.activeElement as HTMLButtonElement);
      const next = rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
      event.preventDefault();
      next?.focus();
    });
    root.append(trigger, menu);
    anchor.before(root);
    mounted.set(form, bridge);
  };

  const unmount = (bridge: MountedBridge): void => {
    closeMenu(bridge);
    bridge.root.remove();
    mounted.delete(bridge.form);
  };

  // One composer whose props or DOM do not look as expected must not stop the others, later
  // scans or Codex itself: each step is isolated and a failed mount leaves nothing behind.
  const scan = (): void => {
    scheduled = false;
    timer = undefined;
    lastScan = now();
    if (disposed) return;
    for (const bridge of [...mounted.values()]) {
      try {
        const composer = bridge.form.isConnected ? chatGptWorkComposer(bridge.form) : null;
        if (!composer || !bridge.root.isConnected) unmount(bridge);
        else bridge.projectId = composer.projectId;
      } catch {
        try {
          unmount(bridge);
        } catch {
          mounted.delete(bridge.form);
        }
      }
    }
    let forms: Element[] = [];
    try {
      forms = [...ownerDocument.querySelectorAll(WORK_COMPOSER_SELECTOR)];
    } catch {
      return;
    }
    for (const form of forms) {
      if (mounted.has(form)) continue;
      try {
        const composer = chatGptWorkComposer(form);
        if (composer) mount(form, composer);
      } catch {
        const half = mounted.get(form);
        if (half) half.root.remove();
        mounted.delete(form);
      }
    }
  };

  /** Next frame; observer-driven rescans are throttled, an explicit refresh is not. */
  const schedule = (throttled = false): void => {
    if (disposed) return;
    if (!throttled && timer !== undefined) {
      // An explicit refresh does not wait out a throttled rescan: run it on the next frame.
      ownerWindow.clearTimeout(timer);
      timer = undefined;
      scheduled = false;
    }
    if (scheduled) return;
    scheduled = true;
    const wait = throttled ? lastScan + SCAN_INTERVAL_MS - now() : 0;
    if (wait > 0)
      timer = ownerWindow.setTimeout(() => {
        timer = undefined;
        if (!disposed) ownerWindow.requestAnimationFrame(scan);
      }, wait);
    else ownerWindow.requestAnimationFrame(scan);
  };

  const observer = new ownerWindow.MutationObserver((records) => {
    // Our own insertions and menu rendering never require a rescan.
    if (
      records.every((record) =>
        record.target instanceof ownerWindow.Element
          ? record.target.closest(`[${CHATGPT_WORK_BRIDGE_ATTRIBUTE}]`) !== null
          : false,
      )
    )
      return;
    schedule(true);
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    if (timer !== undefined) ownerWindow.clearTimeout(timer);
    for (const bridge of [...mounted.values()]) {
      try {
        unmount(bridge);
      } catch {
        mounted.delete(bridge.form);
      }
    }
  };
  try {
    if (ownerDocument.body)
      observer.observe(ownerDocument.body, { childList: true, subtree: true });
    scan();
  } catch (error) {
    // Never leave an observer running behind a failed install.
    dispose();
    throw error;
  }

  return {
    refresh: () => schedule(),
    dispose,
  };
}

function createSwitchIcon(ownerDocument: Document): Element {
  const icon = createLucideElement(ArrowLeftRight, {
    width: 16,
    height: 16,
    "aria-hidden": "true",
    "stroke-width": 2,
  });
  return ownerDocument.importNode(icon, true);
}
