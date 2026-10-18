import { promises as fs } from "node:fs";
import path from "node:path";

import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { rly0RelayIdSchema } from "@codexhost/shared-contracts";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

export const RLY0_AGENT_RELAYS_FILE_NAME = "agent-relays.json";
/** Claude Code reads its endpoint and token from these; the token is a local placeholder. */
export const CLAUDE_CODE_RELAY_TOKEN = "rly0-local-proxy";

/** Third-party agents RLY/0 Hub can route through a relay by itself. */
export const RLY0_RELAY_AGENTS = ["pi", "hermes", "opencode"] as const;
export type Rly0RelayAgentId = (typeof RLY0_RELAY_AGENTS)[number];

export interface Rly0AgentRelayChoice {
  readonly relayId: string;
  /** Default model the agent starts with; null lets the agent pick. */
  readonly model: string | null;
}

export interface Rly0AgentRelaySelection {
  /** Relay that drives Claude Code, or null for Claude Code's own login. */
  readonly claudeCode: string | null;
  /** Relay (and default model) for each third-party agent; absent = the agent's own setup. */
  readonly agents?: Partial<Record<Rly0RelayAgentId, Rly0AgentRelayChoice>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;

function cleanChoice(value: unknown): Rly0AgentRelayChoice | undefined {
  if (!isRecord(value)) return undefined;
  const { relayId, model } = value;
  if (typeof relayId !== "string" || !rly0RelayIdSchema.safeParse(relayId).success)
    return undefined;
  return {
    relayId,
    model: typeof model === "string" && MODEL_PATTERN.test(model) ? model : null,
  };
}

/** Which relay, if any, drives each agent. Stored in RLY/0 Hub's own data directory. */
export class Rly0AgentRelaySettings {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: { readonly environment: NodeJS.ProcessEnv }) {
    this.#environment = options.environment;
  }

  path(): string {
    return path.join(resolveRly0DataDir(this.#environment), RLY0_AGENT_RELAYS_FILE_NAME);
  }

  async get(): Promise<Rly0AgentRelaySelection> {
    try {
      const value = JSON.parse(await fs.readFile(this.path(), "utf8")) as unknown;
      const record = isRecord(value) ? value : {};
      const claudeCode = record.claudeCode;
      const agents: Partial<Record<Rly0RelayAgentId, Rly0AgentRelayChoice>> = {};
      const savedAgents = isRecord(record.agents) ? record.agents : {};
      for (const id of RLY0_RELAY_AGENTS) {
        const choice = cleanChoice(savedAgents[id]);
        if (choice) agents[id] = choice;
      }
      return {
        claudeCode:
          typeof claudeCode === "string" && rly0RelayIdSchema.safeParse(claudeCode).success
            ? claudeCode
            : null,
        agents,
      };
    } catch {
      return { claudeCode: null, agents: {} };
    }
  }

  /** Saves Claude Code's relay; third-party choices are kept unless given. */
  async set(selection: Rly0AgentRelaySelection): Promise<Rly0AgentRelaySelection> {
    const current = await this.get();
    const next: Rly0AgentRelaySelection = {
      claudeCode: selection.claudeCode,
      agents: selection.agents ?? current.agents ?? {},
    };
    await this.#write(next);
    return next;
  }

  /** Routes one third-party agent through a relay, or back to its own setup (null). */
  async setAgent(
    id: Rly0RelayAgentId,
    choice: Rly0AgentRelayChoice | null,
  ): Promise<Rly0AgentRelaySelection> {
    const current = await this.get();
    const agents = { ...(current.agents ?? {}) };
    if (choice) agents[id] = choice;
    else delete agents[id];
    const next = { claudeCode: current.claudeCode, agents };
    await this.#write(next);
    return next;
  }

  async #write(selection: Rly0AgentRelaySelection): Promise<void> {
    const file = this.path();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify({ version: 2, claudeCode: selection.claudeCode, agents: selection.agents ?? {} }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.rename(temporary, file);
  }
}

/** The relay as the local proxy serves it to one agent: `<proxy>/r/<relay id>/v1`. */
export function pinnedRelayUrl(proxyBaseUrl: string, relayId: string): string {
  return `${proxyBaseUrl.replace(/\/v1\/?$/u, "")}/r/${relayId}/v1`;
}

/**
 * Hermes through a relay: an OpenAI-compatible custom endpoint at the local proxy. The person's
 * own config.yaml would win over these, so it is bypassed for relay sessions
 * (HERMES_IGNORE_USER_CONFIG); their .env credentials still load.
 */
export function hermesRelayEnvironment(
  base: NodeJS.ProcessEnv,
  url: string,
  model: string | null,
  models: readonly string[] = [],
  relayName = "RLY/0",
): NodeJS.ProcessEnv {
  return {
    ...base,
    HERMES_IGNORE_USER_CONFIG: "1",
    HERMES_INFERENCE_PROVIDER: "custom",
    HERMES_TUI_PROVIDER: "custom",
    CUSTOM_BASE_URL: url,
    OPENAI_BASE_URL: url,
    OPENAI_API_KEY: CLAUDE_CODE_RELAY_TOKEN,
    ...(model ? { HERMES_MODEL: model } : {}),
    // The relay's models become Hermes' model list in Codex (see the Hermes adapter).
    RLY0_HERMES_MODELS: JSON.stringify(models.filter((m) => !m.endsWith("*")).slice(0, 200)),
    RLY0_HERMES_RELAY_NAME: relayName,
  };
}

/** OpenCode through a relay: an inline config with one OpenAI-compatible provider. */
export function opencodeRelayEnvironment(
  base: NodeJS.ProcessEnv,
  url: string,
  models: readonly string[],
  model: string | null,
): NodeJS.ProcessEnv {
  const listed = models.filter((m) => !m.endsWith("*")).slice(0, 200);
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      rly0: {
        npm: "@ai-sdk/openai-compatible",
        name: "RLY/0 Hub",
        options: { baseURL: url, apiKey: CLAUDE_CODE_RELAY_TOKEN },
        models: Object.fromEntries(listed.map((m) => [m, { name: m }])),
      },
    },
    ...(model ? { model: `rly0/${model}` } : {}),
  };
  return { ...base, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

/** Pi's private extension that registers the relay as the `rly0` provider. */
export function piRelayExtension(
  url: string,
  models: readonly string[],
  relayName = "RLY/0",
): string {
  const listed = models.filter((m) => !m.endsWith("*")).slice(0, 200);
  const provider = {
    baseUrl: url,
    api: "openai-completions",
    apiKey: "$RLY0_RELAY_TOKEN",
    models: listed.map((id) => ({
      id,
      name: `${relayName} / ${id}`,
      api: "openai-completions",
      baseUrl: url,
      reasoning: /^(?:gpt-5|o[134]|claude|gemini-(?:2\.5|3)|grok-4)/iu.test(id),
      // Pi reads these for every model (e.g. `input.includes("image")`); leaving them out crashes it.
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    })),
  };
  return [
    "// Written by RLY/0 Hub: routes Pi through the relay chosen in the Hub.",
    "export default function (pi) {",
    `  pi.registerProvider("rly0", ${JSON.stringify(provider, null, 2).replaceAll("\n", "\n  ")});`,
    "}",
    "",
  ].join("\n");
}

export function piRelayEnvironment(
  base: NodeJS.ProcessEnv,
  extensionFile: string,
  model: string | null,
): NodeJS.ProcessEnv {
  return {
    ...base,
    RLY0_PI_EXTENSION: extensionFile,
    RLY0_RELAY_TOKEN: CLAUDE_CODE_RELAY_TOKEN,
    ...(model ? { RLY0_PI_MODEL: model } : {}),
  };
}

/**
 * The environment Claude Code runs with when it is driven by a relay: Anthropic requests go to
 * RLY/0 Hub's local proxy under `/r/<relay id>`, which adds the relay key itself. Claude Code
 * never sees the key, and any Anthropic key of the person's own is removed so it cannot leak to
 * the relay or win over the relay.
 */
export function claudeCodeRelayEnvironment(
  base: NodeJS.ProcessEnv,
  proxyBaseUrl: string,
  relayId: string,
): NodeJS.ProcessEnv {
  const root = proxyBaseUrl.replace(/\/v1\/?$/u, "");
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") continue;
    if (key === "ANTHROPIC_BASE_URL") continue;
    environment[key] = value;
  }
  environment.ANTHROPIC_BASE_URL = `${root}/r/${relayId}`;
  environment.ANTHROPIC_AUTH_TOKEN = CLAUDE_CODE_RELAY_TOKEN;
  return environment;
}

/**
 * The Host hands every session its own environment (`open({ environment })`), which replaces the
 * one the adapter was loaded with. This wrapper applies `transform` to that per-session
 * environment, so a relay chosen for an agent also reaches new, resumed, forked and rolled-back
 * sessions. Everything else passes straight through to the adapter.
 */
export function withSessionEnvironment(
  adapter: HarnessAdapter,
  transform: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv,
): HarnessAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "open") {
        return (input: Parameters<HarnessAdapter["open"]>[0]) =>
          target.open(
            input.environment ? { ...input, environment: transform(input.environment) } : input,
          );
      }
      // Read with the adapter itself as receiver: getters may use its private fields.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
