import type { RendererSettingsLocale } from "./localization.js";

/** Set once the person dismissed the welcome card; it never shows again after that. */
export const RLY0_WELCOME_DISMISSED_STORAGE_KEY = "codexhost.rly0-welcome-dismissed.v1";

export interface Rly0WelcomeMessages {
  readonly title: string;
  readonly intro: string;
  readonly openTitle: string;
  readonly openBody: string;
  readonly entryTitle: string;
  readonly entryBody: string;
  readonly accountTitle: string;
  readonly accountBody: string;
  readonly accountAction: string;
  readonly relayTitle: string;
  readonly relayBody: string;
  readonly relayAction: string;
  readonly backupTitle: string;
  readonly backupBody: string;
  readonly backupAction: string;
  readonly dismiss: string;
}

const english: Rly0WelcomeMessages = {
  title: "Welcome to RLY/0 Hub",
  intro: "A few things worth knowing before you start:",
  openTitle: "Open Codex through RLY/0 Hub",
  openBody:
    "Use the RLY/0 Hub shortcut from now on. If you open the official Codex directly, it works as usual but without RLY/0 Hub.",
  entryTitle: "Find RLY/0 Hub inside Codex",
  entryBody: "Click the RLY/0 icon in Codex's left sidebar to come back to these pages.",
  accountTitle: "Save your current account (optional)",
  accountBody: "Only needed if you use more than one account. Your login itself is not changed.",
  accountAction: "Go to Accounts",
  relayTitle: "Use a relay (optional)",
  relayBody:
    "GPT models from a relay appear in Codex's model picker; Claude models can run in Claude Code through the relay.",
  relayAction: "Go to Relays",
  backupTitle: "Your Codex settings are backed up",
  backupBody:
    "A copy was saved the first time RLY/0 Hub ran. You can restore it at any time under Maintenance.",
  backupAction: "View",
  dismiss: "Got it, don't show again",
};

const chinese: Rly0WelcomeMessages = {
  title: "欢迎使用 RLY/0 Hub",
  intro: "开始之前，有几件事值得知道：",
  openTitle: "以后通过 RLY/0 Hub 打开 Codex",
  openBody:
    "请用 RLY/0 Hub 的快捷方式打开。直接打开原版 Codex 也能正常用，只是没有 RLY/0 Hub 的功能。",
  entryTitle: "在 Codex 里找到 RLY/0 Hub",
  entryBody: "点 Codex 左侧栏的 RLY/0 图标，就能回到这些页面。",
  accountTitle: "保存当前账号（可选）",
  accountBody: "只有使用多个账号时才需要。不会改动你当前的登录。",
  accountAction: "去账号页",
  relayTitle: "使用中转站（可选）",
  relayBody:
    "中转站的 GPT 模型会出现在 Codex 的模型菜单里；Claude 模型可以让 Claude Code 走中转使用。",
  relayAction: "去中转站",
  backupTitle: "已为你备份 Codex 设置",
  backupBody: "RLY/0 Hub 第一次运行时保存了一份，随时可以在“维护工具”里还原。",
  backupAction: "查看",
  dismiss: "知道了，不再显示",
};

export function rly0WelcomeMessages(locale: RendererSettingsLocale): Rly0WelcomeMessages {
  return locale === "zh-CN" ? chinese : english;
}

function readDismissed(view: Window | null): boolean {
  try {
    return view?.localStorage.getItem(RLY0_WELCOME_DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * First-run welcome card for the dashboard. Returns `null` once dismissed. Each step that has a
 * place to go gets a button; the card never changes anything by itself.
 */
export function createRly0Welcome(
  document: Document,
  locale: RendererSettingsLocale,
  navigate: ((pageId: string) => void) | undefined,
): HTMLElement | null {
  const view = document.defaultView;
  if (readDismissed(view)) return null;
  const text = rly0WelcomeMessages(locale);
  const card = document.createElement("section");
  card.className = "settings-rly0-welcome";
  card.setAttribute("aria-label", text.title);
  const title = document.createElement("h2");
  title.className = "settings-rly0-welcome__title";
  title.textContent = text.title;
  const intro = document.createElement("p");
  intro.className = "settings-rly0-welcome__intro";
  intro.textContent = text.intro;
  const list = document.createElement("ol");
  list.className = "settings-rly0-welcome__steps";
  const step = (heading: string, body: string, action?: { label: string; page: string }): void => {
    const item = document.createElement("li");
    item.className = "settings-rly0-welcome__step";
    const copy = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = heading;
    const detail = document.createElement("span");
    detail.textContent = body;
    copy.append(strong, detail);
    item.append(copy);
    if (action && navigate) {
      const go = document.createElement("button");
      go.type = "button";
      go.className = "settings-command-button settings-command-button--secondary";
      go.textContent = action.label;
      go.addEventListener("click", () => navigate(action.page));
      item.append(go);
    }
    list.append(item);
  };
  step(text.openTitle, text.openBody);
  step(text.entryTitle, text.entryBody);
  step(text.accountTitle, text.accountBody, { label: text.accountAction, page: "accounts" });
  step(text.relayTitle, text.relayBody, { label: text.relayAction, page: "relay" });
  step(text.backupTitle, text.backupBody, { label: text.backupAction, page: "maintenance" });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "settings-command-button settings-rly0-welcome__dismiss";
  dismiss.textContent = text.dismiss;
  dismiss.addEventListener("click", () => {
    try {
      view?.localStorage.setItem(RLY0_WELCOME_DISMISSED_STORAGE_KEY, "1");
    } catch {
      // Storage unavailable: hide it for now; it may show again next time.
    }
    card.remove();
  });
  card.append(title, intro, list, dismiss);
  return card;
}
