import { existsSync } from "node:fs";
import path from "node:path";

import { RLY0_AGENT_RECIPES } from "../rly0-agents/agent-installer.js";
import { commandExists } from "../rly0-agents/claude-code-auth.js";
import { withAgentInstallPaths } from "../rly0-agents/install-paths.js";

/**
 * The Hub's "AI 助手" catalog. Two kinds, shown separately:
 * - official: the coding agent a model vendor ships for its own models;
 * - community: third-party agents (open source first, then closed source).
 * Rarely used agents (built around domestic models, desktop-only, forks) are listed too, in the
 * page's collapsed "更多" group (`more`), with the same install and connection status.
 */
export type Rly0HubAgentCategory = "official" | "community";
/** How an agent can use a relay: automatically per session, by hand-copied config, or not at all. */
export type Rly0HubAgentRelaySupport = "auto" | "manual" | "none";
/**
 * How an agent receives each shared kind (shared-harness-resources.ts and its adapter):
 * - `native`: through its own interface for this process (MCP config, skill registration);
 * - `context`: as reference text in front of the prompt (skills index, read-only memory digest);
 * - `global`: only through the agent's global config file, which the Hub changes only when the
 *   person turns on its managed block for that agent (off by default);
 * - `none`: not reachable; `note` says why.
 * The booleans say whether the adapter asks the Host for that kind; they must match its requests.
 */
export type Rly0ShareMode = "native" | "context" | "global" | "none";
export interface Rly0HubAgentSharing {
  readonly mcp: boolean;
  readonly skills: boolean;
  readonly memory: boolean;
  readonly modes: { readonly mcp: Rly0ShareMode; readonly skills: Rly0ShareMode; readonly memory: Rly0ShareMode };
  /** Why something is not shared or needs the opt-in global block, in the Hub's words. */
  readonly note?: string;
}
const sharing = (
  mcp: Rly0ShareMode,
  skills: Rly0ShareMode,
  memory: Rly0ShareMode,
  note?: string,
): Rly0HubAgentSharing => ({
  mcp: mcp === "native",
  skills: skills === "native" || skills === "context",
  memory: memory !== "none",
  modes: { mcp, skills, memory },
  ...(note ? { note } : {}),
});
const ACP_SHARING = sharing("native", "context", "native");
const NO_SHARING = sharing("none", "none", "none", "接入方式没有可挂载 MCP 或附加上下文的入口");

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
  /** Shown in the collapsed "更多" group. */
  readonly more?: true;
  /**
   * Its plugin takes an installation folder (`launchCommand` in the manifest): desktop apps the
   * Host may not find on its own. Set in the Hub with `agents.launchPathSet`.
   */
  readonly launchPath?: true;
}

export const RLY0_HUB_AGENTS: readonly CatalogEntry[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    category: "official",
    openSource: false,
    relay: "auto",
    sharing: sharing("native", "context", "native", "开启 Claude 隔离模式时不共享"),
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    vendor: "Google",
    category: "official",
    openSource: false,
    relay: "none",
    sharing: sharing(
      "global",
      "context",
      "context",
      "agy 只读取全局 ~/.gemini/config/mcp_config.json，需在打通设置里单独开启",
    ),
    docsUrl: "https://antigravity.google",
  },
  {
    id: "grok",
    name: "Grok",
    vendor: "xAI",
    category: "official",
    openSource: false,
    relay: "manual",
    sharing: ACP_SHARING,
    docsUrl: "https://x.ai",
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "OpenCode",
    category: "community",
    openSource: true,
    relay: "auto",
    sharing: ACP_SHARING,
    docsUrl: "https://opencode.ai/docs",
  },
  {
    id: "pi",
    name: "Pi",
    vendor: "Pi",
    category: "community",
    openSource: true,
    relay: "auto",
    sharing: sharing("native", "native", "native"),
    docsUrl: "https://pi.dev",
  },
  {
    id: "hermes",
    name: "Hermes",
    vendor: "Nous Research",
    category: "community",
    openSource: true,
    relay: "auto",
    sharing: sharing(
      "global",
      "native",
      "context",
      "Hermes 只从全局 ~/.hermes/config.yaml 读取 MCP，需在打通设置里单独开启",
    ),
    docsUrl: "https://hermes-agent.nousresearch.com",
  },
  {
    id: "cursor-cli",
    name: "Cursor",
    vendor: "Cursor",
    category: "community",
    openSource: false,
    relay: "none",
    sharing: ACP_SHARING,
    docsUrl: "https://cursor.com/cli",
  },
  {
    id: "kiro-cli",
    name: "Kiro",
    vendor: "AWS",
    category: "community",
    openSource: false,
    relay: "none",
    sharing: ACP_SHARING,
    docsUrl: "https://kiro.dev",
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    vendor: "Moonshot AI",
    category: "official",
    openSource: false,
    relay: "none",
    sharing: ACP_SHARING,
    docsUrl: "https://code.kimi.com/kimi-code",
    more: true,
  },
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    vendor: "DeepSeek",
    category: "official",
    openSource: false,
    relay: "none",
    sharing: sharing("none", "none", "none", "DeepSeek 接入没有 MCP 或附加上下文的入口"),
    docsUrl: "https://www.npmjs.com/package/@deepseek-ai/dsh",
    more: true,
  },
  {
    id: "zcode",
    name: "ZCode",
    vendor: "Z.ai",
    category: "official",
    openSource: false,
    relay: "none",
    sharing: sharing("none", "none", "none", "ZCode 桌面接入没有 MCP 或附加上下文的入口"),
    docsUrl: "https://zcode.z.ai",
    more: true,
    launchPath: true,
  },
  {
    id: "omp",
    name: "Oh My Pi",
    vendor: "Oh My Pi",
    category: "community",
    openSource: true,
    relay: "none",
    sharing: sharing("none", "none", "none", "OMP 的 MCP / 技能参数未核实，暂不接入"),
    docsUrl: "https://omp.sh",
    more: true,
  },
  {
    id: "qoder",
    name: "Qoder",
    vendor: "Qoder",
    category: "community",
    openSource: false,
    relay: "none",
    sharing: sharing("none", "none", "none", "Qoder SDK 接入的 MCP 参数未核实，暂不接入"),
    docsUrl: "https://qoder.com",
    more: true,
  },
  {
    id: "qoder-cn",
    name: "Qoder CN",
    vendor: "Qoder",
    category: "community",
    openSource: false,
    relay: "none",
    sharing: sharing("none", "none", "none", "Qoder SDK 接入的 MCP 参数未核实，暂不接入"),
    docsUrl: "https://qoder.com.cn",
    more: true,
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    vendor: "Tencent",
    category: "community",
    openSource: false,
    relay: "none",
    sharing: ACP_SHARING,
    docsUrl: "https://www.npmjs.com/package/@tencent-ai/codebuddy-code",
    more: true,
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    vendor: "Tencent",
    category: "community",
    openSource: false,
    relay: "none",
    sharing: ACP_SHARING,
    docsUrl:
      "https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Win-Guide",
    more: true,
    launchPath: true,
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    vendor: "GitHub",
    category: "community",
    openSource: false,
    relay: "none",
    sharing: sharing("none", "none", "none", "Copilot SDK 接入的 MCP / 技能参数未核实，暂不接入"),
    docsUrl:
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    more: true,
  },
];

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
  /** Listed in the collapsed "更多" group. */
  readonly more?: true;
  /** Accepts a custom installation folder (`agents.launchPathGet` / `agents.launchPathSet`). */
  readonly launchPath?: true;
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

/** Agents whose installation folder can be set in the Hub (the former 连接 page's 应用路径). */
export function rly0HubAgentTakesLaunchPath(agent: string): boolean {
  return RLY0_HUB_AGENTS.some((entry) => entry.id === agent && entry.launchPath === true);
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
    // Desktop-app agents without a recipe (ZCode) are listed for their connection status only.
    const recipe = RLY0_AGENT_RECIPES[entry.id] ?? { attempts: [] };
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
        ...(entry.more ? { more: true as const } : {}),
        ...(entry.launchPath ? { launchPath: true as const } : {}),
      },
    ];
  });
}
