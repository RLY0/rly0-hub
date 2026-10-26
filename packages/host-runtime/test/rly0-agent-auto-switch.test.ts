import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Rly0CoreBridge } from "../src/rly0-core/index.js";
import {
  cleanAgentAutoSwitchSettings,
  decideAgentAutoSwitch,
  RLY0_AGENT_AUTO_SWITCH_DEFAULTS,
  RLY0_AUTO_SWITCH_COOLDOWN_MS,
  Rly0AgentAutoSwitcher,
  type Rly0AgentAutoSwitchSettings,
  type Rly0AgentAutoSwitchStore,
  type Rly0AutoSwitchAgent,
  type Rly0AutoSwitchCandidate,
} from "../src/rly0-hub-service/agent-auto-switch.js";
import { Rly0HubService } from "../src/rly0-hub-service/service.js";
import { Rly0OfficialKeyUsage } from "../src/rly0-relay/official-key-usage.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const ON: Rly0AgentAutoSwitchSettings = {
  enabled: true,
  remain5h: 15,
  remainWeekly: 10,
  mode: "ask",
  riskAccepted: true,
};

/** Claude usage: percent used of the 5-hour and weekly windows. */
const claudeUsage = (used5h: number, usedWeekly?: number) => ({
  windows: [
    { kind: "primary", usedPercent: used5h, resetsAt: 1_000 },
    ...(usedWeekly === undefined
      ? []
      : [{ kind: "secondary", usedPercent: usedWeekly, resetsAt: 9_000 }]),
  ],
});

const cand = (
  id: string,
  usage: Rly0AutoSwitchCandidate["usage"],
  extra: Partial<Rly0AutoSwitchCandidate> = {},
): Rly0AutoSwitchCandidate => ({
  id,
  kind: "account",
  name: `账号${id.slice(0, 1)}`,
  current: false,
  usage,
  ...extra,
});

describe("decideAgentAutoSwitch", () => {
  it("is off by default and cannot be on without the risk confirmation", () => {
    expect(RLY0_AGENT_AUTO_SWITCH_DEFAULTS.enabled).toBe(false);
    expect(cleanAgentAutoSwitchSettings({}).enabled).toBe(false);
    expect(cleanAgentAutoSwitchSettings({ enabled: true }).enabled).toBe(false);
    expect(cleanAgentAutoSwitchSettings({ enabled: true, riskAccepted: true }).enabled).toBe(true);
    const low = [
      cand("aaaaaaaaaaaa", claudeUsage(95, 20), { current: true }),
      cand("bbbbbbbbbbbb", claudeUsage(0, 0)),
    ];
    expect(decideAgentAutoSwitch("claude", RLY0_AGENT_AUTO_SWITCH_DEFAULTS, low)).toBeNull();
  });

  it("does nothing while the current credential is above both thresholds", () => {
    const list = [
      cand("aaaaaaaaaaaa", claudeUsage(80, 85), { current: true }),
      cand("bbbbbbbbbbbb", claudeUsage(0, 0)),
    ];
    // 20% / 15% left, thresholds 15% / 10%.
    expect(decideAgentAutoSwitch("claude", ON, list)).toBeNull();
  });

  it("names the low window (weekly before 5 hours) and picks the most room", () => {
    const list = [
      cand("aaaaaaaaaaaa", claudeUsage(90, 95), { current: true }),
      cand("bbbbbbbbbbbb", claudeUsage(40, 30)),
      cand("cccccccccccc", claudeUsage(10, 20), { kind: "token", name: "Claude 订阅令牌" }),
    ];
    const decision = decideAgentAutoSwitch("claude", ON, list);
    expect(decision?.reason).toEqual({
      kind: "secondary",
      label: "每周",
      left: 5,
      resetsAt: 9_000,
    });
    // Room is the smaller of the two windows: b 60, c 80.
    expect(decision?.target).toMatchObject({ id: "cccccccccccc", kind: "token", left: 80 });

    const fiveHour = decideAgentAutoSwitch("claude", ON, [
      cand("aaaaaaaaaaaa", claudeUsage(90, 10), { current: true }),
      cand("bbbbbbbbbbbb", claudeUsage(40, 30)),
    ]);
    expect(fiveHour?.reason).toMatchObject({ kind: "primary", label: "5 小时", left: 10 });
  });

  it("never picks a credential whose quota is unknown, failing or missing a window", () => {
    expect(
      decideAgentAutoSwitch("claude", ON, [
        cand("aaaaaaaaaaaa", null, { current: true }),
        cand("bbbbbbbbbbbb", claudeUsage(0, 0)),
      ]),
    ).toBeNull();
    const decision = decideAgentAutoSwitch("claude", ON, [
      cand("aaaaaaaaaaaa", claudeUsage(95, 50), { current: true }),
      cand("bbbbbbbbbbbb", null),
      // Weekly unknown while the current one has it: not trusted.
      cand("cccccccccccc", claudeUsage(0)),
    ]);
    expect(decision?.reason.left).toBe(5);
    expect(decision?.target).toBeNull();
  });

  it("keeps a margin above the thresholds so two accounts do not flap", () => {
    const list = (otherUsed5h: number) => [
      cand("aaaaaaaaaaaa", claudeUsage(86, 0), { current: true }),
      cand("bbbbbbbbbbbb", claudeUsage(otherUsed5h, 0)),
    ];
    // 20% left is above 15% but inside the 10-point margin.
    expect(decideAgentAutoSwitch("claude", ON, list(80))?.target).toBeNull();
    expect(decideAgentAutoSwitch("claude", ON, list(75))?.target).toMatchObject({ left: 25 });
  });

  it("reads Grok's weekly or monthly credits against the credits threshold", () => {
    const credits = (kind: string, used: number) => ({
      windows: [{ kind, usedPercent: used, resetsAt: 5 }],
    });
    const decision = decideAgentAutoSwitch("grok", ON, [
      cand("aaaaaaaaaaaa", credits("weekly", 93), { current: true }),
      cand("bbbbbbbbbbbb", credits("monthly", 64)),
      cand("cccccccccccc", credits("weekly", 50)),
    ]);
    expect(decision?.reason).toMatchObject({ kind: "weekly", label: "每周", left: 7 });
    expect(decision?.target).toMatchObject({ id: "cccccccccccc", left: 50 });
    expect(
      decideAgentAutoSwitch("grok", ON, [
        cand("aaaaaaaaaaaa", credits("monthly", 50), { current: true }),
        cand("bbbbbbbbbbbb", credits("monthly", 0)),
      ]),
    ).toBeNull();
  });
});

function memoryStore(settings: Partial<Record<Rly0AutoSwitchAgent, Rly0AgentAutoSwitchSettings>>) {
  const handled = new Map<string, string>();
  const at = new Map<string, number>();
  const store: Rly0AgentAutoSwitchStore = {
    settings: async (agent) => settings[agent] ?? RLY0_AGENT_AUTO_SWITCH_DEFAULTS,
    handled: async (agent) => handled.get(agent),
    markHandled: async (agent, key) => {
      handled.set(agent, key);
    },
    lastSwitchAt: async (agent) => at.get(agent),
    markSwitched: async (agent, when) => {
      at.set(agent, when);
    },
  };
  return { store, handled, at };
}

function harness(
  settings: Partial<Record<Rly0AutoSwitchAgent, Rly0AgentAutoSwitchSettings>>,
  initial: Rly0AutoSwitchCandidate[],
) {
  let list = initial;
  const switched: string[] = [];
  const reads: string[] = [];
  let busy: boolean | null = false;
  let clock = 1_000_000;
  const { store } = memoryStore(settings);
  const switcher = new Rly0AgentAutoSwitcher({
    store,
    candidates: async (agent, scope) => {
      reads.push(`${agent}:${scope}`);
      return agent === "claude" ? list : [];
    },
    switchTo: async (_agent, target) => {
      switched.push(target.id);
      list = list.map((c) => ({ ...c, current: c.id === target.id }));
      return true;
    },
    busy: async () => busy,
    now: () => clock,
    sleep: async () => undefined,
    pollMs: 1,
  });
  return {
    switcher,
    switched,
    reads,
    setList: (next: Rly0AutoSwitchCandidate[]) => {
      list = next;
    },
    setBusy: (value: boolean | null) => {
      busy = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const lowClaude = () => [
  cand("aaaaaaaaaaaa", claudeUsage(92, 40), { current: true }),
  cand("bbbbbbbbbbbb", claudeUsage(10, 20), { name: "工作号" }),
];

describe("Rly0AgentAutoSwitcher", () => {
  it("reads nothing while switched off", async () => {
    const h = harness({}, lowClaude());
    expect(await h.switcher.check()).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it("only notifies in 先提醒我 mode, once per account, window and reset", async () => {
    const h = harness({ claude: ON }, lowClaude());
    const alerts = await h.switcher.check();
    expect(alerts).toEqual([
      expect.objectContaining({
        agent: "claude",
        id: "switch-suggest",
        action: "switch",
        accountId: "bbbbbbbbbbbb",
        title: "Claude 5 小时额度只剩 8%",
      }),
    ]);
    // Fresh readings of every saved one before choosing.
    expect(h.reads).toEqual(["claude:current", "claude:all"]);
    expect(h.switched).toEqual([]);
    expect(await h.switcher.check()).toEqual([]);
  });

  it("says when every saved account is low too, and never switches then", async () => {
    const h = harness({ claude: { ...ON, mode: "auto" } }, [
      cand("aaaaaaaaaaaa", claudeUsage(92, 40), { current: true }),
      cand("bbbbbbbbbbbb", claudeUsage(90, 20)),
      cand("cccccccccccc", null),
    ]);
    expect(await h.switcher.check()).toEqual([
      expect.objectContaining({ id: "all-low", action: "open" }),
    ]);
    expect(h.switched).toEqual([]);
  });

  it("switches in 直接切换 mode, then only asks during the cooldown", async () => {
    const h = harness({ claude: { ...ON, mode: "auto" } }, lowClaude());
    expect(await h.switcher.check()).toEqual([
      expect.objectContaining({ id: "switched", title: "Claude 已切换到 工作号" }),
    ]);
    expect(h.switched).toEqual(["bbbbbbbbbbbb"]);
    // The new one runs low soon after; the old one has recovered.
    h.setList([
      cand("aaaaaaaaaaaa", claudeUsage(0, 40)),
      cand("bbbbbbbbbbbb", claudeUsage(95, 20), { current: true, name: "工作号" }),
    ]);
    h.advance(RLY0_AUTO_SWITCH_COOLDOWN_MS / 2);
    expect(await h.switcher.check()).toEqual([
      expect.objectContaining({ id: "switch-suggest", accountId: "aaaaaaaaaaaa" }),
    ]);
    expect(h.switched).toEqual(["bbbbbbbbbbbb"]);
  });

  it("waits for the running reply before switching", async () => {
    const h = harness({ claude: { ...ON, mode: "auto" } }, lowClaude());
    h.setBusy(true);
    const first = await h.switcher.check();
    expect(first).toEqual([expect.objectContaining({ id: "switch-suggest", action: "open" })]);
    expect(first[0]?.body).toContain("等当前回复结束后");
    expect(h.switched).toEqual([]);
    expect(h.switcher.waiting("claude")).toBe(true);
    h.setBusy(false);
    await h.switcher.idle();
    expect(h.switched).toEqual(["bbbbbbbbbbbb"]);
    // The switch that went through is reported on the next poll.
    expect(await h.switcher.check()).toEqual([
      expect.objectContaining({ id: "switched", agent: "claude" }),
    ]);
  });

  it("drops a deferred switch when the quota recovered meanwhile", async () => {
    const h = harness({ claude: { ...ON, mode: "auto" } }, lowClaude());
    h.setBusy(true);
    await h.switcher.check();
    h.setList([
      cand("aaaaaaaaaaaa", claudeUsage(0, 0), { current: true }),
      cand("bbbbbbbbbbbb", claudeUsage(10, 20)),
    ]);
    h.setBusy(null);
    await h.switcher.idle();
    expect(h.switched).toEqual([]);
  });

  it("the tray click switches to its target, or after the running reply", async () => {
    const h = harness({ claude: ON }, [
      ...lowClaude(),
      cand("cccccccccccc", null, { name: "未知号" }),
    ]);
    expect(await h.switcher.apply("claude", "cccccccccccc")).toEqual({
      switched: false,
      deferred: false,
    });
    h.setBusy(true);
    expect(await h.switcher.apply("claude", "bbbbbbbbbbbb")).toEqual({
      switched: false,
      deferred: true,
    });
    h.setBusy(false);
    await h.switcher.idle();
    expect(h.switched).toEqual(["bbbbbbbbbbbb"]);
  });
});

// The real service with a fake rly0-core: candidates from saved accounts and subscription
// tokens, switching through the 账号 page's own routes, settings and the confirmation persisted.
describe("Claude / Grok auto-switch in the Hub service", () => {
  const relay = (id: string, name: string) => ({
    id,
    name,
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic",
    models: [],
    enabled: true,
    hasKey: true,
    keyMask: "****QwAA",
    keyRevision: "c".repeat(64),
    addedAt: "",
    updatedAt: "",
  });

  function fakeCore() {
    const calls: string[] = [];
    const claude = {
      current: "aaaaaaaaaaaa",
      usage: {
        aaaaaaaaaaaa: claudeUsage(95, 30),
        bbbbbbbbbbbb: claudeUsage(20, 10),
      } as Record<string, unknown>,
      failing: new Set(["dddddddddddd"]),
      token: claudeUsage(5, 5) as unknown,
    };
    const core = {
      listRelays: async () => ({
        available: true,
        relays: [relay("cccccccccccc", "Claude 订阅令牌")],
      }),
      relayBalance: async () => ({ available: false }),
      proxyStatus: async () => ({ available: true, running: true, port: 1, baseUrl: "x" }),
      listAccounts: async () => ({ available: true, accounts: [] }),
      getProxySettings: () => ({ mode: "system" }),
      dispose: async () => undefined,
      currentAccount: async () => ({ loggedIn: false }),
      usageCurrent: async () => ({ available: false }),
      claudeAccounts: async (method: string, p: Record<string, unknown> = {}) => {
        calls.push(`claude/${method}${p.id ? `:${String(p.id)}` : ""}`);
        const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "dddddddddddd"];
        if (method === "list")
          return {
            accounts: ids.map((id) => ({
              id,
              alias: `号${id.slice(0, 1)}`,
              current: id === claude.current,
            })),
          };
        if (method === "usage") {
          if (claude.failing.has(String(p.id))) throw new Error("USAGE_NETWORK");
          return claude.usage[String(p.id)] ?? null;
        }
        if (method === "usageAll")
          return {
            results: ids.map((id) =>
              claude.failing.has(id)
                ? { id, ok: false, error: "ACCOUNT_REFRESH_REJECTED" }
                : { id, ok: true, usage: claude.usage[id] },
            ),
          };
        // A subscription token's quota is never read from Anthropic by the auto-switch.
        if (method === "keyInfo") throw new Error("auto-switch must not read a token's quota");
        if (method === "switch") {
          claude.current = String(p.id);
          return { switched: true };
        }
        return null;
      },
      grokAccounts: async (method: string) => {
        calls.push(`grok/${method}`);
        return method === "list" ? { accounts: [] } : null;
      },
    };
    return { core: core as unknown as Rly0CoreBridge, calls, claude };
  }

  async function service(busy: () => Promise<boolean | null> = async () => false) {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-agent-switch-"));
    const fake = fakeCore();
    const hub = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: directory },
      installRoot: directory,
      core: fake.core,
      agentAutoSwitch: { busy, sleep: async () => undefined, pollMs: 1 },
    });
    // The numbers Claude Code's replies carried for the token (live quota feed → cache).
    const seedToken = async (usage: unknown) => {
      const later = Math.floor(Date.now() / 1000) + 3600;
      const windows = (usage as { windows: Record<string, unknown>[] }).windows.map((w) => ({
        ...w,
        resetsAt: later,
      }));
      await new Rly0OfficialKeyUsage({ CODEXHOST_DATA_DIR: directory }).record(
        relay("cccccccccccc", "Claude 订阅令牌") as never,
        { kind: "subscription", usage: { windows, fetchedAt: later - 3600, source: "live" } },
      );
    };
    await seedToken(fake.claude.token);
    return { hub, root: directory, seedToken, ...fake };
  }

  const settings = { remain5h: 15, remainWeekly: 10, mode: "auto" } as const;

  it("is off by default, needs the confirmation once, and remembers it", async () => {
    const { hub, root, calls } = await service();
    expect(await hub.handle("agents.autoSwitch.get", { agent: "claude" })).toMatchObject({
      enabled: false,
      riskAccepted: false,
      mode: "ask",
    });
    expect(((await hub.handle("alerts.check", {})) as { alerts: unknown[] }).alerts).toEqual([]);
    expect(calls).toEqual([]);
    await expect(
      hub.handle("agents.autoSwitch.set", { agent: "claude", enabled: true, ...settings }),
    ).rejects.toThrow("AUTO_SWITCH_RISK_NOT_ACCEPTED");
    // Antigravity cannot keep accounts: no auto-switch to set.
    await expect(
      hub.handle("agents.autoSwitch.set", {
        agent: "gemini",
        enabled: true,
        acceptRisk: true,
        ...settings,
      }),
    ).rejects.toThrow("INVALID_PARAMS");
    await hub.handle("agents.autoSwitch.set", {
      agent: "claude",
      enabled: true,
      acceptRisk: true,
      ...settings,
    });
    await hub.handle("agents.autoSwitch.set", { agent: "claude", enabled: false, ...settings });
    expect(
      await hub.handle("agents.autoSwitch.set", { agent: "claude", enabled: true, ...settings }),
    ).toMatchObject({ enabled: true, riskAccepted: true, mode: "auto" });
    // Per agent: Grok stays off and unconfirmed.
    expect(await hub.handle("agents.autoSwitch.get", { agent: "grok" })).toMatchObject({
      enabled: false,
      riskAccepted: false,
    });
    const saved = JSON.parse(await fs.readFile(path.join(root, "hub-desktop.json"), "utf8"));
    expect(saved.agentAutoSwitch.claude).toMatchObject({ enabled: true, riskAccepted: true });
  });

  it("moves Claude Code to the saved token with the most room, via the page's own routes", async () => {
    const { hub, root, calls } = await service();
    await hub.handle("agents.autoSwitch.set", {
      agent: "claude",
      enabled: true,
      acceptRisk: true,
      ...settings,
    });
    const { alerts } = (await hub.handle("alerts.check", {})) as {
      alerts: Record<string, unknown>[];
    };
    // Account b has 80% / 90% left but the token has 95%; d's read failed and is never chosen.
    expect(alerts).toEqual([
      expect.objectContaining({
        agent: "claude",
        id: "switched",
        title: "Claude 已切换到 Claude 订阅令牌（····QwAA）",
      }),
    ]);
    expect(await hub.handle("agents.relays.get", {})).toMatchObject({
      claudeCode: "cccccccccccc",
    });
    expect(calls).not.toContain("claude/switch:dddddddddddd");
    const state = JSON.parse(await fs.readFile(path.join(root, "hub-desktop.json"), "utf8"));
    expect(typeof state.agentAutoSwitchAt.claude).toBe("number");
  });

  it("asks to move a low token back to a saved account; the click waits for the reply", async () => {
    let busy: boolean | null = true;
    const { hub, calls, seedToken } = await service(async () => busy);
    await hub.handle("agents.relays.set", { claudeCode: "cccccccccccc" });
    await seedToken(claudeUsage(97, 0));
    await hub.handle("agents.autoSwitch.set", {
      agent: "claude",
      enabled: true,
      acceptRisk: true,
      ...settings,
      mode: "ask",
    });
    const { alerts } = (await hub.handle("alerts.check", {})) as {
      alerts: Record<string, unknown>[];
    };
    // a is 95% used, d failed: b (80% / 90% left) is the one.
    expect(alerts).toEqual([
      expect.objectContaining({
        agent: "claude",
        id: "switch-suggest",
        action: "switch",
        accountId: "bbbbbbbbbbbb",
        title: "Claude 5 小时额度只剩 3%",
      }),
    ]);
    expect(calls).not.toContain("claude/switch:bbbbbbbbbbbb");
    expect(
      await hub.handle("agents.autoSwitch.apply", { agent: "claude", id: "bbbbbbbbbbbb" }),
    ).toEqual({ switched: false, deferred: true });
    expect(calls).not.toContain("claude/switch:bbbbbbbbbbbb");
    busy = false;
    for (let i = 0; i < 50 && !calls.includes("claude/switch:bbbbbbbbbbbb"); i += 1)
      await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContain("claude/switch:bbbbbbbbbbbb");
    // An account login means the official account, not the token.
    for (let i = 0; i < 50; i += 1) {
      const relays = (await hub.handle("agents.relays.get", {})) as { claudeCode: unknown };
      if (relays.claudeCode === null) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await hub.handle("agents.relays.get", {})).toMatchObject({ claudeCode: null });
    const next = (await hub.handle("alerts.check", {})) as { alerts: Record<string, unknown>[] };
    expect(next.alerts).toEqual([expect.objectContaining({ id: "switched", agent: "claude" })]);
  });

  it("does not act for Claude bound to another relay or with unknown quota", async () => {
    const { hub, calls, claude } = await service();
    claude.usage.aaaaaaaaaaaa = undefined;
    await hub.handle("agents.autoSwitch.set", {
      agent: "claude",
      enabled: true,
      acceptRisk: true,
      ...settings,
    });
    expect(((await hub.handle("alerts.check", {})) as { alerts: unknown[] }).alerts).toEqual([]);
    await hub.handle("agents.relays.set", { claudeCode: "eeeeeeeeeeee" });
    claude.usage.aaaaaaaaaaaa = claudeUsage(99, 99);
    expect(((await hub.handle("alerts.check", {})) as { alerts: unknown[] }).alerts).toEqual([]);
    expect(calls.some((c) => c.startsWith("claude/switch"))).toBe(false);
  });
});
