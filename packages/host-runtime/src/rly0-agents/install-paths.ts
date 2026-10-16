import path from "node:path";

import { withClaudeCodeInstallPaths } from "./claude-code-auth.js";

/** Common installer destinations, re-evaluated after every prerequisite install. */
export function withAgentInstallPaths(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const next = withClaudeCodeInstallPaths(environment, platform);
  if (platform !== "win32") return next;
  const extra = [
    path.win32.join(environment.ProgramFiles ?? "C:\\Program Files", "nodejs"),
    path.win32.join(environment.ProgramFiles ?? "C:\\Program Files", "Git", "cmd"),
    environment["ProgramFiles(x86)"]
      ? path.win32.join(environment["ProgramFiles(x86)"], "nodejs")
      : "",
    environment.LOCALAPPDATA ? path.win32.join(environment.LOCALAPPDATA, "Programs", "nodejs") : "",
    environment.LOCALAPPDATA
      ? path.win32.join(environment.LOCALAPPDATA, "Microsoft", "WindowsApps")
      : "",
    environment.NVM_SYMLINK ?? "",
  ];
  next.PATH = [next.PATH, ...extra].filter(Boolean).join(";");
  return next;
}
