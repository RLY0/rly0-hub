import { RLY0_AGENT_RECIPES } from "../rly0-agents/agent-installer.js";
import { commandExists } from "../rly0-agents/claude-code-auth.js";
import { withAgentInstallPaths } from "../rly0-agents/install-paths.js";

/**
 * The Hub's "AI 助手" catalog. Two kinds, shown separately:
 * - official: the coding agent a model vendor ships for its own models;
 * - community: third-party agents (open source first, then closed source).
 * Agents built around domestic models and duplicates are kept in the code but not listed.
 */
export type Rly0HubAgentCategory = "official" | "community";
/** How an agent can use a relay: automatically per session, by hand-copied config, or not at all. */
export type Rly0HubAgentRelaySupport = "auto" | "manual" | "none";

interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly category: Rly0HubAgentCategory;
  readonly openSource: boolean;
  readonly relay: Rly0HubAgentRelaySupport;
  /** Official page with install and sign-in instructions; opened only through `links.open`. */
  readonly docsUrl: string;
}

export const RLY0_HUB_AGENTS: readonly CatalogEntry[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    category: "official",
    openSource: false,
    relay: "auto",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    vendor: "Google",
    category: "official",
    openSource: false,
    relay: "none",
    docsUrl: "https://antigravity.google",
  },
  {
    id: "grok",
    name: "Grok",
    vendor: "xAI",
    category: "official",
    openSource: false,
    relay: "manual",
    docsUrl: "https://x.ai",
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "OpenCode",
    category: "community",
    openSource: true,
    relay: "auto",
    docsUrl: "https://opencode.ai/docs",
  },
  {
    id: "pi",
    name: "Pi",
    vendor: "Pi",
    category: "community",
    openSource: true,
    relay: "auto",
    docsUrl: "https://pi.dev",
  },
  {
    id: "hermes",
    name: "Hermes",
    vendor: "Nous Research",
    category: "community",
    openSource: true,
    relay: "auto",
    docsUrl: "https://hermes-agent.nousresearch.com",
  },
  {
    id: "cursor-cli",
    name: "Cursor",
    vendor: "Cursor",
    category: "community",
    openSource: false,
    relay: "none",
    docsUrl: "https://cursor.com/cli",
  },
  {
    id: "kiro-cli",
    name: "Kiro",
    vendor: "AWS",
    category: "community",
    openSource: false,
    relay: "none",
    docsUrl: "https://kiro.dev",
  },
];

/** Not listed in the Hub or in Codex's agent picker; their adapters stay for compatibility. */
export const RLY0_HUB_HIDDEN_AGENTS = [
  "kimi-code",
  "qoder",
  "qoder-cn",
  "codebuddy",
  "workbuddy",
  "deepseek-harness",
  "omp",
] as const;

export interface Rly0HubAgent {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly category: Rly0HubAgentCategory;
  readonly openSource: boolean;
  readonly relay: Rly0HubAgentRelaySupport;
  /** Its command is on PATH (or in a folder its own installer uses). */
  readonly installed: boolean | null;
  readonly automatic: boolean;
  readonly canOpenLogin: boolean;
  /** The command a person can run themselves when one-click install fails (Windows PowerShell). */
  readonly manualCommand?: string;
}

export function rly0HubAgentDocsUrl(agent: string): string | undefined {
  return RLY0_HUB_AGENTS.find((entry) => entry.id === agent)?.docsUrl;
}

function manualCommand(id: string): string | undefined {
  const attempt = RLY0_AGENT_RECIPES[id]?.attempts[0];
  if (!attempt) return undefined;
  return attempt.kind === "script" ? attempt.windows : `npm install -g ${attempt.packageName}`;
}

export function listRly0HubAgents(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fileExists?: (file: string) => boolean,
): Rly0HubAgent[] {
  const searchEnvironment = withAgentInstallPaths(environment, platform);
  return RLY0_HUB_AGENTS.flatMap((entry) => {
    const recipe = RLY0_AGENT_RECIPES[entry.id];
    if (!recipe) return [];
    const command = recipe.detectionCommand;
    const manual = manualCommand(entry.id);
    return [
      {
        id: entry.id,
        name: entry.name,
        vendor: entry.vendor,
        category: entry.category,
        openSource: entry.openSource,
        relay: entry.relay,
        installed: command ? commandExists(command, searchEnvironment, platform, fileExists) : null,
        automatic: recipe.attempts.length > 0,
        canOpenLogin: Boolean(recipe.loginCommand),
        ...(manual ? { manualCommand: manual } : {}),
      },
    ];
  });
}
