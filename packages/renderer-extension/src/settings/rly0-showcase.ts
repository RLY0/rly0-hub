import rly0MarkUrl from "../assets/codexhost-app-icon.svg";
import type { RelayMessages } from "./relay-messages.js";

export const RLY0_RELAY_PROMO_URL = "https://rly0.com";
export interface Rly0ShowcaseOptions {
  /** Single-row card for pages where the relay is not the main subject. */
  readonly compact?: boolean;
}

/**
 * Author-run relay card. It is clearly labelled as the author's own ad, only links out to
 * rly0.com in the browser, never touches request routing, and always stays on the page.
 * Layout: a small "ad · run by the author" caption, then the brand
 * (logo, name, one-line description), a route diagram showing what a relay does, and one link.
 */
export function createRly0Showcase(
  document: Document,
  messages: RelayMessages,
  options: Rly0ShowcaseOptions = {},
): HTMLElement {
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

  const caption = el("div", "settings-rly0-showcase__caption");
  const label = el("span", "settings-rly0-showcase__label");
  label.append(
    el("span", "settings-rly0-showcase__tag", messages.promoKicker),
    el("span", "settings-rly0-showcase__owner", messages.promoBadge),
  );
  caption.append(label);

  const brand = el("div", "settings-rly0-showcase__brand");
  const logo = el("img", "settings-rly0-showcase__logo");
  logo.src = rly0MarkUrl;
  logo.alt = "";
  const identity = el("div", "settings-rly0-showcase__identity");
  identity.append(
    el("strong", "settings-rly0-showcase__title", messages.promoTitle),
    el("span", "settings-rly0-showcase__tagline", messages.promoTagline),
  );
  brand.append(logo, identity);

  const link = el("a", "settings-rly0-showcase__cta");
  link.href = RLY0_RELAY_PROMO_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = messages.promoOpen;

  const main = el("div", "settings-rly0-showcase__main");
  main.append(brand);
  if (!options.compact) {
    // What a relay does, as a picture: your tool → RLY/0 → the model vendors. Decorative only.
    const route = el("div", "settings-rly0-showcase__route");
    route.setAttribute("aria-hidden", "true");
    const line = (): HTMLElement => {
      const wire = el("span", "settings-rly0-showcase__wire");
      wire.append(el("span", "settings-rly0-showcase__pulse"));
      return wire;
    };
    route.append(
      el("span", "settings-rly0-showcase__node", messages.promoRouteFrom),
      line(),
      el("span", "settings-rly0-showcase__node settings-rly0-showcase__node--hub", "RLY/0"),
      line(),
      el("span", "settings-rly0-showcase__node", messages.promoRouteTo),
    );
    main.append(route);
  }
  main.append(link);

  root.append(caption, main);
  return root;
}
