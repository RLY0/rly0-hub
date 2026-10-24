import type { Rly0HubAlert } from "./alerts.js";
import { RLY0_AUTO_SWITCH_DEFAULTS, type Rly0AutoSwitchSettings } from "./auto-switch.js";

/**
 * Auto-switch for Claude Code and Grok, the same idea as Codex's (auto-switch.ts): when the
 * credential the agent runs on falls below a threshold, move it to the saved one with the most
 * quota left. Off by default per agent, and turning it on needs a one-time risk confirmation
 * (rotating subscription accounts can break the vendor's terms).
 *
 * - Claude: saved Claude Code accounts and saved subscription tokens (bound through the agent
 *   relay selection); quota windows 5 小时 (`primary`) and 每周 (`secondary`).
 * - Grok (测试版): saved Grok CLI accounts; one credits window, `weekly` / `monthly` / `credits`.
 * - Gemini (Antigravity) keeps one shared keyring login, so it has no auto-switch.
 *
 * A switch only changes which credential new requests use; it never restarts anything. While a
 * reply is running (the Codex heartbeat says busy) the switch waits until it ends.
 */
export const RLY0_AUTO_SWITCH_AGENTS = ["claude", "grok"] as const;
export type Rly0AutoSwitchAgent = (typeof RLY0_AUTO_SWITCH_AGENTS)[number];

export interface Rly0AgentAutoSwitchSettings extends Rly0AutoSwitchSettings {
  /** The person confirmed the terms-of-service risk once; kept when switched off again. */
  readonly riskAccepted: boolean;
}

export const RLY0_AGENT_AUTO_SWITCH_DEFAULTS: Rly0AgentAutoSwitchSettings = {
  ...RLY0_AUTO_SWITCH_DEFAULTS,
  riskAccepted: false,
};

/** A target must be this many points above every threshold, so two accounts do not ping-pong. */
export const RLY0_AUTO_SWITCH_HYSTERESIS = 10;
/** At most one automatic switch per agent in this long; a later low reading only asks. */
export const RLY0_AUTO_SWITCH_COOLDOWN_MS = 30 * 60_000;

const VENDOR: Record<Rly0AutoSwitchAgent, string> = { claude: "Claude", grok: "Grok" };

export function cleanAgentAutoSwitchSettings(value: unknown): Rly0AgentAutoSwitchSettings {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const percent = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(90, Math.max(1, Math.round(v)))
      : fallback;
  const riskAccepted = raw.riskAccepted === true;
  return {
    // Never on without the confirmation, whatever the file says.
    enabled: raw.enabled === true && riskAccepted,
    remain5h: percent(raw.remain5h, RLY0_AUTO_SWITCH_DEFAULTS.remain5h),
    remainWeekly: percent(raw.remainWeekly, RLY0_AUTO_SWITCH_DEFAULTS.remainWeekly),
    mode: raw.mode === "auto" ? "auto" : "ask",
    riskAccepted,
  };
}

/** Per-agent settings as kept in hub-desktop.json; unknown agents and bad values are dropped. */
export function cleanAgentAutoSwitchMap(
  value: unknown,
): Partial<Record<Rly0AutoSwitchAgent, Rly0AgentAutoSwitchSettings>> {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const out: Partial<Record<Rly0AutoSwitchAgent, Rly0AgentAutoSwitchSettings>> = {};
  for (const agent of RLY0_AUTO_SWITCH_AGENTS)
    if (raw[agent] !== undefined) out[agent] = cleanAgentAutoSwitchSettings(raw[agent]);
  return out;
}

export function cleanAgentRecord<T>(
  value: unknown,
  keep: (v: unknown) => v is T,
): Partial<Record<Rly0AutoSwitchAgent, T>> {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const out: Partial<Record<Rly0AutoSwitchAgent, T>> = {};
  for (const agent of RLY0_AUTO_SWITCH_AGENTS) {
    const v = raw[agent];
    if (keep(v)) out[agent] = v;
  }
  return out;
}

export interface Rly0QuotaWindow {
  readonly kind: string;
  readonly usedPercent: number;
  readonly resetsAt?: number;
}

/** Usage as rly0-core reports it; null for anything else (an error, a missing reading). */
export function readQuotaUsage(value: unknown): { windows: Rly0QuotaWindow[] } | null {
  const windows = (value as { windows?: unknown } | null)?.windows;
  if (!Array.isArray(windows)) return null;
  const clean: Rly0QuotaWindow[] = [];
  for (const w of windows as unknown[]) {
    const o = w as Record<string, unknown> | null;
    if (!o || typeof o.kind !== "string" || typeof o.usedPercent !== "number") continue;
    if (!Number.isFinite(o.usedPercent)) continue;
    clean.push({
      kind: o.kind,
      usedPercent: Math.min(100, Math.max(0, o.usedPercent)),
      ...(typeof o.resetsAt === "number" && Number.isFinite(o.resetsAt)
        ? { resetsAt: o.resetsAt }
        : {}),
    });
  }
  return clean.length ? { windows: clean } : null;
}

/** A credential the agent can run on, with its reading from this check. */
export interface Rly0AutoSwitchCandidate {
  readonly id: string;
  readonly kind: "account" | "token";
  readonly name: string;
  /** The agent runs on this one now. */
  readonly current: boolean;
  /** Read in this check; null when unknown or the read failed (never switched to). */
  readonly usage: { readonly windows: readonly Rly0QuotaWindow[] } | null;
}

interface WindowRule {
  readonly kinds: readonly string[];
  readonly setting: "remain5h" | "remainWeekly";
}

/** Longer windows first: a low weekly quota is the one worth naming. */
const RULES: Record<Rly0AutoSwitchAgent, readonly WindowRule[]> = {
  claude: [
    { kinds: ["secondary"], setting: "remainWeekly" },
    { kinds: ["primary"], setting: "remain5h" },
  ],
  grok: [{ kinds: ["monthly", "weekly", "credits"], setting: "remainWeekly" }],
};

const WINDOW_LABEL: Record<string, string> = {
  primary: "5 小时",
  secondary: "每周",
  weekly: "每周",
  monthly: "每月",
  credits: "",
};

export interface Rly0AgentAutoSwitchDecision {
  readonly current: Rly0AutoSwitchCandidate;
  readonly reason: {
    readonly kind: string;
    readonly label: string;
    readonly left: number;
    readonly resetsAt?: number;
  };
  /** Best saved credential to move to; null when none has enough room either. */
  readonly target: (Rly0AutoSwitchCandidate & { readonly left: number }) | null;
}

function windowFor(
  usage: Rly0AutoSwitchCandidate["usage"],
  rule: WindowRule,
): Rly0QuotaWindow | undefined {
  return usage?.windows.find((w) => rule.kinds.includes(w.kind));
}

/**
 * Null while switched off, while the current credential's quota is unknown, or while it is above
 * every threshold. A target needs a known reading in every window the current one has, each at
 * least `threshold + RLY0_AUTO_SWITCH_HYSTERESIS` left.
 */
export function decideAgentAutoSwitch(
  agent: Rly0AutoSwitchAgent,
  settings: Rly0AgentAutoSwitchSettings,
  candidates: readonly Rly0AutoSwitchCandidate[],
): Rly0AgentAutoSwitchDecision | null {
  if (!settings.enabled) return null;
  const current = candidates.find((c) => c.current);
  if (!current?.usage) return null;
  const rules = RULES[agent].filter((rule) => windowFor(current.usage, rule));
  let reason: Rly0AgentAutoSwitchDecision["reason"] | null = null;
  for (const rule of rules) {
    const w = windowFor(current.usage, rule);
    if (!w) continue;
    const left = 100 - w.usedPercent;
    if (left < settings[rule.setting]) {
      reason = {
        kind: w.kind,
        label: WINDOW_LABEL[w.kind] ?? "",
        left: Math.round(left),
        ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
      };
      break;
    }
  }
  if (!reason) return null;
  let target: Rly0AgentAutoSwitchDecision["target"] = null;
  for (const candidate of candidates) {
    if (candidate.current || !candidate.usage) continue;
    let room = Infinity;
    for (const rule of rules) {
      const w = windowFor(candidate.usage, rule);
      const left = w ? 100 - w.usedPercent : null;
      if (left === null || left < settings[rule.setting] + RLY0_AUTO_SWITCH_HYSTERESIS) {
        room = -1;
        break;
      }
      room = Math.min(room, left);
    }
    if (room < 0 || !Number.isFinite(room)) continue;
    const left = Math.round(room);
    if (!target || left > target.left) target = { ...candidate, left };
  }
  return { current, reason, target };
}

export interface Rly0AgentAutoSwitchStore {
  readonly settings: (agent: Rly0AutoSwitchAgent) => Promise<Rly0AgentAutoSwitchSettings>;
  /** Account, window and reset a notice or switch was made for (one each). */
  readonly handled: (agent: Rly0AutoSwitchAgent) => Promise<string | undefined>;
  readonly markHandled: (agent: Rly0AutoSwitchAgent, key: string) => Promise<void>;
  readonly lastSwitchAt: (agent: Rly0AutoSwitchAgent) => Promise<number | undefined>;
  readonly markSwitched: (agent: Rly0AutoSwitchAgent, at: number) => Promise<void>;
}

export interface Rly0AgentAutoSwitchDeps {
  readonly store: Rly0AgentAutoSwitchStore;
  /**
   * The agent's credentials with fresh readings: `current` reads only the one in use (the
   * regular check), `all` reads every saved one (when the current one ran low). Null when the
   * agent's accounts cannot be listed.
   */
  readonly candidates: (
    agent: Rly0AutoSwitchAgent,
    scope: "current" | "all",
  ) => Promise<readonly Rly0AutoSwitchCandidate[] | null>;
  /** Through the same paths as the 账号 page's 切换到这个. */
  readonly switchTo: (
    agent: Rly0AutoSwitchAgent,
    candidate: Rly0AutoSwitchCandidate,
  ) => Promise<boolean>;
  /** From the Codex heartbeat: a reply, tool call or agent task is running; null when unknown. */
  readonly busy: () => Promise<boolean | null>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  /** Give up waiting for the running reply after this long; the person is asked instead. */
  readonly maxWaitMs?: number;
}

export type Rly0AgentAutoSwitchAlert = Rly0HubAlert & { readonly agent: Rly0AutoSwitchAgent };

/** Runs the per-agent checks for the tray's alert poll, and the tray notice's one-click switch. */
export class Rly0AgentAutoSwitcher {
  readonly #deps: Rly0AgentAutoSwitchDeps;
  /** Agents with a switch waiting for the running reply to finish. */
  readonly #waiting = new Map<Rly0AutoSwitchAgent, Promise<void>>();
  /** Notices produced between polls (a deferred switch that went through). */
  #ready: Rly0AgentAutoSwitchAlert[] = [];

  constructor(deps: Rly0AgentAutoSwitchDeps) {
    this.#deps = deps;
  }

  waiting(agent: Rly0AutoSwitchAgent): boolean {
    return this.#waiting.has(agent);
  }

  /** Settles once every waiting switch has finished (tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.#waiting.values()]);
  }

  async check(): Promise<Rly0AgentAutoSwitchAlert[]> {
    const alerts: Rly0AgentAutoSwitchAlert[] = [];
    for (const agent of RLY0_AUTO_SWITCH_AGENTS) {
      const alert = await this.#checkAgent(agent).catch(() => null);
      if (alert) alerts.push(alert);
    }
    const ready = this.#ready;
    this.#ready = [];
    return [...ready, ...alerts];
  }

  /** The tray notice's click (or the page): switch now, or as soon as the running reply ends. */
  async apply(
    agent: Rly0AutoSwitchAgent,
    id: string,
  ): Promise<{ switched: boolean; deferred: boolean }> {
    const candidates = (await this.#deps.candidates(agent, "all")) ?? [];
    const target = candidates.find((c) => c.id === id && !c.current);
    // Same rule as the automatic path: never to a credential whose quota is unknown.
    if (!target?.usage) return { switched: false, deferred: false };
    if ((await this.#deps.busy().catch(() => null)) === true) {
      this.#defer(agent, id, true);
      return { switched: false, deferred: true };
    }
    const switched = await this.#switch(agent, target);
    return { switched, deferred: false };
  }

  async #checkAgent(agent: Rly0AutoSwitchAgent): Promise<Rly0AgentAutoSwitchAlert | null> {
    const store = this.#deps.store;
    const settings = await store.settings(agent);
    if (!settings.enabled || this.#waiting.has(agent)) return null;
    let decision = decideAgentAutoSwitch(
      agent,
      settings,
      (await this.#deps.candidates(agent, "current")) ?? [],
    );
    if (!decision) return null;
    const key = `${decision.current.kind}:${decision.current.id}:${decision.reason.kind}:${decision.reason.resetsAt ?? 0}`;
    if ((await store.handled(agent)) === key) return null;
    // Low now: read every saved credential fresh before choosing.
    decision = decideAgentAutoSwitch(
      agent,
      settings,
      (await this.#deps.candidates(agent, "all")) ?? [],
    );
    // The fresh reading says it is fine after all (or unknown): ask again next time.
    if (!decision) return null;
    await store.markHandled(agent, key);
    const vendor = VENDOR[agent];
    const low = `${vendor} ${decision.reason.label}额度只剩 ${decision.reason.left}%`;
    const { target } = decision;
    if (!target) {
      return {
        agent,
        id: "all-low",
        title: low,
        body: "保存的账号额度都不多了，可以先用其他 AI。",
        action: "open",
      };
    }
    const suggest: Rly0AgentAutoSwitchAlert = {
      agent,
      id: "switch-suggest",
      title: low,
      body: `点这里切换到 ${target.name}（还有 ${target.left}%），新的请求就用它，不用重启。`,
      action: "switch",
      accountId: target.id,
    };
    if (settings.mode !== "auto") return suggest;
    const now = (this.#deps.now ?? Date.now)();
    const last = await store.lastSwitchAt(agent);
    // Debounce: right after an automatic switch, only ask.
    if (last !== undefined && now - last < RLY0_AUTO_SWITCH_COOLDOWN_MS) return suggest;
    if ((await this.#deps.busy().catch(() => null)) === true) {
      this.#defer(agent, target.id);
      return {
        agent,
        id: "switch-suggest",
        title: low,
        body: `等当前回复结束后，自动切换到 ${target.name}（还有 ${target.left}%）。`,
        action: "open",
      };
    }
    if (await this.#switch(agent, target)) return this.#switched(agent, decision, target);
    return suggest;
  }

  #switched(
    agent: Rly0AutoSwitchAgent,
    decision: Rly0AgentAutoSwitchDecision,
    target: { name: string; left: number },
  ): Rly0AgentAutoSwitchAlert {
    return {
      agent,
      id: "switched",
      title: `${VENDOR[agent]} 已切换到 ${target.name}`,
      body: `原账号${decision.reason.label}额度只剩 ${decision.reason.left}%，新账号还有 ${target.left}%。新的请求就用它，正在进行的回复不受影响。`,
      action: "open",
    };
  }

  async #switch(agent: Rly0AutoSwitchAgent, target: Rly0AutoSwitchCandidate): Promise<boolean> {
    const ok = await this.#deps.switchTo(agent, target).catch(() => false);
    if (ok) await this.#deps.store.markSwitched(agent, (this.#deps.now ?? Date.now)());
    return ok;
  }

  /**
   * One waiting switch per agent; every quota is read again before switching. A tray click
   * (`explicit`) keeps its target while that still has known room; the automatic path takes
   * whatever is best by then, or nothing when the current one has recovered.
   */
  #defer(agent: Rly0AutoSwitchAgent, targetId: string, explicit = false): void {
    if (this.#waiting.has(agent)) return;
    const run = this.#waitThenSwitch(agent, targetId, explicit)
      .catch(() => undefined)
      .finally(() => {
        this.#waiting.delete(agent);
      });
    this.#waiting.set(agent, run);
  }

  async #waitThenSwitch(
    agent: Rly0AutoSwitchAgent,
    targetId: string,
    explicit: boolean,
  ): Promise<void> {
    const now = this.#deps.now ?? Date.now;
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + (this.#deps.maxWaitMs ?? 30 * 60_000);
    for (;;) {
      await sleep(this.#deps.pollMs ?? 3_000);
      const busy = await this.#deps.busy().catch(() => null);
      // Not busy, or Codex closed (no heartbeat): nothing of the agent's is running there.
      if (busy !== true) break;
      if (now() >= deadline) return;
    }
    const candidates = (await this.#deps.candidates(agent, "all")) ?? [];
    if (explicit) {
      const target = candidates.find((c) => c.id === targetId && !c.current && c.usage);
      if (target && (await this.#switch(agent, target)))
        this.#ready.push({
          agent,
          id: "switched",
          title: `${VENDOR[agent]} 已切换到 ${target.name}`,
          body: "新的请求就用它，正在进行的回复不受影响。",
          action: "open",
        });
      return;
    }
    const settings = await this.#deps.store.settings(agent);
    const decision = decideAgentAutoSwitch(agent, settings, candidates);
    if (!decision?.target || !(await this.#switch(agent, decision.target))) return;
    this.#ready.push(this.#switched(agent, decision, decision.target));
  }
}
