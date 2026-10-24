import { z } from "zod";

import {
  cleanAgentAutoSwitchSettings,
  RLY0_AGENT_AUTO_SWITCH_DEFAULTS,
  RLY0_AUTO_SWITCH_AGENTS,
  Rly0AgentAutoSwitcher,
  type Rly0AgentAutoSwitchDeps,
  type Rly0AgentAutoSwitchStore,
  type Rly0AutoSwitchAgent,
} from "./agent-auto-switch.js";
import type { Rly0HubStateStore } from "./hub-state.js";

const agentSchema = z.enum(RLY0_AUTO_SWITCH_AGENTS);

function coded(code: string): Error {
  return Object.assign(new Error(code), { code: -32000 });
}

function route<S extends z.ZodTypeAny>(
  schema: S,
  run: (params: z.infer<S>) => Promise<unknown> | unknown,
) {
  return async (raw: unknown): Promise<unknown> => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw Object.assign(new Error("INVALID_PARAMS"), { code: -32602 });
    return run(parsed.data);
  };
}

/** The Claude / Grok auto-switch settings, kept per agent in hub-desktop.json. */
export function agentAutoSwitchStore(state: Rly0HubStateStore): Rly0AgentAutoSwitchStore {
  return {
    settings: async (agent) =>
      cleanAgentAutoSwitchSettings(
        (await state.read()).agentAutoSwitch?.[agent] ?? RLY0_AGENT_AUTO_SWITCH_DEFAULTS,
      ),
    handled: async (agent) => (await state.read()).agentAutoSwitchHandled?.[agent],
    markHandled: async (agent, key) => {
      const current = (await state.read()).agentAutoSwitchHandled ?? {};
      await state.update({ agentAutoSwitchHandled: { ...current, [agent]: key } });
    },
    lastSwitchAt: async (agent) => (await state.read()).agentAutoSwitchAt?.[agent],
    markSwitched: async (agent, at) => {
      const current = (await state.read()).agentAutoSwitchAt ?? {};
      await state.update({ agentAutoSwitchAt: { ...current, [agent]: Math.round(at) } });
    },
  };
}

/**
 * `agents.autoSwitch.get/set/apply`. Turning one on needs `acceptRisk` once (the page's
 * confirmation); later it is remembered. Gemini has no entry: Antigravity cannot keep accounts.
 */
export function createAgentAutoSwitch(
  state: Rly0HubStateStore,
  deps: Omit<Rly0AgentAutoSwitchDeps, "store">,
) {
  const store = agentAutoSwitchStore(state);
  const switcher = new Rly0AgentAutoSwitcher({ ...deps, store });
  const read = (agent: Rly0AutoSwitchAgent) => store.settings(agent);
  const routes = {
    "agents.autoSwitch.get": route(z.object({ agent: agentSchema }).strict(), (p) => read(p.agent)),
    "agents.autoSwitch.set": route(
      z
        .object({
          agent: agentSchema,
          enabled: z.boolean(),
          remain5h: z.number().int().min(1).max(90),
          remainWeekly: z.number().int().min(1).max(90),
          mode: z.enum(["ask", "auto"]),
          /** The person confirmed the terms-of-service risk in the dialog just now. */
          acceptRisk: z.literal(true).optional(),
        })
        .strict(),
      async (p) => {
        const before = await read(p.agent);
        const riskAccepted = before.riskAccepted || p.acceptRisk === true;
        if (p.enabled && !riskAccepted) throw coded("AUTO_SWITCH_RISK_NOT_ACCEPTED");
        const settings = cleanAgentAutoSwitchSettings({
          enabled: p.enabled,
          remain5h: p.remain5h,
          remainWeekly: p.remainWeekly,
          mode: p.mode,
          riskAccepted,
        });
        const all = (await state.read()).agentAutoSwitch ?? {};
        await state.update({ agentAutoSwitch: { ...all, [p.agent]: settings } });
        return settings;
      },
    ),
    // The tray notice's one click: switch now, or right after the running reply.
    "agents.autoSwitch.apply": route(
      z.object({ agent: agentSchema, id: z.string().regex(/^[a-f0-9]{12}$/u) }).strict(),
      (p) => switcher.apply(p.agent, p.id),
    ),
  };
  return { switcher, routes };
}
