import { readSandboxSettings } from "@codexhost/sandbox-runtime";
import type { SharedResourcesInspectResult } from "@codexhost/shared-contracts";

import { rly0HubAgentSharing } from "./rly0-hub-service/agents.js";
import {
  lastSharedResourceDelivery,
  sharedResourceSettings,
  type SharedResourceSettings,
} from "./shared-harness-resources.js";

const NONE = { mcp: false, skills: false, memory: false };

/** One Agent's sharing status for the Hub page and the Composer's "共享自 Codex" line. */
export async function sharedResourceStatus(input: {
  environment: NodeJS.ProcessEnv;
  harnessId: string;
  cwd?: string;
  /** Remote Hosts never receive the local Codex's resources. */
  managedRemoteHost?: boolean;
  settings?: SharedResourceSettings;
}): Promise<SharedResourcesInspectResult> {
  const settings = input.settings ?? (await sharedResourceSettings(input.environment));
  if (input.harnessId === "codex" || input.managedRemoteHost) {
    return { applicable: false, settings, support: NONE, blocked: null, delivered: null };
  }
  const { mcp, skills, memory } = rly0HubAgentSharing(input.harnessId);
  const blocked =
    input.harnessId === "claude-code" && claudeIsolated(input.environment)
      ? "Claude 隔离模式开启时不共享"
      : null;
  const delivered = input.cwd ? lastSharedResourceDelivery(input.harnessId, input.cwd) : null;
  return {
    applicable: true,
    settings,
    support: { mcp, skills, memory },
    blocked,
    delivered: delivered
      ? {
          mcpServers: delivered.mcpServers.slice(0, 64),
          skills: delivered.skills,
          memory: delivered.memory,
        }
      : null,
  };
}

function claudeIsolated(environment: NodeJS.ProcessEnv): boolean {
  try {
    return readSandboxSettings(environment)?.enabled === true;
  } catch {
    return false;
  }
}
