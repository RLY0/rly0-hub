import { existsSync } from "node:fs";
import path from "node:path";

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
/**
 * Which Codex resources the agent's adapter can consume (shared-harness-resources.ts):
 * `mcp` attaches Codex MCP servers natively; `skills` / `memory` reach the model as reference
 * context. Must match what each adapter requests from the shared resources provider.
 */
export interface Rly0HubAgentSharing {
  readonly mcp: boolean;
  readonly skills: boolean;
  readonly memory: boolean;
  /** Why something is not shared, in the Hub's words. */
  readonly note?: string;
}
const NO_SHARING: Rly0HubAgentSharing = {
  mcp: false,
  skills: false,
  memory: false,
  note: "接入方式暂不支持接收 Codex 的资源",
};

interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly category: Rly0HubAgentCategory;
  readonly openSource: boolean;
  readonly relay: Rly0HubAgentRelaySupport;
  readonly sharing: Rly0HubAgentSharing;
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
    sharing: { mcp: true, skills: true, memory: true, note: "开启 Claude 隔离模式时不共享" },
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    vendor: "Google",
    category: "official",
    openSource: false,
    relay: "none",
    sharing: { mcp: false, skills: true, memory: true, note: "Antigravity 命令行接入无法挂载 MCP" },
    docsUrl: "https://antigravity.google",
  },
  {
    id: "grok",
    name: "Grok",
    vendor: "xAI",
    category: "official",
    openSource: false,
    relay: "manual",
    sharing: { mcp: true, skills: true, memory: true },
    docsUrl: "https://x.ai",
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "OpenCode",
    category: "community",
    openSource: true,
    relay: "auto",
    sharing: NO_SHARING,
    docsUrl: "https://opencode.ai/docs",
  },
  {
    id: "pi",
    name: "Pi",
    vendor: "Pi",
    category: "community",
    openSource: true,
    relay: "auto",
    sharing: NO_SHARING,
    docsUrl: "https://pi.dev",
  },
  {
    id: "hermes",
    name: "Hermes",
    vendor: "Nous Research",
    category: "community",
    openSource: true,
    relay: "auto",
    sharing: NO_SHARING,
    docsUrl: "https://hermes-agent.nousresearch.com",
  },
  {
    id: "cursor-cli",
    name: "Cursor",
    vendor: "Cursor",
    category: "community",
    openSource: false,
    relay: "none",
    sharing: NO_SHARING,
    docsUrl: "https://cursor.com/cli",
  },
  {
    id: "kiro-cli",
    name: "Kiro",
    vendor: "AWS",
    category: "community",
    openSource: false,
    relay: "none",
    sharing: NO_SHARING,
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
  /**
   * Only the agent's desktop app is installed, not the command line tool Codex runs (Antigravity:
   * the IDE in `%LOCALAPPDATA%\Programs\Antigravity`, without `agy`).
   */
  readonly desktopOnly?: true;
}

/** Antigravity's desktop app (IDE) on Windows: its own `bin` holds `antigravity.cmd`, not `agy`. */
function antigravityDesktopInstalled(
  environment: NodeJS.ProcessEnv,
  fileExists: (file: string) => boolean,
): boolean {
  const local = environment.LOCALAPPDATA;
  if (!local) return false;
  const root = path.win32.join(local, "Programs", "Antigravity");
  return [
    path.win32.join(root, "bin", "antigravity.cmd"),
    path.win32.join(root, "Antigravity.exe"),
  ].some((file) => fileExists(file));
}

export function rly0HubAgentSharing(agent: string): Rly0HubAgentSharing {
  return RLY0_HUB_AGENTS.find((entry) => entry.id === agent)?.sharing ?? NO_SHARING;
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
    const installed = command
      ? commandExists(command, searchEnvironment, platform, fileExists)
      : null;
    const desktopOnly =
      entry.id === "antigravity" &&
      installed === false &&
      platform === "win32" &&
      antigravityDesktopInstalled(environment, fileExists ?? existsSync);
    return [
      {
        id: entry.id,
        name: entry.name,
        vendor: entry.vendor,
        category: entry.category,
        openSource: entry.openSource,
        relay: entry.relay,
        installed,
        automatic: recipe.attempts.length > 0,
        canOpenLogin: Boolean(recipe.loginCommand),
        ...(manual ? { manualCommand: manual } : {}),
        ...(desktopOnly ? { desktopOnly: true as const } : {}),
      },
    ];
  });
}
