import type { HarnessAdapter } from "./text-session.js";
import type { HarnessSessionUsageCapability } from "./session-usage.js";
export type {
  HarnessSessionUsageCapability,
  HarnessSessionUsageHistory,
  HarnessSessionUsageObservation,
} from "./session-usage.js";
import type { HarnessUsageStatisticsCapability } from "./usage-statistics.js";

/** A capability-only plugin: no session inspection, creation or native process ownership. */
export interface HarnessUsageStatisticsAdapter {
  readonly harnessId: HarnessAdapter["harnessId"];
  readonly usageStatistics: HarnessUsageStatisticsCapability;
  readonly sessionUsage?: HarnessSessionUsageCapability;
  close(): Promise<void>;
}

export interface HarnessUsageStatisticsPluginModule {
  createUsageStatisticsAdapter(
    context: HarnessPluginContext,
  ): HarnessUsageStatisticsAdapter | Promise<HarnessUsageStatisticsAdapter>;
}

export interface HarnessLocalPage {
  show(): Promise<void>;
  close(): Promise<void>;
}

/** Native MCP options stay in process configuration, never in model-visible context. */
export type SharedMcpServer =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http"; url: string; headers: Record<string, string> };
export interface SharedHarnessResources {
  readonly mcpServers: Record<string, SharedMcpServer>;
  readonly context: string;
}
/** Codex resources a Harness can actually consume through its native interface. */
export interface SharedResourceRequest {
  /** The requesting Harness, so the Host can report what each Agent received. */
  readonly harnessId?: string;
  /** Native MCP attachment (process configuration, never model context). */
  readonly mcp?: boolean;
  /** Skill index in model context; the Agent reads SKILL.md files itself. */
  readonly skills?: boolean;
  /** Project-scoped Codex memory and general preferences in model context. */
  readonly memory?: boolean;
}
/**
 * Without a request the Host materializes every enabled kind (older plugins). The Host still
 * applies the person's sharing settings: a kind turned off is never returned.
 */
export type SharedResourcesProvider = (
  cwd: string,
  request?: SharedResourceRequest,
) => Promise<SharedHarnessResources>;

/** Per Host/connection construction context; never contains Host or Renderer internals. */
export interface HarnessPluginContext {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Persisted installation directory or legacy entrypoint; only for plugins declaring launchCommand. */
  readonly launchCommand?: string;
  readonly platform: string;
  readonly managedRemoteHost: boolean;
  readonly brokerDescriptorPath?: string;
  readonly openLocalUrl?: (url: string) => Promise<void>;
  /** Opens a background page in the local Desktop browser; owner must close it. */
  readonly openLocalPage?: (url: string) => Promise<HarnessLocalPage>;
  readonly sharedResources?: SharedResourcesProvider;
}

/** A loaded module supplies a factory, not a global registration side effect. */
export interface HarnessPluginModule {
  createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter | Promise<HarnessAdapter>;
  /** Optional, best-effort prefetch. The Host does not await completion before serving requests. */
  warmup?(adapter: HarnessAdapter): Promise<void>;
}
