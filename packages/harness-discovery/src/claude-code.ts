import { targetPath } from "./environment.js";
import { VERSION_MANAGER_ROOTS, type HarnessDiscoverySpec } from "./resolve.js";

const CLAUDE_NPM_PACKAGE_BIN = "node_modules/@anthropic-ai/claude-code/bin";

/**
 * Where Claude Code is searched for. Shared by the Claude Code adapter (which launches it) and
 * the Hub CLI updater (which must update that same installation, never a different one).
 */
export const claudeCodeDiscoverySpec: HarnessDiscoverySpec = {
  id: "claude-code",
  command: "claude",
  commandEnvironmentVariable: "CODEXHOST_CLAUDE_COMMAND",
  installRoots: {
    posix: [
      "~/.npm-global/bin",
      "~/.local/bin",
      "~/.claude/local",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: [
      `\${APPDATA}/npm/${CLAUDE_NPM_PACKAGE_BIN}`,
      "${APPDATA}/npm",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
    ],
  },
  // Prefer Claude Code's native binary over the npm CMD shim beside it: the
  // shim spawns an extra cmd.exe and loses signal handling.
  runnableCandidate: (candidate, { platform, isExecutable }) => {
    const pathFlavor = targetPath(platform);
    if (platform !== "win32" || pathFlavor.basename(candidate).toLowerCase() !== "claude.cmd") {
      return candidate;
    }
    const native = pathFlavor.join(
      pathFlavor.dirname(candidate),
      ...CLAUDE_NPM_PACKAGE_BIN.split("/"),
      "claude.exe",
    );
    return isExecutable(native) ? native : undefined;
  },
};
