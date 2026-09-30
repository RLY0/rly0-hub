import rly0MarkUrl from "../assets/codexhost-app-icon.svg";
import type { RelayMessages } from "./relay-messages.js";

export const RLY0_RELAY_PROMO_URL = "https://rly0.com";
export const RLY0_RELAY_PROMO_DISMISSED_KEY = "codexhost.rly0-relay-promo-dismissed.v1";

export function readRly0ShowcaseDismissed(view: Window | null): boolean {
  try {
    return view?.localStorage.getItem(RLY0_RELAY_PROMO_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeRly0ShowcaseDismissed(view: Window | null): void {
  try {
    view?.localStorage.setItem(RLY0_RELAY_PROMO_DISMISSED_KEY, "1");
  } catch {
    // Dismissal then lasts only for this page visit.
  }
}

export interface Rly0ShowcaseOptions {
  /** Smaller banner for pages where the relay is not the main subject. */
  readonly compact?: boolean;
  readonly onDismiss?: () => void;
}

/**
 * Author-run relay showcase. It is clearly labelled as the author's own ad, only links out to
 * rly0.com in the browser, never touches request routing, and can be dismissed for good.
 * Returns `null` when the viewer has already dismissed it.
 */
export function createRly0Showcase(
  document: Document,
  messages: RelayMessages,
  options: Rly0ShowcaseOptions = {},
): HTMLElement | null {
  const view = document.defaultView ?? null;
  if (readRly0ShowcaseDismissed(view)) return null;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const root = el(
    "section",
    options.compact
      ? "settings-rly0-relay__promo settings-rly0-showcase settings-rly0-showcase--compact"
      : "settings-rly0-relay__promo settings-rly0-showcase",
  );
  root.setAttribute("aria-label", `${messages.promoTitle} · ${messages.promoBadge}`);

  // Decorative layers: moving grid, sweeping signal line and a glow. Hidden from assistive tech.
  const backdrop = el("div", "settings-rly0-showcase__backdrop");
  backdrop.setAttribute("aria-hidden", "true");
  backdrop.append(
    el("span", "settings-rly0-showcase__grid"),
    el("span", "settings-rly0-showcase__glow"),
    el("span", "settings-rly0-showcase__signal"),
  );

  const mark = el("div", "settings-rly0-showcase__mark");
  mark.setAttribute("aria-hidden", "true");
  const logo = el("img", "settings-rly0-showcase__logo");
  logo.src = rly0MarkUrl;
  logo.alt = "";
  mark.append(
    el("span", "settings-rly0-showcase__ring"),
    el("span", "settings-rly0-showcase__ring settings-rly0-showcase__ring--late"),
    logo,
  );

  const body = el("div", "settings-rly0-showcase__body");
  const kicker = el("div", "settings-rly0-showcase__kicker");
  kicker.append(
    el("span", "settings-rly0-showcase__dot"),
    el("span", "settings-rly0-relay__badge settings-rly0-showcase__badge", messages.promoBadge),
    el("span", "settings-rly0-showcase__kicker-text", messages.promoKicker),
  );
  const title = el("strong", "settings-rly0-showcase__title", messages.promoTitle);
  const tagline = el("span", "settings-rly0-showcase__tagline", messages.promoTagline);
  const address = el("code", "settings-rly0-showcase__url");
  address.append(
    el("span", "settings-rly0-showcase__url-text", "rly0.com"),
    el("span", "settings-rly0-showcase__cursor"),
  );
  address.setAttribute("aria-hidden", "true");
  body.append(kicker, title, tagline);
  if (!options.compact) {
    const chips = el("ul", "settings-rly0-showcase__chips");
    for (const chip of messages.promoChips) {
      chips.append(el("li", "settings-rly0-showcase__chip", chip));
    }
    body.append(el("span", "settings-rly0-showcase__note", messages.promoBody), chips);
  }

  const link = el("a", "settings-command-button settings-rly0-showcase__cta");
  link.href = RLY0_RELAY_PROMO_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = messages.promoOpen;
  const dismiss = el(
    "button",
    "settings-command-button settings-command-button--secondary settings-rly0-showcase__dismiss",
    messages.promoDismiss,
  );
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", `${messages.promoDismiss} ${messages.promoTitle}`);
  dismiss.addEventListener("click", () => {
    writeRly0ShowcaseDismissed(view);
    root.hidden = true;
    root.replaceChildren();
    options.onDismiss?.();
  });
  const actions = el("div", "settings-rly0-relay__actions settings-rly0-showcase__actions");
  actions.append(address, link, dismiss);

  root.append(backdrop, mark, body, actions);
  return root;
}
