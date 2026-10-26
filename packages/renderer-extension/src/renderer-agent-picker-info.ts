/**
 * The Agent menu's one-line header: a short title and an ⓘ button whose tooltip holds the
 * longer notes (handoff explanation, Codex resources shared with the Agent). Long notes stay out
 * of the menu so the Agent list sits right under the header.
 */

export interface AgentPickerInfoContent {
  /** Short header title; empty leaves only the ⓘ button. */
  readonly title: string;
  /** Tooltip paragraphs, in order; the first is the main explanation. */
  readonly paragraphs: readonly string[];
}

export interface AgentPickerInfoControl {
  readonly root: HTMLElement;
  readonly title: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly tooltip: HTMLElement;
  /** Null hides the header. */
  render(content: AgentPickerInfoContent | null): void;
  isOpen(): boolean;
  close(): void;
  dispose(): void;
}

const TOOLTIP_MAX_WIDTH = 280;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_GAP = 6;
const CLOSE_DELAY_MS = 120;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Viewport-clamped tooltip position, in the menu's CSS pixels (after the Codex window zoom). */
export function agentPickerInfoPlacement(
  anchor: Pick<DOMRectReadOnly, "top" | "bottom" | "right">,
  tooltipHeight: number,
  viewport: { width: number; height: number },
  zoom: number,
): { left: number; top: number; width: number } {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const width = Math.max(
    0,
    Math.min(TOOLTIP_MAX_WIDTH, viewport.width / scale - TOOLTIP_MARGIN * 2),
  );
  const height = tooltipHeight / scale;
  const viewportWidth = viewport.width / scale;
  const viewportHeight = viewport.height / scale;
  const left = Math.max(
    TOOLTIP_MARGIN,
    Math.min(anchor.right / scale - width, viewportWidth - width - TOOLTIP_MARGIN),
  );
  const above = anchor.top / scale - TOOLTIP_GAP - height;
  const top =
    above >= TOOLTIP_MARGIN
      ? above
      : Math.max(
          TOOLTIP_MARGIN,
          Math.min(anchor.bottom / scale + TOOLTIP_GAP, viewportHeight - height - TOOLTIP_MARGIN),
        );
  return { left, top, width };
}

function infoIcon(document: Document): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.3");
  svg.setAttribute("stroke-linecap", "round");
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "8");
  circle.setAttribute("cy", "8");
  circle.setAttribute("r", "6.35");
  const stem = document.createElementNS(SVG_NS, "path");
  stem.setAttribute("d", "M8 7.2v3.8");
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", "8");
  dot.setAttribute("cy", "4.9");
  dot.setAttribute("r", "0.45");
  dot.setAttribute("fill", "currentColor");
  svg.append(circle, stem, dot);
  return svg;
}

function cssZoom(element: Element): number {
  const zoom = (element as Element & { currentCSSZoom?: number }).currentCSSZoom;
  return typeof zoom === "number" && zoom > 0 ? zoom : 1;
}

export function mountAgentPickerInfo(
  idPrefix: string,
  buttonLabel: string,
): AgentPickerInfoControl {
  const root = document.createElement("div");
  root.dataset.codexhostAgentNote = "true";
  root.hidden = true;
  root.style.display = "flex";
  root.style.alignItems = "center";
  root.style.gap = "4px";
  root.style.height = "28px";
  root.style.padding = "0 2px 0 8px";
  root.style.marginBottom = "2px";
  root.style.borderBottom = "1px solid rgba(127, 127, 127, 0.16)";
  root.style.boxSizing = "border-box";
  root.style.font = "500 12px/1 system-ui, sans-serif";
  root.style.letterSpacing = "0";

  const title = document.createElement("span");
  title.dataset.codexhostAgentNoteTitle = "true";
  title.style.minWidth = "0";
  title.style.flex = "1 1 auto";
  title.style.overflow = "hidden";
  title.style.textOverflow = "ellipsis";
  title.style.whiteSpace = "nowrap";
  title.style.opacity = "0.72";

  const tooltip = document.createElement("div");
  tooltip.id = `${idPrefix}-agent-note`;
  tooltip.dataset.codexhostAgentNoteTooltip = "true";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  // A child of the menu popover, so it shares the top layer and hovering it keeps the menu open.
  Object.assign(tooltip.style, {
    position: "fixed",
    inset: "auto",
    margin: "0",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: "8px",
    border: "1px solid var(--color-border-tooltip, rgba(255, 255, 255, 0.05))",
    background: "var(--color-background-tooltip, #2d2d2d)",
    color: "var(--color-text-tooltip, #ffffff)",
    boxShadow: "var(--shadow-tooltip, 0 8px 18px rgba(15, 23, 42, 0.2))",
    font: "400 12px/1.5 system-ui, sans-serif",
    letterSpacing: "0",
    textAlign: "left",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    zIndex: "1",
  } satisfies Partial<CSSStyleDeclaration>);

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.codexhostAgentNoteInfo = "true";
  button.setAttribute("aria-label", buttonLabel);
  button.setAttribute("aria-describedby", tooltip.id);
  Object.assign(button.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    width: "24px",
    height: "24px",
    marginLeft: "auto",
    padding: "0",
    border: "0",
    borderRadius: "4px",
    background: "transparent",
    color: "inherit",
    opacity: "0.72",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  button.append(infoIcon(document));
  root.append(title, button, tooltip);

  let pinned = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelClose = (): void => {
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  const isOpen = (): boolean => !tooltip.hidden;
  const position = (): void => {
    const zoom = cssZoom(tooltip);
    const { width } = agentPickerInfoPlacement(
      button.getBoundingClientRect(),
      0,
      { width: window.innerWidth, height: window.innerHeight },
      zoom,
    );
    tooltip.style.width = `${width}px`;
    const placement = agentPickerInfoPlacement(
      button.getBoundingClientRect(),
      tooltip.getBoundingClientRect().height,
      { width: window.innerWidth, height: window.innerHeight },
      zoom,
    );
    tooltip.style.left = `${placement.left}px`;
    tooltip.style.top = `${placement.top}px`;
  };
  const highlight = (): void => {
    const active = isOpen() || button.matches(":hover");
    button.style.background = active ? "rgba(127, 127, 127, 0.12)" : "transparent";
    button.style.opacity = active ? "1" : "0.72";
  };
  const open = (): void => {
    cancelClose();
    if (root.hidden) return;
    tooltip.hidden = false;
    position();
    highlight();
  };
  const close = (): void => {
    cancelClose();
    pinned = false;
    tooltip.hidden = true;
    highlight();
  };
  const scheduleClose = (): void => {
    cancelClose();
    // Lets the pointer cross into the tooltip to read or select its text.
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (
        !pinned &&
        !button.matches(":hover") &&
        !tooltip.matches(":hover") &&
        document.activeElement !== button
      ) {
        close();
      }
    }, CLOSE_DELAY_MS);
  };

  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  button.addEventListener("pointerenter", open, options);
  button.addEventListener("pointerleave", scheduleClose, options);
  button.addEventListener("focus", open, options);
  button.addEventListener(
    "blur",
    () => {
      pinned = false;
      scheduleClose();
    },
    options,
  );
  button.addEventListener(
    "click",
    () => {
      if (pinned && isOpen()) {
        close();
        return;
      }
      open();
      pinned = true;
    },
    options,
  );
  tooltip.addEventListener("pointerenter", cancelClose, options);
  tooltip.addEventListener("pointerleave", scheduleClose, options);

  return {
    root,
    title,
    button,
    tooltip,
    render(content) {
      root.hidden = !content;
      root.style.display = content ? "flex" : "none";
      title.textContent = content?.title ?? "";
      tooltip.replaceChildren(
        ...(content?.paragraphs ?? []).map((text, index) => {
          const paragraph = document.createElement("div");
          paragraph.textContent = text;
          if (index > 0) {
            paragraph.style.marginTop = "6px";
            paragraph.style.color = "color-mix(in srgb, currentColor 72%, transparent)";
          }
          return paragraph;
        }),
      );
      if (!content) close();
      else if (isOpen()) position();
    },
    isOpen,
    close,
    dispose() {
      close();
      listeners.abort();
    },
  };
}
