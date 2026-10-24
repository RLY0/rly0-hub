import type { Rly0Relay } from "@codexhost/shared-contracts";

import type { Rly0CoreBridge } from "../rly0-core/index.js";
import { officialVendorOf } from "../rly0-relay/official-keys.js";
import {
  readQuotaUsage,
  type Rly0AutoSwitchAgent,
  type Rly0AutoSwitchCandidate,
} from "./agent-auto-switch.js";

/**
 * Where the Claude / Grok auto-switch reads its candidates and how it switches, from what the
 * 账号 page already uses:
 * - Claude runs on its login unless the agent relay selection binds it to a relay. A saved
 *   account is in use when it is the live login and nothing is bound; a saved subscription token
 *   when the selection names it. Bound to any other relay or an API key, Claude has no quota to
 *   watch, so nothing is current and nothing switches.
 * - Grok always runs on its live login (`auth.json`); the saved account that is that login is
 *   current.
 * Switching goes through the page's own routes (`agents.claudeAccounts.switch`,
 * `agents.officialKeys.select`, `agents.grokAccounts.switch`).
 */
export interface AgentAutoSwitchSourceDeps {
  readonly core: Pick<Rly0CoreBridge, "claudeAccounts" | "grokAccounts" | "listRelays">;
  /** Relay id Claude Code is bound to (null: its own login). */
  readonly claudeSelection: () => Promise<string | null>;
  /** Keeps the token's quota for the 账号 page (official-key-usage.json). */
  readonly recordTokenUsage: (relay: Rly0Relay, info: Record<string, unknown>) => Promise<unknown>;
  readonly handle: (method: string, params: unknown) => Promise<unknown>;
}

interface SavedAccount {
  readonly id: string;
  readonly alias?: string;
  readonly email?: string;
  readonly current?: boolean;
}

function savedAccounts(listed: Record<string, unknown> | null): SavedAccount[] | null {
  if (!listed || !Array.isArray(listed.accounts)) return null;
  return (listed.accounts as unknown[]).flatMap((value) => {
    const a = value as Record<string, unknown> | null;
    if (!a || typeof a.id !== "string" || !/^[a-f0-9]{12}$/u.test(a.id)) return [];
    return [
      {
        id: a.id,
        ...(typeof a.alias === "string" ? { alias: a.alias } : {}),
        ...(typeof a.email === "string" ? { email: a.email } : {}),
        current: a.current === true,
      },
    ];
  });
}

const accountName = (a: SavedAccount, fallback: string) => a.alias || a.email || fallback;

export function createAgentAutoSwitchSources(deps: AgentAutoSwitchSourceDeps) {
  const { core } = deps;

  /** Fresh quota of each named account: `usage` for one, `usageAll` for several. */
  async function accountUsage(
    agent: Rly0AutoSwitchAgent,
    ids: readonly string[],
  ): Promise<Map<string, ReturnType<typeof readQuotaUsage>>> {
    const read = (method: "usage" | "usageAll", params: Record<string, unknown> = {}) =>
      (agent === "claude"
        ? core.claudeAccounts(method, params)
        : core.grokAccounts(method, params)
      ).catch(() => null);
    const out = new Map<string, ReturnType<typeof readQuotaUsage>>();
    if (ids.length === 0) return out;
    if (ids.length === 1) {
      const id = ids[0] as string;
      out.set(id, readQuotaUsage(await read("usage", { id })));
      return out;
    }
    const all = await read("usageAll");
    const results = Array.isArray(all?.results) ? (all.results as unknown[]) : [];
    for (const value of results) {
      const r = value as Record<string, unknown> | null;
      // A failed read stays unknown, whatever the account showed before.
      if (r && typeof r.id === "string" && ids.includes(r.id) && r.ok !== false && !r.error)
        out.set(r.id, readQuotaUsage(r.usage));
    }
    return out;
  }

  async function tokenUsage(relay: Rly0Relay) {
    const info = await core.claudeAccounts("keyInfo", { relayId: relay.id }).catch(() => null);
    if (!info) return null;
    await deps.recordTokenUsage(relay, info).catch(() => undefined);
    if (info.kind !== "subscription" || info.valid === false || info.usageError) return null;
    return readQuotaUsage(info.usage);
  }

  async function claude(scope: "current" | "all"): Promise<Rly0AutoSwitchCandidate[] | null> {
    const [listed, relays, selected] = await Promise.all([
      core.claudeAccounts("list").catch(() => null),
      core.listRelays().catch(() => ({ available: false as const })),
      deps.claudeSelection(),
    ]);
    const accounts = savedAccounts(listed);
    if (!accounts) return null;
    const tokens =
      relays.available && "relays" in relays
        ? relays.relays.filter((r) => officialVendorOf(r) === "anthropic" && r.enabled && r.hasKey)
        : [];
    const isCurrentAccount = (a: SavedAccount) => selected === null && a.current === true;
    const wanted = (current: boolean) => scope === "all" || current;
    const usage = await accountUsage(
      "claude",
      accounts.filter((a) => wanted(isCurrentAccount(a))).map((a) => a.id),
    );
    const tokenCandidates: Rly0AutoSwitchCandidate[] = [];
    for (const relay of tokens) {
      const current = selected === relay.id;
      const last4 = (relay.keyMask ?? "").slice(-4);
      tokenCandidates.push({
        id: relay.id,
        kind: "token",
        name: `${relay.name || "Claude 订阅令牌"}${last4 ? `（····${last4}）` : ""}`,
        current,
        usage: wanted(current) ? await tokenUsage(relay) : null,
      });
    }
    return [
      ...accounts.map((a): Rly0AutoSwitchCandidate => ({
        id: a.id,
        kind: "account",
        name: accountName(a, "Claude 账号"),
        current: isCurrentAccount(a),
        usage: usage.get(a.id) ?? null,
      })),
      ...tokenCandidates,
    ];
  }

  async function grok(scope: "current" | "all"): Promise<Rly0AutoSwitchCandidate[] | null> {
    const accounts = savedAccounts(await core.grokAccounts("list").catch(() => null));
    if (!accounts) return null;
    const usage = await accountUsage(
      "grok",
      accounts.filter((a) => scope === "all" || a.current).map((a) => a.id),
    );
    return accounts.map((a) => ({
      id: a.id,
      kind: "account",
      name: accountName(a, "Grok 账号"),
      current: a.current === true,
      usage: usage.get(a.id) ?? null,
    }));
  }

  return {
    candidates: (agent: Rly0AutoSwitchAgent, scope: "current" | "all") =>
      agent === "claude" ? claude(scope) : grok(scope),
    async switchTo(agent: Rly0AutoSwitchAgent, target: Rly0AutoSwitchCandidate): Promise<boolean> {
      if (agent === "grok") {
        const r = (await deps.handle("agents.grokAccounts.switch", { id: target.id })) as {
          switched?: boolean;
        } | null;
        return r?.switched === true;
      }
      if (target.kind === "token") {
        const r = (await deps.handle("agents.officialKeys.select", {
          vendor: "anthropic",
          id: target.id,
        })) as { ok?: boolean } | null;
        return r?.ok === true;
      }
      const r = (await deps.handle("agents.claudeAccounts.switch", { id: target.id })) as {
        switched?: boolean;
      } | null;
      return r?.switched === true;
    },
  };
}
