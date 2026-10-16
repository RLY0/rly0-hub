import type {
  Rly0AgentAuthLoginParams,
  Rly0AgentAuthLoginResult,
  Rly0AgentAuthStatus,
  Rly0MaintenanceProcessActionResult,
  Rly0Relay,
  Rly0RelayAddParams,
  Rly0RelayAddResult,
  Rly0RelayAgentsResult,
  Rly0RelayAgentsSetParams,
  Rly0RelayListResult,
  Rly0RelayMutationResult,
  Rly0RelayTestParams,
  Rly0RelayTestResult,
  Rly0RelayUpdateParams,
} from "@codexhost/shared-contracts";

import type { RendererAgent } from "../agent-selection-state.js";
import { writeNewThreadAgentPreference } from "../renderer-new-thread-preference.js";

/**
 * "Start using Claude Code" in as few clicks as possible: when Claude Code can already run (its own
 * login, or a relay it is running through), one button opens a new Codex chat with Claude Code
 * selected. Otherwise it offers the two ways to pay for it (sign in with a Claude subscription, or
 * the RLY/0 relay with a pasted key) and does the rest by itself, including the Codex restart a
 * relay needs, after which the new chat opens automatically.
 */

export interface ClaudeQuickStartClient {
  rly0ClaudeCodeAuthStatus?(): Promise<Rly0AgentAuthStatus>;
  rly0ClaudeCodeLogin?(input: Rly0AgentAuthLoginParams): Promise<Rly0AgentAuthLoginResult>;
  rly0RelayAgentsGet?(): Promise<Rly0RelayAgentsResult>;
  rly0RelayAgentsSet?(input: Rly0RelayAgentsSetParams): Promise<Rly0RelayAgentsResult>;
  listRly0Relays?(): Promise<Rly0RelayListResult>;
  addRly0Relay?(input: Rly0RelayAddParams): Promise<Rly0RelayAddResult>;
  updateRly0Relay?(input: Rly0RelayUpdateParams): Promise<Rly0RelayMutationResult>;
  testRly0Relay?(input: Rly0RelayTestParams): Promise<Rly0RelayTestResult>;
  rly0MaintenanceRestartCodex?(): Promise<Rly0MaintenanceProcessActionResult>;
}

export const RLY0_RELAY_DEFAULT_NAME = "零号中转";
export const RLY0_RELAY_DEFAULT_BASE_URL = "https://api.rly0.com";
export const RLY0_RELAY_SIGNUP_URL = "https://rly0.com";
/** Set before a restart; the next launch opens a new chat with this agent, then clears it. */
export const RLY0_PENDING_NEW_CHAT_STORAGE_KEY = "codexhost.rly0-pending-new-chat.v1";

const NEW_CHAT_LABEL = /^(新聊天|新对话|New chat|New thread)$/iu;
const LOGIN_POLL_MS = 3_000;
const LOGIN_POLL_LIMIT_MS = 10 * 60_000;

function storage(document: Document): Storage | null {
  try {
    return document.defaultView?.localStorage ?? null;
  } catch {
    return null;
  }
}

export function setPendingNewChat(document: Document, agent: RendererAgent): void {
  try {
    storage(document)?.setItem(
      RLY0_PENDING_NEW_CHAT_STORAGE_KEY,
      JSON.stringify({ agent, at: Date.now() }),
    );
  } catch {
    // Without storage the person opens the chat by hand after the restart.
  }
}

/** Returns the agent to open a chat with after a restart (only within 10 minutes), once. */
export function consumePendingNewChat(document: Document, now = Date.now()): RendererAgent | null {
  const store = storage(document);
  if (!store) return null;
  try {
    const raw = store.getItem(RLY0_PENDING_NEW_CHAT_STORAGE_KEY);
    if (!raw) return null;
    store.removeItem(RLY0_PENDING_NEW_CHAT_STORAGE_KEY);
    const value = JSON.parse(raw) as { agent?: unknown; at?: unknown };
    if (typeof value.agent !== "string" || typeof value.at !== "number") return null;
    if (now - value.at > 10 * 60_000) return null;
    return value.agent as RendererAgent;
  } catch {
    return null;
  }
}

/** Codex's own "New chat" button, preferring the compact icon button. */
function findNewChatButton(document: Document): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("button,a,[role=button]"));
  return (
    candidates.find((element) => NEW_CHAT_LABEL.test(element.getAttribute("aria-label") ?? "")) ??
    candidates.find((element) => NEW_CHAT_LABEL.test((element.textContent ?? "").trim())) ??
    null
  );
}

/**
 * Makes `agent` the agent of the next new chat, closes the settings window and clicks Codex's
 * "New chat". Returns false when Codex's button could not be found (the agent is still preselected
 * for the next chat the person opens).
 */
export function openNewChatWith(
  document: Document,
  agent: RendererAgent,
  closeLabel?: string,
  /** Where the settings window lives (it may be inside a shadow root). */
  settingsScope?: ParentNode,
): boolean {
  writeNewThreadAgentPreference(agent);
  if (closeLabel) {
    const scopes: ParentNode[] = settingsScope ? [settingsScope, document] : [document];
    for (const scope of scopes) {
      const close = Array.from(scope.querySelectorAll<HTMLElement>("button")).find(
        (button) => button.getAttribute("aria-label") === closeLabel,
      );
      if (close) {
        close.click();
        break;
      }
    }
  }
  const button = findNewChatButton(document);
  if (!button) return false;
  button.click();
  return true;
}

export interface ClaudeQuickStartOptions {
  readonly zh: boolean;
  /** Label of the settings window's close button, so it can be closed before opening a chat. */
  readonly closeLabel?: string;
}

type View =
  | { kind: "checking" }
  | { kind: "hidden" }
  | { kind: "notFound" }
  | { kind: "ready"; via: string }
  | { kind: "restart"; relayName: string }
  | { kind: "setup"; relay: Rly0Relay | null; error?: string }
  | { kind: "waitingLogin"; url?: string }
  | { kind: "working"; text: string };

export function createClaudeQuickStart(
  document: Document,
  getClient: () => ClaudeQuickStartClient | null,
  options: ClaudeQuickStartOptions,
): HTMLElement {
  const zh = options.zh;
  const t = (en: string, cn: string): string => (zh ? cn : en);
  const root = document.createElement("section");
  root.className = "settings-rly0-quick-start";
  root.setAttribute("aria-label", t("Start using Claude Code", "开始使用 Claude Code"));
  let view: View = { kind: "checking" };
  let disposed = false;

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
    const node = el(
      "button",
      primary
        ? "settings-command-button"
        : "settings-command-button settings-command-button--secondary",
      text,
    );
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  };

  const render = (): void => {
    if (disposed) return;
    root.replaceChildren();
    root.hidden = view.kind === "hidden";
    if (view.kind === "hidden") return;
    root.append(
      el(
        "strong",
        "settings-rly0-quick-start__title",
        t("Start using Claude Code", "开始使用 Claude Code"),
      ),
    );
    switch (view.kind) {
      case "checking":
        root.append(el("p", undefined, t("Checking Claude Code…", "正在检查 Claude Code…")));
        return;
      case "notFound": {
        root.append(
          el(
            "p",
            undefined,
            t(
              "Claude Code is installed, but Codex needs a restart to finish setting it up.",
              "Claude Code 已经装好，需要重启一次 Codex 才能完成配置。",
            ),
          ),
          button(t("Restart Codex", "重启 Codex"), true, () => void restartOnly()),
        );
        return;
      }
      case "working":
        root.append(el("p", "settings-rly0-quick-start__status", view.text));
        return;
      case "ready": {
        root.append(el("p", "settings-rly0-quick-start__ok", view.via));
        const start = button(
          t("Open a Claude Code chat", "开始一个 Claude Code 对话"),
          true,
          () => {
            if (
              !openNewChatWith(
                document,
                "claude-code",
                options.closeLabel,
                root.getRootNode() as unknown as ParentNode,
              )
            ) {
              view = {
                kind: "ready",
                via: t(
                  "Claude Code is now preselected. Click New chat in Codex to start.",
                  "已默认选好 Claude Code，在 Codex 里点“新聊天”即可开始。",
                ),
              };
              render();
            }
          },
        );
        root.append(start);
        return;
      }
      case "restart": {
        root.append(
          el(
            "p",
            undefined,
            t(
              `Claude Code will run through ${view.relayName} after Codex restarts.`,
              `重启 Codex 后，Claude Code 会走“${view.relayName}”。`,
            ),
          ),
          button(
            t("Restart Codex and open a Claude Code chat", "重启 Codex 并打开 Claude Code 对话"),
            true,
            () => void restartAndOpen(),
          ),
        );
        return;
      }
      case "waitingLogin": {
        root.append(
          el(
            "p",
            "settings-rly0-quick-start__status",
            t(
              "Finish signing in in the browser; this updates by itself.",
              "请在浏览器里完成登录，完成后这里会自动更新。",
            ),
          ),
        );
        if (view.url) {
          const link = el(
            "a",
            "settings-command-button settings-command-button--secondary",
            t("Open sign-in page ↗", "打开登录页 ↗"),
          );
          link.href = view.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          root.append(link);
        }
        return;
      }
      case "setup": {
        root.append(
          el(
            "p",
            undefined,
            t("Choose how to pay for Claude Code:", "选一种方式使用 Claude Code："),
          ),
        );
        const choices = el("div", "settings-rly0-quick-start__choices");
        const own = el("div", "settings-rly0-quick-start__choice");
        own.append(
          el("b", undefined, t("I have a Claude subscription", "我有 Claude 订阅")),
          el("span", undefined, t("Sign in once in the browser.", "在浏览器里登录一次即可。")),
          button(t("Sign in with Claude", "用 Claude 账号登录"), false, () => void signIn()),
        );
        const relay = el("div", "settings-rly0-quick-start__choice");
        relay.append(
          el("b", undefined, t("Use the RLY/0 relay (pay as you go)", "用零号中转（按量付费）")),
          el(
            "span",
            undefined,
            t(
              "No subscription needed. RLY/0 Hub sets everything up and restarts Codex.",
              "不需要订阅。RLY/0 Hub 会自动配置好并重启 Codex。",
            ),
          ),
        );
        if (view.relay) {
          const existing = view.relay;
          relay.append(
            button(
              t(`Use ${existing.name}`, `使用“${existing.name}”`),
              true,
              () => void useRelay(existing),
            ),
          );
        } else {
          const key = el("input", "settings-rly0-quick-start__key");
          key.type = "password";
          key.autocomplete = "off";
          key.spellcheck = false;
          key.placeholder = t("Paste your RLY/0 API key", "粘贴零号中转的 API Key");
          key.setAttribute("aria-label", key.placeholder);
          const row = el("div", "settings-rly0-quick-start__key-row");
          row.append(
            key,
            button(t("Save and set up", "保存并自动配置"), true, () => {
              const value = key.value.trim();
              key.value = "";
              void addRelayAndUse(value);
            }),
          );
          const signup = el(
            "a",
            "settings-rly0-quick-start__signup",
            t("No key yet? Get one at rly0.com ↗", "还没有？去 rly0.com 获取 ↗"),
          );
          signup.href = RLY0_RELAY_SIGNUP_URL;
          signup.target = "_blank";
          signup.rel = "noopener noreferrer";
          relay.append(row, signup);
        }
        choices.append(own, relay);
        root.append(choices);
        if (view.error) {
          const failure = el("p", "settings-rly0-quick-start__error", view.error);
          failure.setAttribute("role", "alert");
          root.append(failure);
        }
        return;
      }
    }
  };

  const usableRelay = (relays: readonly Rly0Relay[]): Rly0Relay | null =>
    relays.find((relay) => relay.enabled && relay.hasKey && /rly0\.com/iu.test(relay.baseUrl)) ??
    relays.find((relay) => relay.enabled && relay.hasKey) ??
    null;

  const check = async (): Promise<void> => {
    const client = getClient();
    if (!client?.rly0ClaudeCodeAuthStatus) {
      view = { kind: "hidden" };
      render();
      return;
    }
    try {
      const [auth, agents, listed] = await Promise.all([
        client.rly0ClaudeCodeAuthStatus(),
        client.rly0RelayAgentsGet?.() ?? Promise.resolve(null),
        client.listRly0Relays?.() ?? Promise.resolve(null),
      ]);
      const relays = listed?.available ? listed.relays : [];
      const nameOf = (id: string): string => relays.find((relay) => relay.id === id)?.name ?? id;
      // Codex already lists Claude Code here, so a missing command means this Codex session started
      // before the install: a restart picks it up.
      if (!auth.installed) view = { kind: "notFound" };
      else if (agents?.claudeCode && agents.restartRequired)
        view = { kind: "restart", relayName: nameOf(agents.claudeCode) };
      else if (agents?.active?.claudeCode)
        view = {
          kind: "ready",
          via: t(
            `Ready, running through ${nameOf(agents.active.claudeCode)}.`,
            `已可以使用，走“${nameOf(agents.active.claudeCode)}”。`,
          ),
        };
      else if (auth.loggedIn)
        view = {
          kind: "ready",
          via: auth.email
            ? t(`Ready, signed in as ${auth.email}.`, `已可以使用，登录账号：${auth.email}。`)
            : t("Ready to use.", "已可以使用。"),
        };
      else view = { kind: "setup", relay: usableRelay(relays) };
    } catch {
      view = {
        kind: "setup",
        relay: null,
        error: t("Could not check Claude Code. Try again.", "检查 Claude Code 失败，请重试。"),
      };
    }
    render();
  };

  const signIn = async (): Promise<void> => {
    const client = getClient();
    if (!client?.rly0ClaudeCodeLogin) return;
    try {
      const result = await client.rly0ClaudeCodeLogin({ mode: "claudeai" });
      if (!result.started) throw new Error("not started");
      view = { kind: "waitingLogin", ...(result.url ? { url: result.url } : {}) };
      render();
      const startedAt = Date.now();
      const poll = (): void => {
        setTimeout(() => {
          void (async () => {
            // Stop once the panel is gone (page closed or re-rendered).
            if (!root.isConnected) disposed = true;
            if (disposed) return;
            const auth = await getClient()
              ?.rly0ClaudeCodeAuthStatus?.()
              .catch(() => null);
            if (disposed) return;
            if (auth?.loggedIn) {
              await check();
              return;
            }
            if (Date.now() - startedAt < LOGIN_POLL_LIMIT_MS) poll();
            else {
              view = {
                kind: "setup",
                relay: null,
                error: t("Sign-in did not finish. Try again.", "登录没有完成，请重试。"),
              };
              render();
            }
          })();
        }, LOGIN_POLL_MS);
      };
      poll();
    } catch {
      view = {
        kind: "setup",
        relay: null,
        error: t("Could not start the sign-in.", "无法开始登录。"),
      };
      render();
    }
  };

  const restartOnly = async (): Promise<void> => {
    const restart = getClient()?.rly0MaintenanceRestartCodex;
    view = { kind: "working", text: t("Restarting Codex…", "正在重启 Codex…") };
    render();
    try {
      const result = await restart?.();
      if (!result?.supported || !result.ok) throw new Error("restart");
    } catch {
      view = {
        kind: "working",
        text: t("Close and reopen Codex to finish.", "请关闭并重新打开 Codex 完成配置。"),
      };
      render();
    }
  };

  const restartAndOpen = async (): Promise<void> => {
    const restart = getClient()?.rly0MaintenanceRestartCodex;
    setPendingNewChat(document, "claude-code");
    if (!restart) {
      view = {
        kind: "working",
        text: t("Restart Codex to finish.", "请手动重启 Codex 完成配置。"),
      };
      render();
      return;
    }
    view = {
      kind: "working",
      text: t(
        "Restarting Codex… it opens a Claude Code chat when it is back.",
        "正在重启 Codex，重新打开后会自动进入 Claude Code 对话…",
      ),
    };
    render();
    try {
      const result = await restart();
      if (!result.supported || !result.ok) throw new Error("restart");
    } catch {
      view = {
        kind: "working",
        text: t(
          "Could not restart automatically. Close and reopen Codex to finish.",
          "没能自动重启，请关闭并重新打开 Codex 完成配置。",
        ),
      };
      render();
    }
  };

  const useRelay = async (relay: Rly0Relay): Promise<void> => {
    const client = getClient();
    if (!client?.rly0RelayAgentsSet) return;
    view = {
      kind: "working",
      text: t("Setting Claude Code to use the relay…", "正在让 Claude Code 走中转…"),
    };
    render();
    try {
      const result = await client.rly0RelayAgentsSet({ claudeCode: relay.id });
      if (result.restartRequired) await restartAndOpen();
      else await check();
    } catch {
      view = { kind: "setup", relay, error: t("Could not save the choice.", "保存失败，请重试。") };
      render();
    }
  };

  const addRelayAndUse = async (apiKey: string): Promise<void> => {
    const client = getClient();
    if (!apiKey) {
      view = {
        kind: "setup",
        relay: null,
        error: t("Paste your API key first.", "请先粘贴 API Key。"),
      };
      render();
      return;
    }
    if (!client?.addRly0Relay || !client.testRly0Relay) return;
    view = {
      kind: "working",
      text: t("Adding the RLY/0 relay and testing it…", "正在添加零号中转并测试连接…"),
    };
    render();
    try {
      const added = await client.addRly0Relay({
        name: RLY0_RELAY_DEFAULT_NAME,
        baseUrl: RLY0_RELAY_DEFAULT_BASE_URL,
        apiKey,
      });
      if (!added.available) throw new Error("unavailable");
      const tested = await client.testRly0Relay({ id: added.id });
      if (!tested.available || !tested.ok) {
        view = {
          kind: "setup",
          relay: null,
          error: t(
            "The key did not work. Check it and try again.",
            "这个密钥用不了，请检查后重试（可能复制不完整或余额不足）。",
          ),
        };
        render();
        return;
      }
      if (tested.models?.length && client.updateRly0Relay) {
        await client
          .updateRly0Relay({ id: added.id, models: tested.models })
          .catch(() => undefined);
      }
      await useRelay(added.relay);
    } catch {
      view = {
        kind: "setup",
        relay: null,
        error: t("Could not add the relay. Try again.", "添加中转失败，请重试。"),
      };
      render();
    }
  };

  render();
  void check();
  return root;
}
