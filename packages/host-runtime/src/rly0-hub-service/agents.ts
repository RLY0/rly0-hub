import { RLY0_AGENT_RECIPES } from "../rly0-agents/agent-installer.js";
import { commandExists, withClaudeCodeInstallPaths } from "../rly0-agents/claude-code-auth.js";

/** Display order and names for the Hub's "AI 助手" page; ids match the installer recipes. */
export const RLY0_HUB_AGENTS: readonly { readonly id: string; readonly name: string }[] = [
  { id: "claude-code", name: "Claude Code" },
  { id: "kimi-code", name: "Kimi Code" },
  { id: "qoder-cn", name: "Qoder 国内版" },
  { id: "codebuddy", name: "CodeBuddy" },
  { id: "deepseek-harness", name: "DeepSeek" },
  { id: "opencode", name: "OpenCode" },
  { id: "cursor-cli", name: "Cursor" },
  { id: "qoder", name: "Qoder" },
  { id: "antigravity", name: "Antigravity" },
  { id: "grok", name: "Grok" },
  { id: "kiro-cli", name: "Kiro" },
  { id: "hermes", name: "Hermes" },
  { id: "pi", name: "Pi" },
  { id: "omp", name: "Oh My Pi" },
  { id: "workbuddy", name: "WorkBuddy" },
];

export interface Rly0HubAgent {
  readonly id: string;
  readonly name: string;
  /** Its command is on PATH (or in a folder its own installer uses). Unknown for desktop apps. */
  readonly installed: boolean | null;
  readonly automatic: boolean;
  readonly canOpenLogin: boolean;
}

export function listRly0HubAgents(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fileExists?: (file: string) => boolean,
): Rly0HubAgent[] {
  const searchEnvironment = withClaudeCodeInstallPaths(environment, platform);
  return RLY0_HUB_AGENTS.flatMap(({ id, name }) => {
    const recipe = RLY0_AGENT_RECIPES[id];
    if (!recipe) return [];
    const command = recipe.loginCommand;
    return [
      {
        id,
        name,
        installed: command ? commandExists(command, searchEnvironment, platform, fileExists) : null,
        automatic: recipe.attempts.length > 0,
        canOpenLogin: Boolean(command),
      },
    ];
  });
}
