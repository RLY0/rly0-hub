import type { Rly0Account, Rly0AccountUsage } from "@codexhost/shared-contracts";

/**
 * Switch Codex accounts before the current one runs out, the way AiMaMi does: when the current
 * account's remaining 5-hour or weekly quota falls below its threshold, move to the saved account
 * with the most quota left. Off by default; by default it only asks (a tray notice), because a
 * switch restarts Codex and stops whatever is running.
 */
export interface Rly0AutoSwitchSettings {
  readonly enabled: boolean;
  /** Remaining percent of the 5-hour window below which to switch. */
  readonly remain5h: number;
  /** Remaining percent of the weekly window below which to switch. */
  readonly remainWeekly: number;
  /** "ask": tray notice with a switch button; "auto": switch and restart Codex right away. */
  readonly mode: "ask" | "auto";
}

export const RLY0_AUTO_SWITCH_DEFAULTS: Rly0AutoSwitchSettings = {
  enabled: false,
  remain5h: 15,
  remainWeekly: 10,
  mode: "ask",
};

export function cleanAutoSwitchSettings(value: unknown): Rly0AutoSwitchSettings {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const percent = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(90, Math.max(1, Math.round(v)))
      : fallback;
  return {
    enabled: raw.enabled === true,
    remain5h: percent(raw.remain5h, RLY0_AUTO_SWITCH_DEFAULTS.remain5h),
    remainWeekly: percent(raw.remainWeekly, RLY0_AUTO_SWITCH_DEFAULTS.remainWeekly),
    mode: raw.mode === "auto" ? "auto" : "ask",
  };
}

function remaining(
  usage: Rly0AccountUsage | undefined,
  kind: "primary" | "secondary",
): number | null {
  const window = usage?.windows.find((w) => w.kind === kind);
  return window ? Math.max(0, 100 - window.usedPercent) : null;
}

export interface Rly0AutoSwitchDecision {
  /** Which window ran low, and how much of it is left. */
  readonly reason: {
    readonly window: "5h" | "weekly";
    readonly left: number;
    readonly resetsAt?: number;
  };
  /** Saved account to move to; null when none has enough quota either. */
  readonly target: { readonly id: string; readonly name: string; readonly left: number } | null;
}

/**
 * `current` is the live login's usage; `accounts` are the saved ones with their last readings.
 * Returns null while the current account is above both thresholds.
 */
export function decideAutoSwitch(
  settings: Rly0AutoSwitchSettings,
  current: { readonly id?: string; readonly usage: Rly0AccountUsage },
  accounts: readonly Rly0Account[],
): Rly0AutoSwitchDecision | null {
  if (!settings.enabled) return null;
  const left5h = remaining(current.usage, "primary");
  const leftWeekly = remaining(current.usage, "secondary");
  const low5h = left5h !== null && left5h < settings.remain5h;
  const lowWeekly = leftWeekly !== null && leftWeekly < settings.remainWeekly;
  if (!low5h && !lowWeekly) return null;
  const window = lowWeekly ? "weekly" : "5h";
  const lowWindow = current.usage.windows.find(
    (w) => w.kind === (lowWeekly ? "secondary" : "primary"),
  );
  const reason = {
    window,
    left: Math.round((lowWeekly ? leftWeekly : left5h) ?? 0),
    ...(lowWindow?.resetsAt ? { resetsAt: lowWindow.resetsAt } : {}),
  } as const;
  let best: Rly0AutoSwitchDecision["target"] = null;
  for (const account of accounts) {
    if (account.id === current.id || account.current) continue;
    const a5h = remaining(account.lastUsage, "primary");
    const aWeekly = remaining(account.lastUsage, "secondary");
    // Unknown quota is not trusted: an account must show it has room.
    if (a5h === null) continue;
    if (a5h < settings.remain5h || (aWeekly !== null && aWeekly < settings.remainWeekly)) continue;
    const left = Math.round(Math.min(a5h, aWeekly ?? 100));
    if (!best || left > best.left) {
      best = { id: account.id, name: account.alias || account.email || "另一个账号", left };
    }
  }
  return { reason, target: best };
}
