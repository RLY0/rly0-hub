import type { Rly0HubOpenResult } from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./localization.js";

interface HubEntryMessages {
  readonly title: string;
  readonly body: string;
  readonly open: string;
  readonly opening: string;
  readonly unavailable: string;
  readonly failed: string;
}

const chinese: HubEntryMessages = {
  title: "RLY/0 Hub 独立窗口",
  body: "零号余额、AI 助手、中转站、账号和备份，都在独立窗口里管，不开 Codex 也能用。",
  open: "打开 RLY/0 Hub",
  opening: "正在打开…",
  unavailable: "这个版本没有独立窗口。",
  failed: "没能打开，请从开始菜单或托盘打开 RLY/0 Hub。",
};

const english: HubEntryMessages = {
  title: "RLY/0 Hub window",
  body: "Balance, AI agents, relays, accounts and backups live in the standalone window, even without Codex.",
  open: "Open RLY/0 Hub",
  opening: "Opening…",
  unavailable: "This build has no standalone window.",
  failed: "Could not open it. Open RLY/0 Hub from the Start menu or tray.",
};

/** Dashboard entry to the standalone Hub window, where management now lives. */
export function createRly0HubEntry(
  document: Document,
  locale: RendererSettingsLocale,
  open: () => Promise<Rly0HubOpenResult>,
): HTMLElement {
  const text = locale === "zh-CN" ? chinese : english;
  const card = document.createElement("section");
  card.className = "settings-rly0-hub-entry";
  card.setAttribute("aria-label", text.title);
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = text.title;
  const body = document.createElement("span");
  body.textContent = text.body;
  copy.append(title, body);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-command-button settings-rly0-hub-entry__open";
  button.textContent = text.open;
  const note = document.createElement("span");
  note.className = "settings-rly0-hub-entry__note";
  note.setAttribute("role", "status");
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = text.opening;
    note.textContent = "";
    void open()
      .then(
        (result) => {
          if (!result.available) note.textContent = text.unavailable;
          else if (!result.ok) note.textContent = text.failed;
        },
        () => {
          note.textContent = text.failed;
        },
      )
      .finally(() => {
        button.disabled = false;
        button.textContent = text.open;
      });
  });
  card.append(copy, button, note);
  return card;
}
