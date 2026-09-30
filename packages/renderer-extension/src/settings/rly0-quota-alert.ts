import type {
  Rly0Account,
  Rly0AccountsListResult,
  Rly0AccountsSwitchParams,
  Rly0AccountsSwitchResult,
  Rly0AccountsUsageAllResult,
  Rly0AccountUsage,
  Rly0AccountUsageEntry,
} from "@codexhost/shared-contracts";

import {
  RENDERER_QUOTA_ALERT_CHANGE_EVENT,
  RENDERER_QUOTA_REFRESH_CHANGE_EVENT,
  RENDERER_QUOTA_REFRESH_INTERVALS_MS,
  readRendererQuotaAlertEnabled,
  readRendererQuotaAlertThresholdPercent,
  readRendererQuotaRefreshFrequency,
} from "../renderer-appearance-preferences.js";
import { formatRendererCreditsPercent } from "../renderer-usage-control.js";
import type { RendererSettingsMessages } from "./localization.js";
import type { Rly0AccountMessages } from "./rly0-account-messages.js";
import { rly0AccountDisplayName } from "./rly0-accounts.js";
import { rly0UsageLowestWindow, type Rly0UsagePeriod } from "./rly0-usage.js";

export interface RendererRly0QuotaAlertClient {
  listRly0Accounts?(): Promise<Rly0AccountsListResult>;
  rly0AccountUsageAll?(): Promise<Rly0AccountsUsageAllResult>;
  switchRly0Account?(input: Rly0AccountsSwitchParams): Promise<Rly0AccountsSwitchResult>;
}

export interface Rly0QuotaAlertEvaluation {
  readonly current: Rly0Account;
  readonly period: Rly0UsagePeriod | null;
  readonly remainingPercent: number;
  readonly thresholdPercent: number;
  /** The other saved account whose tightest window has the most left, if it beats the current. */
  readonly best: { readonly account: Rly0Account; readonly remainingPercent: number } | null;
}

/**
 * Pure decision for the low-quota banner: alert when any window of the current saved account has
 * less than `thresholdPercent` left, and suggest the saved account whose tightest window has the
 * most left. Accounts without usage data are never suggested. Never switches anything itself.
 */
export function evaluateRly0QuotaAlert(
  accounts: readonly Rly0Account[],
  usageById: ReadonlyMap<string, Rly0AccountUsage>,
  thresholdPercent: number,
): Rly0QuotaAlertEvaluation | null {
  const current = accounts.find((account) => account.current);
  if (!current) return null;
  const currentUsage = usageById.get(current.id) ?? current.lastUsage;
  const lowest = currentUsage ? rly0UsageLowestWindow(currentUsage) : null;
  if (!lowest || lowest.remainingPercent >= thresholdPercent) return null;
  let best: Rly0QuotaAlertEvaluation["best"] = null;
  for (const account of accounts) {
    if (account.id === current.id) continue;
    const usage = usageById.get(account.id) ?? account.lastUsage;
    const candidate = usage ? rly0UsageLowestWindow(usage) : null;
    if (!candidate || candidate.remainingPercent <= lowest.remainingPercent) continue;
    if (!best || candidate.remainingPercent > best.remainingPercent) {
      best = { account, remainingPercent: candidate.remainingPercent };
    }
  }
  return {
    current,
    period: lowest.period,
    remainingPercent: lowest.remainingPercent,
    thresholdPercent,
    best,
  };
}

function windowLabel(period: Rly0UsagePeriod | null, messages: Rly0AccountMessages): string {
  if (period === "five_hour") return messages.alertWindowFiveHour;
  if (period === "seven_day") return messages.alertWindowWeekly;
  return messages.alertWindowOther;
}

export function rly0QuotaAlertText(
  evaluation: Rly0QuotaAlertEvaluation,
  messages: Rly0AccountMessages,
): { body: string; suggestion: string } {
  const body = messages.alertBody
    .replace("{name}", rly0AccountDisplayName(evaluation.current))
    .replace("{window}", windowLabel(evaluation.period, messages))
    .replace("{percent}", formatRendererCreditsPercent(evaluation.remainingPercent))
    .replace("{threshold}", String(evaluation.thresholdPercent));
  const suggestion = evaluation.best
    ? messages.alertBest
        .replace("{name}", rly0AccountDisplayName(evaluation.best.account))
        .replace("{percent}", formatRendererCreditsPercent(evaluation.best.remainingPercent))
    : messages.alertNoCandidate;
  return { body, suggestion };
}

interface QuotaAlertOptions {
  /** Receives every successful poll so other views can show the fresh numbers. */
  readonly onUsage?: (results: readonly Rly0AccountUsageEntry[]) => void;
  /** Called after the person confirmed and the core switched the saved login. */
  readonly onSwitched?: () => void;
}

function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Low-quota banner shared by the Accounts page and the dashboard. Off by default; when the
 * appearance preference enables it, polls `usageAll` at the chosen frequency while the page is
 * mounted. The only action is a "switch" button that opens a confirmation dialog (stating that
 * Codex must be restarted); it never switches accounts on its own.
 */
export function mountRly0QuotaAlert(
  root: HTMLElement,
  signal: AbortSignal,
  getClient: () => RendererRly0QuotaAlertClient | null,
  settingsMessages: RendererSettingsMessages,
  options: QuotaAlertOptions = {},
) {
  const messages = settingsMessages.rly0Accounts;
  const document = root.ownerDocument;
  const view = document.defaultView ?? null;
  const element = document.createElement("div");
  element.className = "settings-rly0-quota-alert";
  element.setAttribute("role", "status");
  element.hidden = true;

  let evaluation: Rly0QuotaAlertEvaluation | null = null;
  let unavailable = false;
  let dismissedKey: string | null = null;
  let resultNotice: string | null = null;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let dialog: HTMLDialogElement | undefined;

  const enabled = (): boolean =>
    view !== null && safeRead(() => readRendererQuotaAlertEnabled(view), false);

  const evaluationKey = (value: Rly0QuotaAlertEvaluation): string =>
    `${value.current.id}:${value.period ?? "other"}:${value.best?.account.id ?? ""}`;

  const render = (): void => {
    if (!enabled()) {
      element.hidden = true;
      element.replaceChildren();
      return;
    }
    if (resultNotice) {
      const text = document.createElement("span");
      text.textContent = resultNotice;
      element.className = "settings-rly0-quota-alert settings-rly0-quota-alert--info";
      element.replaceChildren(text);
      element.hidden = false;
      return;
    }
    if (unavailable) {
      const text = document.createElement("span");
      text.textContent = messages.alertUnavailable;
      element.className = "settings-rly0-quota-alert settings-rly0-quota-alert--info";
      element.replaceChildren(text);
      element.hidden = false;
      return;
    }
    if (!evaluation || dismissedKey === evaluationKey(evaluation)) {
      element.hidden = true;
      element.replaceChildren();
      return;
    }
    const current = evaluation;
    const copy = rly0QuotaAlertText(current, messages);
    const textBlock = document.createElement("div");
    textBlock.className = "settings-rly0-quota-alert__text";
    const title = document.createElement("strong");
    title.textContent = messages.alertTitle;
    const body = document.createElement("span");
    body.textContent = copy.body;
    const suggestion = document.createElement("span");
    suggestion.textContent = copy.suggestion;
    textBlock.append(title, body, suggestion);
    const actions = document.createElement("div");
    actions.className = "settings-rly0-quota-alert__actions";
    if (current.best && getClient()?.switchRly0Account) {
      const target = current.best.account;
      const switchButton = document.createElement("button");
      switchButton.type = "button";
      switchButton.className = "settings-command-button";
      switchButton.textContent = messages.alertSwitch;
      switchButton.addEventListener("click", () => confirmSwitch(target));
      actions.append(switchButton);
    }
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "settings-command-button settings-command-button--secondary";
    dismiss.textContent = messages.alertDismiss;
    dismiss.addEventListener("click", () => {
      dismissedKey = evaluationKey(current);
      render();
    });
    actions.append(dismiss);
    element.className = "settings-rly0-quota-alert settings-rly0-quota-alert--warning";
    element.replaceChildren(textBlock, actions);
    element.hidden = false;
  };

  const poll = async (): Promise<void> => {
    if (polling || signal.aborted || !enabled()) return;
    const client = getClient();
    if (!client?.listRly0Accounts || !client.rly0AccountUsageAll) {
      unavailable = true;
      render();
      return;
    }
    polling = true;
    try {
      const listed = await client.listRly0Accounts();
      if (signal.aborted) return;
      if (!listed.available) {
        unavailable = true;
        evaluation = null;
        return;
      }
      const usage = await client.rly0AccountUsageAll();
      if (signal.aborted) return;
      if (!usage.available) {
        unavailable = true;
        evaluation = null;
        return;
      }
      unavailable = false;
      const usageById = new Map<string, Rly0AccountUsage>();
      for (const entry of usage.results) if ("usage" in entry) usageById.set(entry.id, entry.usage);
      options.onUsage?.(usage.results);
      evaluation = evaluateRly0QuotaAlert(
        listed.accounts,
        usageById,
        safeRead(() => readRendererQuotaAlertThresholdPercent(view as Window), 10),
      );
    } catch {
      // A failed poll keeps the previous banner; the next tick retries.
    } finally {
      polling = false;
      if (!signal.aborted) render();
    }
  };

  const schedule = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    resultNotice = null;
    if (!enabled() || signal.aborted || !view) {
      render();
      return;
    }
    const frequency = safeRead(() => readRendererQuotaRefreshFrequency(view), "1m" as const);
    timer = setInterval(() => void poll(), RENDERER_QUOTA_REFRESH_INTERVALS_MS[frequency]);
    render();
    void poll();
  };

  const confirmSwitch = (target: Rly0Account): void => {
    if (dialog || signal.aborted) return;
    const switchAccount = getClient()?.switchRly0Account;
    if (!switchAccount) return;
    const name = rly0AccountDisplayName(target);
    const modal = document.createElement("dialog");
    dialog = modal;
    modal.className = "settings-account-dialog settings-credential-dialog";
    const heading = document.createElement("h2");
    heading.textContent = messages.switchConfirmTitle;
    const body = document.createElement("div");
    body.className = "settings-credential-dialog__body";
    const note = document.createElement("p");
    note.textContent = messages.switchConfirmBody.replace("{name}", name);
    body.append(note);
    const error = document.createElement("p");
    error.className = "settings-credential-dialog__error";
    error.setAttribute("role", "alert");
    const controls = document.createElement("div");
    controls.className = "settings-credential-dialog__actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "settings-command-button settings-command-button--secondary";
    cancel.textContent = messages.cancel;
    cancel.addEventListener("click", () => modal.close());
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "settings-command-button";
    confirm.textContent = messages.switchConfirm;
    let busy = false;
    confirm.addEventListener("click", () => {
      if (busy) return;
      busy = true;
      cancel.disabled = true;
      confirm.disabled = true;
      error.textContent = "";
      void (async () => {
        try {
          const result = await switchAccount({ id: target.id });
          if (signal.aborted) return;
          if (!result.available) {
            error.textContent = messages.unavailableHint;
            return;
          }
          resultNotice = result.alreadyCurrent
            ? messages.switchAlreadyCurrent.replace("{name}", name)
            : messages.switchRequiresRestart.replace("{name}", name);
          evaluation = null;
          options.onSwitched?.();
          modal.close();
        } catch {
          if (!signal.aborted) error.textContent = messages.switchFailed;
        } finally {
          busy = false;
          cancel.disabled = false;
          confirm.disabled = false;
        }
      })();
    });
    controls.append(cancel, confirm);
    modal.append(heading, body, error, controls);
    modal.addEventListener("cancel", (event) => {
      if (busy) event.preventDefault();
    });
    modal.addEventListener("close", () => {
      modal.remove();
      dialog = undefined;
      render();
    });
    root.append(modal);
    modal.showModal();
    cancel.focus();
  };

  const onPreferenceChange = (): void => schedule();
  if (view) {
    view.addEventListener(RENDERER_QUOTA_ALERT_CHANGE_EVENT, onPreferenceChange);
    view.addEventListener(RENDERER_QUOTA_REFRESH_CHANGE_EVENT, onPreferenceChange);
  }
  signal.addEventListener(
    "abort",
    () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      view?.removeEventListener(RENDERER_QUOTA_ALERT_CHANGE_EVENT, onPreferenceChange);
      view?.removeEventListener(RENDERER_QUOTA_REFRESH_CHANGE_EVENT, onPreferenceChange);
      dialog?.remove();
    },
    { once: true },
  );
  schedule();

  return { element: element as HTMLElement, poll };
}
