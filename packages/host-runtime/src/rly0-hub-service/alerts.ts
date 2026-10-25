import type { Rly0HubState } from "./hub-state.js";

/** Below this the tray says the 零号 balance is running out (in the relay's own unit). */
export const RLY0_LOW_BALANCE = { USD: 1, CNY: 7 } as const;
/** Codex 5-hour window used at or above this percentage counts as nearly gone. */
export const RLY0_LOW_QUOTA_USED_PERCENT = 90;

export interface Rly0HubAlert {
  readonly id:
    | "balance-low"
    | "quota-low"
    | "switch-suggest"
    | "switched"
    | "all-low"
    | "update"
    | "compatibility";
  readonly title: string;
  readonly body: string;
  /** What clicking the notice does: recharge, open the Hub, or switch to `accountId`. */
  readonly action: "recharge" | "open" | "switch";
  readonly accountId?: string;
  /** Claude / Grok auto-switch notices: whose account `accountId` is (absent: Codex). */
  readonly agent?: "claude" | "grok";
}

/** The person's own tray-notice thresholds (设置 → 通用). */
export interface Rly0AlertSettings {
  /** Notify when 零号's balance drops below this many US dollars (CNY relays: ×7). */
  readonly balanceUsd: number;
  /** Notify when this percent of the Codex 5-hour window is used. */
  readonly quotaUsedPercent: number;
}

export const RLY0_ALERT_DEFAULTS: Rly0AlertSettings = {
  balanceUsd: RLY0_LOW_BALANCE.USD,
  quotaUsedPercent: RLY0_LOW_QUOTA_USED_PERCENT,
};

export function cleanAlertSettings(value: unknown): Rly0AlertSettings {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const balance = raw.balanceUsd;
  const quota = raw.quotaUsedPercent;
  return {
    balanceUsd:
      typeof balance === "number" && Number.isFinite(balance) && balance >= 0 && balance <= 1000
        ? balance
        : RLY0_ALERT_DEFAULTS.balanceUsd,
    quotaUsedPercent:
      typeof quota === "number" && Number.isInteger(quota) && quota >= 50 && quota <= 100
        ? quota
        : RLY0_ALERT_DEFAULTS.quotaUsedPercent,
  };
}

export interface Rly0HubAlertInput {
  readonly balance?: { readonly amount: number; readonly unit: "USD" | "CNY" } | null;
  readonly quota?: { readonly usedPercent: number; readonly resetsAt?: number } | null;
}

function resetLabel(resetsAt: number | undefined): string {
  if (!resetsAt) return "";
  const date = new Date(resetsAt * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `，${pad(date.getHours())}:${pad(date.getMinutes())} 重置`;
}

/**
 * Tray notices, each shown once: low balance until the balance recovers, low Codex quota once per
 * quota window. Returns the notices to show now and the state to remember.
 */
export function evaluateRly0HubAlerts(
  input: Rly0HubAlertInput,
  state: Rly0HubState,
  settings: Rly0AlertSettings = RLY0_ALERT_DEFAULTS,
): { alerts: Rly0HubAlert[]; state: Rly0HubState } {
  const alerts: Rly0HubAlert[] = [];
  let next: Rly0HubState = state;

  if (input.balance) {
    const { amount, unit } = input.balance;
    const threshold = unit === "CNY" ? settings.balanceUsd * 7 : settings.balanceUsd;
    const low = amount < threshold;
    if (low && !state.balanceLowNotified) {
      const money = `${unit === "CNY" ? "¥" : "$"}${amount.toFixed(2)}`;
      alerts.push({
        id: "balance-low",
        title: "零号余额不多了",
        body: `还剩 ${money}，点这里充值。`,
        action: "recharge",
      });
      next = { ...next, balanceLowNotified: true };
    } else if (!low && state.balanceLowNotified) {
      next = { ...next, balanceLowNotified: false };
    }
  }

  if (input.quota && input.quota.usedPercent >= settings.quotaUsedPercent) {
    const window = input.quota.resetsAt ?? 0;
    if (state.quotaNotifiedFor !== window) {
      const left = Math.max(0, Math.round(100 - input.quota.usedPercent));
      alerts.push({
        id: "quota-low",
        title: `Codex 额度只剩 ${left}%`,
        body: `可以先用 Claude Code 等其他 AI${resetLabel(input.quota.resetsAt)}。`,
        action: "open",
      });
      next = { ...next, quotaNotifiedFor: window };
    }
  }
  return { alerts, state: next };
}
