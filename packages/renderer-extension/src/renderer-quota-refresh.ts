import type { ThreadQuotaState, ThreadQuotaUnavailableReason } from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

/** Explicit quota refreshes of one Composer are at least this far apart. */
export const RENDERER_QUOTA_REFRESH_COOLDOWN_MS = 10_000;

/** What the Usage Popover knows about the current Thread's Account quota and its refresh. */
export interface RendererQuotaView {
  /** Host's latest answer; `null` before the first one. */
  readonly state: ThreadQuotaState | null;
  readonly refreshing: boolean;
  /** The last explicit refresh failed; the numbers shown are the previous ones. */
  readonly failed: boolean;
  /** Epoch ms until which the refresh control stays disabled. */
  readonly cooldownUntil: number;
  readonly onRefresh: (() => void) | null;
}

interface RendererQuotaMessages {
  readonly quota: string;
  readonly refresh: string;
  readonly refreshing: string;
  readonly refreshFailed: string;
  readonly updatedAt: (time: string) => string;
  readonly notReadYet: string;
  readonly reasons: Readonly<Record<ThreadQuotaUnavailableReason, string>>;
  readonly failures: Readonly<Record<NonNullable<ThreadQuotaState["failure"]>, string>>;
}

const ENGLISH: RendererQuotaMessages = Object.freeze({
  quota: "Quota",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  refreshFailed: "Refresh failed",
  updatedAt: (time: string) => `Updated ${time}`,
  notReadYet: "Not read yet",
  reasons: Object.freeze({
    proxiedCredential:
      "Runs on an Anthropic key or subscription token saved in RLY/0 Hub, so Claude Code cannot see its 5-hour and 7-day limits.",
    relay: "Relay mode: the relay has a balance, not plan limits.",
    notSubscriber:
      "This login cannot be queried (API key or subscription token). A subscription token updates after the next message.",
    unsupported: "This agent cannot refresh its quota on demand.",
  }),
  failures: Object.freeze({
    rateLimited: "Anthropic is limiting quota checks for now. Refresh again later.",
  }),
});

const CHINESE: RendererQuotaMessages = Object.freeze({
  quota: "额度",
  refresh: "刷新",
  refreshing: "刷新中…",
  refreshFailed: "刷新失败",
  updatedAt: (time: string) => `更新于 ${time}`,
  notReadYet: "尚未读取",
  reasons: Object.freeze({
    proxiedCredential:
      "通过 RLY/0 Hub 保存的 Anthropic Key 或订阅令牌运行，Claude Code 读不到 5 小时 / 7 天额度。",
    relay: "中转模式：额度见中转余额。",
    notSubscriber: "此登录无法主动查询额度（API Key 或订阅令牌）；订阅令牌发送消息后自动更新。",
    unsupported: "此 Agent 不支持主动查询额度。",
  }),
  failures: Object.freeze({
    rateLimited: "官方暂时限制查询，稍后点刷新。",
  }),
});

export function rendererQuotaMessages(locale: RendererSettingsLocale): RendererQuotaMessages {
  return locale === "zh-CN" ? CHINESE : ENGLISH;
}

export function formatRendererQuotaTime(iso: string, locale?: RendererSettingsLocale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export interface RendererQuotaSummary {
  /** Status text next to the refresh control. */
  readonly status: string;
  /** Explanation of why the quota cannot be read, when it cannot. */
  readonly reason: string | null;
  /** Why the last read failed, when the provider said (the control stays usable). */
  readonly failureNote: string | null;
  readonly canRefresh: boolean;
}

/** The text and enablement of the quota row, kept DOM-free for tests. */
export function summarizeRendererQuota(
  view: RendererQuotaView,
  locale: RendererSettingsLocale,
  now: number = Date.now(),
): RendererQuotaSummary {
  const messages = rendererQuotaMessages(locale);
  const reason =
    view.state?.status === "unavailable" && view.state.reason
      ? messages.reasons[view.state.reason]
      : null;
  const observedAt = view.state?.observedAt
    ? formatRendererQuotaTime(view.state.observedAt, locale)
    : "";
  const updated = observedAt ? messages.updatedAt(observedAt) : messages.notReadYet;
  const status = view.refreshing
    ? messages.refreshing
    : view.failed || view.state?.status === "failed"
      ? `${messages.refreshFailed} · ${updated}`
      : updated;
  const failure = view.state?.status === "failed" ? view.state.failure : undefined;
  return {
    status,
    reason,
    failureNote: failure && !view.refreshing ? messages.failures[failure] : null,
    canRefresh:
      view.onRefresh !== null && reason === null && !view.refreshing && now >= view.cooldownUntil,
  };
}

/** Appends the quota status line, its refresh control, and the reason it cannot refresh. */
export function appendRendererQuotaSection(
  parent: HTMLElement,
  view: RendererQuotaView,
  locale: RendererSettingsLocale,
): void {
  const messages = rendererQuotaMessages(locale);
  const summary = summarizeRendererQuota(view, locale);
  const row = document.createElement("div");
  row.dataset.codexhostQuotaRefresh = "";
  row.style.display = "grid";
  row.style.gridTemplateColumns = "minmax(0, 1fr) auto";
  row.style.alignItems = "center";
  row.style.gap = "12px";
  row.style.padding = "6px 0 2px";
  row.style.marginTop = "4px";
  row.style.borderTop = "1px solid color-mix(in srgb, currentColor 12%, transparent)";

  const status = document.createElement("span");
  status.textContent = `${messages.quota} · ${summary.status}`;
  status.style.color = "color-mix(in srgb, currentColor 68%, transparent)";
  status.style.fontSize = "12px";
  if (view.failed || view.state?.status === "failed") status.style.color = "#d97706";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = view.refreshing ? messages.refreshing : messages.refresh;
  button.disabled = !summary.canRefresh;
  button.setAttribute("aria-busy", String(view.refreshing));
  if (summary.reason) button.title = summary.reason;
  button.style.font = "inherit";
  button.style.fontSize = "12px";
  button.style.padding = "2px 10px";
  button.style.borderRadius = "999px";
  button.style.border = "1px solid color-mix(in srgb, currentColor 22%, transparent)";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.cursor = summary.canRefresh ? "pointer" : "default";
  button.style.opacity = summary.canRefresh ? "1" : "0.5";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!button.disabled) view.onRefresh?.();
  });
  row.append(status, button);
  parent.append(row);

  const noteText = summary.reason ?? summary.failureNote;
  if (noteText) {
    const note = document.createElement("div");
    note.textContent = noteText;
    note.style.fontSize = "12px";
    note.style.lineHeight = "1.4";
    note.style.paddingTop = "2px";
    note.style.color = "color-mix(in srgb, currentColor 60%, transparent)";
    parent.append(note);
  }
}
