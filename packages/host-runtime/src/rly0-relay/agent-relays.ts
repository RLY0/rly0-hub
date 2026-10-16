import { promises as fs } from "node:fs";
import path from "node:path";

import { rly0RelayIdSchema } from "@codexhost/shared-contracts";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

export const RLY0_AGENT_RELAYS_FILE_NAME = "agent-relays.json";
/** Claude Code reads its endpoint and token from these; the token is a local placeholder. */
export const CLAUDE_CODE_RELAY_TOKEN = "rly0-local-proxy";

export interface Rly0AgentRelaySelection {
  /** Relay that drives Claude Code, or null for Claude Code's own login. */
  readonly claudeCode: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Which relay, if any, drives each native agent. Stored in RLY/0 Hub's own data directory. */
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
      const claudeCode = isRecord(value) ? value.claudeCode : null;
      return {
        claudeCode:
          typeof claudeCode === "string" && rly0RelayIdSchema.safeParse(claudeCode).success
            ? claudeCode
            : null,
      };
    } catch {
      return { claudeCode: null };
    }
  }

  async set(selection: Rly0AgentRelaySelection): Promise<Rly0AgentRelaySelection> {
    const file = this.path();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify({ version: 1, claudeCode: selection.claudeCode }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.rename(temporary, file);
    return selection;
  }
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
