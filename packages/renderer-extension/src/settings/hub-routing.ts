import type { Rly0HubPage } from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./localization.js";
import type { DefaultRendererSettingsPageId } from "./pages.js";

/**
 * Where each former in-Codex settings page lives in the RLY/0 Hub window. With the Hub installed
 * nothing of the settings surface mounts inside Codex: the rail icon and every other entry open
 * the Hub on the matching page.
 */
export const HUB_PAGE_FOR_SETTINGS_PAGE: Readonly<
  Record<DefaultRendererSettingsPageId, Rly0HubPage>
> = {
  dashboard: "home",
  connections: "agents",
  "remote-connections": "remote",
  accounts: "accounts",
  relay: "relays",
  "session-import": "sessions",
  threads: "threads",
  mcp: "mcp",
  skills: "skills",
  maintenance: "maintenance",
  "usage-statistics": "usage",
  appearance: "general",
  updates: "updates",
  about: "support",
};

/** The Hub page for a settings page ID; the Hub's 首页 for the rail icon and unknown IDs. */
export function hubPageForSettingsPage(pageId: string | undefined): Rly0HubPage {
  return (
    (HUB_PAGE_FOR_SETTINGS_PAGE as Readonly<Record<string, Rly0HubPage>>)[pageId ?? ""] ?? "home"
  );
}

interface NoticeMessages {
  readonly text: string;
  readonly open: string;
  readonly opening: string;
  readonly close: string;
}

const NOTICE_MESSAGES: Readonly<Record<"zh" | "en", NoticeMessages>> = {
  zh: { text: "RLY/0 Hub 没在运行", open: "打开 RLY/0 Hub", opening: "正在打开…", close: "关闭" },
  en: {
    text: "RLY/0 Hub is not running",
    open: "Open RLY/0 Hub",
    opening: "Opening…",
    close: "Close",
  },
};

export const HUB_NOTICE_ATTRIBUTE = "data-codexhost-hub-notice";

// RLY/0 brand: ink surface, paper text, brand red only as a graphic (the dot), radii 7 / 10.
const NOTICE_CSS = `
.notice{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:10px;
  padding:8px 8px 8px 12px;border-radius:10px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
  color:#e9e9e3;background:#171714;border:1px solid rgba(233,233,227,.12);
  box-shadow:0 18px 48px rgba(0,0,0,.22)}
.notice::before{content:"";width:8px;height:8px;border-radius:999px;background:#b83220;flex:none}
.notice button{font:inherit;cursor:pointer;border-radius:7px;border:0}
.open{padding:4px 10px;color:#11110e;background:#e9e9e3;font-weight:600}
.open:disabled{opacity:.6;cursor:default}
.close{width:24px;height:24px;color:inherit;background:transparent;opacity:.7}
.close:hover{opacity:1}
`;

export interface HubUnavailableNotice {
  dispose(): void;
}

/**
 * The only thing Codex shows when the Hub cannot be reached: one line beside the rail icon with a
 * button that tries again. Replaces any earlier notice; Escape, the close button, or a click
 * elsewhere dismisses it.
 */
export function showHubUnavailableNotice(
  ownerDocument: Document,
  locale: RendererSettingsLocale,
  anchor: HTMLElement | undefined,
  retry: () => Promise<boolean>,
): HubUnavailableNotice {
  ownerDocument.querySelector(`[${HUB_NOTICE_ATTRIBUTE}]`)?.remove();
  const text = NOTICE_MESSAGES[locale === "zh-CN" ? "zh" : "en"];
  const host = ownerDocument.createElement("div");
  host.setAttribute(HUB_NOTICE_ATTRIBUTE, "v1");
  const shadow = host.attachShadow({ mode: "open" });
  const style = ownerDocument.createElement("style");
  style.textContent = NOTICE_CSS;
  const box = ownerDocument.createElement("div");
  box.className = "notice";
  box.setAttribute("role", "status");
  const label = ownerDocument.createElement("span");
  label.textContent = `${text.text} ·`;
  const open = ownerDocument.createElement("button");
  open.type = "button";
  open.className = "open";
  open.textContent = text.open;
  const close = ownerDocument.createElement("button");
  close.type = "button";
  close.className = "close";
  close.setAttribute("aria-label", text.close);
  close.textContent = "×";
  box.append(label, open, close);
  shadow.append(style, box);

  const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  box.style.left = `${Math.round((rect?.right ?? 56) + 8)}px`;
  box.style.top = `${Math.round(rect?.top ?? 12)}px`;

  let disposed = false;
  const view = ownerDocument.defaultView;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dispose();
  };
  const onPointerDown = (event: Event): void => {
    if (!event.composedPath().includes(host)) dispose();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    ownerDocument.removeEventListener("keydown", onKeyDown, true);
    ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
    host.remove();
  };
  open.addEventListener("click", () => {
    open.disabled = true;
    open.textContent = text.opening;
    void retry()
      .catch(() => false)
      .then((ok) => {
        if (ok) dispose();
        else if (!disposed) {
          open.disabled = false;
          open.textContent = text.open;
        }
      });
  });
  close.addEventListener("click", dispose);
  ownerDocument.addEventListener("keydown", onKeyDown, true);
  // Registered after this click finishes, so the click that showed the notice does not close it.
  view?.setTimeout(() => {
    if (!disposed) ownerDocument.addEventListener("pointerdown", onPointerDown, true);
  }, 0);
  ownerDocument.body.append(host);
  return { dispose };
}
