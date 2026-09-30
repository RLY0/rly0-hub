import alipayQrUrl from "../assets/sponsor-alipay.jpg";
import wechatQrUrl from "../assets/sponsor-wechat.jpg";
import { createRendererSettingsIcon } from "./icons.js";
import { RLY0_RELAY_URL, type RendererSponsorMessages } from "./localization.js";

/**
 * Voluntary sponsorship entry for the About page. The dialog is local-only: it
 * never opens by itself, makes no network requests, and records nothing.
 */
export function createSponsorEntry(
  document: Document,
  host: Element,
  messages: RendererSponsorMessages,
  signal: AbortSignal,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "settings-command-button settings-command-button--secondary settings-sponsor-entry";
  button.dataset.sponsorEntry = "true";
  button.setAttribute("aria-haspopup", "dialog");
  const label = document.createElement("span");
  label.textContent = messages.entry;
  button.append(createRendererSettingsIcon("coffee", 15), label);

  let dialog: HTMLDialogElement | undefined;
  button.addEventListener("click", () => {
    if (dialog || signal.aborted) return;
    dialog = openSponsorDialog(document, host, messages, () => {
      dialog = undefined;
      button.focus();
    });
  });
  signal.addEventListener("abort", () => dialog?.remove(), { once: true });
  return button;
}

function qrCode(document: Document, source: string, label: string, kind: string): HTMLElement {
  const item = document.createElement("div");
  item.className = "settings-sponsor-dialog__code flex min-w-0 flex-col items-center gap-2";
  item.dataset.sponsorCode = kind;
  const image = document.createElement("img");
  image.className = "block h-auto w-full max-w-[220px] rounded-lg bg-white object-contain";
  image.src = source;
  image.alt = label;
  image.draggable = false;
  const caption = document.createElement("span");
  caption.className = "text-[13px] leading-5 font-semibold text-settings-text";
  caption.textContent = label;
  item.append(image, caption);
  return item;
}

export function openSponsorDialog(
  document: Document,
  host: Element,
  messages: RendererSponsorMessages,
  onClosed?: () => void,
): HTMLDialogElement {
  const modal = document.createElement("dialog");
  modal.className = "settings-account-dialog settings-sponsor-dialog";
  modal.setAttribute("aria-label", messages.title);

  const header = document.createElement("div");
  header.className = "settings-sponsor-dialog__header";
  const title = document.createElement("h2");
  title.textContent = messages.title;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "settings-icon-button settings-sponsor-dialog__close";
  closeButton.setAttribute("aria-label", messages.close);
  closeButton.title = messages.close;
  closeButton.append(createRendererSettingsIcon("close", 16));
  header.append(title, closeButton);

  const description = document.createElement("p");
  description.className = "settings-sponsor-dialog__description";
  description.textContent = messages.description;

  const codes = document.createElement("div");
  codes.className = "settings-sponsor-dialog__codes grid grid-cols-1 gap-4 sm:grid-cols-2";
  codes.append(
    qrCode(document, wechatQrUrl, messages.wechat, "wechat"),
    qrCode(document, alipayQrUrl, messages.alipay, "alipay"),
  );

  const relay = document.createElement("p");
  relay.className = "settings-sponsor-dialog__relay";
  const relayPrefix = document.createElement("span");
  relayPrefix.textContent = messages.relayPrefix;
  const relayLink = document.createElement("a");
  relayLink.className = "settings-sponsor-dialog__relay-link";
  relayLink.href = RLY0_RELAY_URL;
  relayLink.target = "_blank";
  relayLink.rel = "noopener noreferrer";
  const relayName = document.createElement("span");
  relayName.textContent = messages.relayName;
  const relayUrl = document.createElement("code");
  relayUrl.textContent = RLY0_RELAY_URL;
  relayLink.append(relayName, relayUrl);
  relay.append(relayPrefix, relayLink);

  modal.append(header, description, codes, relay);

  const close = (): void => modal.close();
  closeButton.addEventListener("click", close);
  modal.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  modal.addEventListener("close", () => {
    modal.remove();
    onClosed?.();
  });

  host.append(modal);
  modal.showModal();
  closeButton.focus();
  return modal;
}
