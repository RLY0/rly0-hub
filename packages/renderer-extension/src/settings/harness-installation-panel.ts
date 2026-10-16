import type { Rly0AgentInstallStatus } from "@codexhost/shared-contracts";

import type { ExternalRendererAgent } from "../agent-selection-state.js";
import { harnessInstallationGuide } from "./harness-installation-guides.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

/** One-click installation through RLY/0 Hub (local host only). */
export interface HarnessInstaller {
  start(agent: ExternalRendererAgent): Promise<Rly0AgentInstallStatus>;
  status(agent: ExternalRendererAgent): Promise<Rly0AgentInstallStatus>;
  openLogin?(agent: ExternalRendererAgent): Promise<boolean>;
}

export interface HarnessInstallationPanelOptions {
  readonly installer?: HarnessInstaller;
  /** Start installing as soon as the panel opens (the row's "Install" button). */
  readonly autoStart?: boolean;
  /** Switches the settings page, e.g. to sign Claude Code in. */
  readonly navigate?: (pageId: string) => void;
  /** "Start using" block shown right after a successful install (Claude Code). */
  readonly quickStart?: () => HTMLElement;
}

const POLL_MS = 1_500;
/** Last known status per agent, so a re-rendered panel keeps showing a running install. */
const lastStatus = new Map<ExternalRendererAgent, Rly0AgentInstallStatus>();
const polling = new Set<ExternalRendererAgent>();
/** Panels currently showing each agent; the page may re-render them while an install runs. */
const views = new Map<
  ExternalRendererAgent,
  Set<{ element: HTMLElement; render: (status: Rly0AgentInstallStatus) => void }>
>();

function publish(agent: ExternalRendererAgent, status: Rly0AgentInstallStatus): void {
  lastStatus.set(agent, status);
  const current = views.get(agent);
  if (!current) return;
  for (const view of [...current]) {
    if (view.element.isConnected) view.render(status);
    else current.delete(view);
  }
}

function text(zh: boolean, en: string, cn: string): string {
  return zh ? cn : en;
}

function stepLabel(zh: boolean, step: Rly0AgentInstallStatus["step"]): string {
  switch (step) {
    case "installingNode":
      return text(
        zh,
        "Installing Node.js (Windows may ask for permission)",
        "正在安装 Node.js（Windows 可能会请求权限，请点“是”）",
      );
    case "installingGit":
      return text(
        zh,
        "Installing Git (Windows may ask for permission)",
        "正在安装 Git（Windows 可能会请求权限，请点“是”）",
      );
    case "npm":
      return text(zh, "Installing with npm", "正在通过 npm 安装");
    case "npmMirror":
      return text(zh, "Retrying through the npm mirror in China", "正在改用国内 npm 镜像重试");
    default:
      return text(zh, "Running the official installer", "正在运行官方安装程序");
  }
}

function failureLabel(zh: boolean, error: Rly0AgentInstallStatus["error"]): string {
  switch (error) {
    case "NETWORK":
      return text(
        zh,
        "Could not reach the download server. It may need a proxy: set one under General → Network proxy for RLY/0 Core, then try again.",
        "连不上下载服务器，可能需要代理。请在“通用”页的“RLY/0 Core 网络代理”里设置后重试。",
      );
    case "PERMISSION":
      return text(
        zh,
        "Windows refused the change (permission). Try again and allow the prompt.",
        "Windows 拒绝了这次修改（权限不足）。请重试，并在弹窗中点“是”。",
      );
    case "NODE_MISSING":
      return text(
        zh,
        "This agent needs Node.js, which could not be installed automatically.",
        "这个 Agent 需要 Node.js，但没能自动安装。请先安装 Node.js 后重试。",
      );
    case "GIT_MISSING":
      return text(
        zh,
        "This agent needs Git, which could not be installed automatically.",
        "这个 Agent 需要 Git，但没能自动安装。请先安装 Git for Windows 后重试。",
      );
    case "MANUAL":
      return text(
        zh,
        "This one is a desktop app: download and install it from the official page.",
        "这是桌面应用，需要从官方页面下载安装。",
      );
    default:
      return text(
        zh,
        "Installation did not finish. See the log below, or install by hand.",
        "安装没有完成。可以查看下方日志，或改用手动安装。",
      );
  }
}

function elapsed(status: Rly0AgentInstallStatus, now: number): string {
  const seconds = Math.max(
    0,
    Math.round(((status.finishedAt ?? now) - (status.startedAt ?? now)) / 1000),
  );
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function createHarnessInstallationPanel(
  document: Document,
  agent: ExternalRendererAgent,
  hostId: string,
  messages: RendererSettingsMessages,
  copy: (button: HTMLButtonElement, command: string, label: string) => void,
  refresh: () => void,
  options: HarnessInstallationPanelOptions = {},
): HTMLElement {
  const zh = messages.locale === "zh-CN";
  const guide = harnessInstallationGuide(agent, messages.locale);
  const panel = document.createElement("div");
  panel.className = "settings-harness-installation";
  const paragraph = (value: string, parent: HTMLElement = panel): HTMLElement => {
    const p = document.createElement("p");
    p.textContent = value;
    parent.append(p);
    return p;
  };
  const link = (url: string, label: string, parent: HTMLElement = panel, primary = false): void => {
    const anchor = document.createElement("a");
    anchor.className = primary
      ? "settings-command-button"
      : "settings-command-button settings-command-button--secondary";
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.append(label, createRendererSettingsIcon("external-link", 14));
    parent.append(anchor);
  };
  const installer = hostId === "local" ? options.installer : undefined;

  // ---- One-click install ----------------------------------------------------
  const auto = document.createElement("div");
  auto.className = "settings-harness-installation-auto";
  auto.dataset.agentInstall = agent;
  if (installer) panel.append(auto);

  const renderAuto = (status: Rly0AgentInstallStatus | undefined): void => {
    auto.replaceChildren();
    const state = status?.state ?? "idle";
    if (status && !status.automatic) {
      paragraph(failureLabel(zh, "MANUAL"), auto);
      for (const download of guide.downloads ?? []) {
        link(download.url, `${download.label} · ${text(zh, "Download", "下载")}`, auto, true);
      }
      return;
    }
    if (state === "running" && status) {
      const progress = document.createElement("p");
      progress.className = "settings-harness-installation-auto__progress";
      progress.setAttribute("role", "status");
      progress.textContent = `${stepLabel(zh, status.step)}… ${elapsed(status, Date.now())}`;
      auto.append(progress);
      paragraph(
        text(
          zh,
          "This can take a few minutes. You can keep using Codex.",
          "可能需要几分钟，期间可以继续使用 Codex。",
        ),
        auto,
      );
      return;
    }
    if (state === "succeeded") {
      const done = paragraph(
        text(zh, "Installed. Checking it now…", "安装完成，正在重新检测…"),
        auto,
      );
      done.className = "settings-harness-installation-auto__done";
      const next = document.createElement("div");
      next.className = "settings-harness-installation-auto__actions";
      if (options.quickStart) {
        auto.append(options.quickStart());
      } else if (agent === "claude-code" && options.navigate) {
        const navigate = options.navigate;
        const signIn = document.createElement("button");
        signIn.type = "button";
        signIn.className = "settings-command-button";
        signIn.textContent = text(zh, "Next: sign in to Claude Code", "下一步：登录 Claude Code");
        signIn.addEventListener("click", () => navigate("relay"));
        next.append(signIn);
      } else if (status?.canOpenLogin && installer?.openLogin) {
        const openLogin = installer?.openLogin;
        const terminal = document.createElement("button");
        terminal.type = "button";
        terminal.className = "settings-command-button";
        terminal.textContent = text(
          zh,
          "Next: open a terminal to sign in",
          "下一步：打开终端完成登录",
        );
        terminal.addEventListener("click", () => void openLogin(agent));
        next.append(terminal);
      }
      auto.append(next);
      paragraph(
        text(
          zh,
          "If it still shows Not installed, restart Codex (Maintenance → Restart Codex).",
          "如果仍显示“未安装”，请重启 Codex（维护工具 → 重启 Codex）。",
        ),
        auto,
      );
      return;
    }
    if (state === "failed" && status) {
      const failure = paragraph(failureLabel(zh, status.error), auto);
      failure.className = "settings-harness-installation-auto__failed";
      failure.setAttribute("role", "alert");
      if (status.manualUrl)
        link(status.manualUrl, text(zh, "Open download page", "打开下载页"), auto, true);
    }
    const start = document.createElement("button");
    start.type = "button";
    start.className = "settings-command-button";
    start.dataset.connectionAction = "auto-install";
    start.append(
      createRendererSettingsIcon("download", 16),
      state === "failed"
        ? text(zh, "Try again", "重试")
        : text(zh, "Install automatically", "一键安装"),
    );
    start.addEventListener("click", () => void begin());
    auto.append(start);
    paragraph(
      text(
        zh,
        "Downloads and runs the official installer, and installs Node.js or Git first when needed.",
        "将从官方地址下载并运行安装程序；需要时会先自动装好 Node.js 或 Git。",
      ),
      auto,
    );
    if (status?.log) {
      const details = document.createElement("details");
      details.className = "settings-harness-installation-auto__log";
      const summary = document.createElement("summary");
      summary.textContent = text(zh, "Installation log", "安装日志");
      const pre = document.createElement("pre");
      pre.textContent = status.log;
      details.append(summary, pre);
      auto.append(details);
    }
  };

  const poll = (): void => {
    if (!installer || polling.has(agent)) return;
    polling.add(agent);
    const tick = (): void => {
      void installer
        .status(agent)
        .then((status) => {
          publish(agent, status);
          if (status.state === "running") {
            setTimeout(tick, POLL_MS);
            return;
          }
          polling.delete(agent);
          if (status.state === "succeeded") refresh();
        })
        .catch(() => {
          polling.delete(agent);
        });
    };
    setTimeout(tick, POLL_MS);
  };

  const begin = async (): Promise<void> => {
    if (!installer) return;
    try {
      const status = await installer.start(agent);
      publish(agent, status);
      renderAuto(status);
      if (status.state === "running") poll();
    } catch {
      renderAuto({ state: "failed", automatic: true, error: "FAILED" });
    }
  };

  if (installer) {
    const registered = views.get(agent) ?? new Set();
    registered.add({ element: auto, render: renderAuto });
    views.set(agent, registered);
    const known = lastStatus.get(agent);
    renderAuto(known);
    if (options.autoStart && known?.state !== "running") void begin();
    else if (known?.state === "running") poll();
    else
      void installer
        .status(agent)
        .then((status) => {
          lastStatus.set(agent, status);
          if (auto.isConnected || !options.autoStart) renderAuto(status);
          if (status.state === "running") poll();
        })
        .catch(() => undefined);
  }

  // ---- Manual installation (fallback, or the only way on remote hosts) ------
  const manual = installer ? document.createElement("details") : panel;
  if (installer) {
    manual.className = "settings-harness-installation-manual";
    const summary = document.createElement("summary");
    summary.textContent = text(zh, "Install by hand instead", "手动安装（备用）");
    manual.append(summary);
    panel.append(manual);
  }
  if (hostId !== "local") {
    paragraph(zh ? "请在远程 Host 上安装。" : "Install on the remote Host.", manual);
  }
  if (guide.before) paragraph(guide.before, manual);
  for (const { terminal, command } of guide.commands) {
    const block = document.createElement("div");
    block.className = "settings-harness-installation-command";
    const label = document.createElement("strong");
    label.textContent = terminal;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = command;
    pre.append(code);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-command-button settings-command-button--secondary";
    button.dataset.connectionAction = "copy-install";
    const copyLabel = zh ? "复制命令" : "Copy command";
    button.setAttribute("aria-label", `${copyLabel}: ${terminal}`);
    button.append(createRendererSettingsIcon("copy", 16), copyLabel);
    button.addEventListener("click", () => copy(button, command, copyLabel));
    block.append(label, pre, button);
    manual.append(block);
  }
  for (const download of guide.downloads ?? []) {
    link(
      download.url,
      `${download.label} · ${zh ? "下载与安装指南" : "Download and installation guide"}`,
      manual,
    );
  }
  paragraph(guide.after, manual);

  const check = document.createElement("button");
  check.type = "button";
  check.className = "settings-command-button settings-command-button--secondary";
  check.dataset.connectionAction = "check-install";
  check.textContent = zh ? "重新检测" : "Check again";
  check.addEventListener("click", () => {
    check.disabled = true;
    check.textContent = messages.connectionRefreshing;
    refresh();
  });
  manual.append(check);
  link(guide.url, zh ? "查看官方安装说明" : "View official installation instructions", manual);
  return panel;
}

/** For tests: forget remembered install states. */
export function resetHarnessInstallationStateForTests(): void {
  lastStatus.clear();
  polling.clear();
  views.clear();
}
