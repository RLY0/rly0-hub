import path from "node:path";

import {
  claudeCodeDiscoverySpec,
  resolveHarnessExecutable,
  targetPath,
  type HarnessDiscoveryDependencies,
} from "@codexhost/harness-discovery";

export { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";

export class ClaudeCodeExecutableError extends Error {
  readonly code = "CLAUDE_NOT_FOUND";
}

// Shared with the Hub CLI updater so both always select the same installation.
export { claudeCodeDiscoverySpec };

export function resolveClaudeCodeExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
  dependencies: HarnessDiscoveryDependencies = {},
): string {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(
    claudeCodeDiscoverySpec,
    {
      ...(input.command ? { command: input.command } : {}),
      environment: input.environment ?? process.env,
      ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
      platform,
    },
    dependencies,
  );
  if (!resolution) throw new ClaudeCodeExecutableError("Claude Code is not installed");
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}
