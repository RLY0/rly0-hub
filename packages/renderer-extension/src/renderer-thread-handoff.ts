import {
  harnessIdSchema,
  hostThreadIdSchema,
  type HostThreadId,
  type ThreadHandoffParams,
  type ThreadHandoffResult,
} from "@codexhost/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import {
  newThreadPermissionModeDefault,
  readHubAgentDefaults,
  withHubModelDefaults,
  type AgentDefaultsStorage,
} from "./renderer-agent-defaults.js";
import {
  readNewThreadExternalConfigurationPreference,
  rendererNewThreadPreferenceStorage,
} from "./renderer-new-thread-preference.js";

/**
 * Composer "换个助手接着聊". A Thread's Agent is fixed once it starts (each Harness owns its
 * Native Session), so picking another Agent on a started Thread asks the Host for a handoff:
 * a new linked Thread on that Agent whose first message carries this conversation over.
 * The target starts like a new Thread of that Agent would: the Hub's new-Thread defaults first,
 * then the person's remembered Model / Thinking / permission, then the Agent's own default.
 */
export interface RendererThreadHandoffInput {
  client: Pick<RendererModelClient, "handoffThread" | "inspectHarness">;
  threadId: string;
  hostId: string | null;
  agent: RendererAgent;
  open(threadId: HostThreadId): Promise<void>;
  requestId?: string;
  storage?: Parameters<typeof readNewThreadExternalConfigurationPreference>[3];
  agentDefaultsStorage?: AgentDefaultsStorage | null;
}

export function rendererHandoffSupported(
  client: Pick<RendererModelClient, "handoffThread"> | null | undefined,
): boolean {
  return typeof client?.handoffThread === "function";
}

function newRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function rememberedConfiguration(
  input: RendererThreadHandoffInput,
): Promise<Pick<ThreadHandoffParams, "model" | "thinkingOptionId" | "permissionModeId">> {
  if (input.agent === "codex") return {};
  try {
    const inspection = await input.client.inspectHarness({
      harnessId: harnessIdSchema.parse(input.agent),
    });
    if (inspection.status !== "ready") return {};
    const hub =
      input.agentDefaultsStorage === undefined
        ? readHubAgentDefaults(input.agent, input.hostId)
        : readHubAgentDefaults(input.agent, input.hostId, input.agentDefaultsStorage);
    const remembered =
      withHubModelDefaults(
        inspection.catalog,
        hub,
        readNewThreadExternalConfigurationPreference(
          input.agent,
          inspection.catalog,
          inspection.permissionModes,
          input.storage === undefined
            ? rendererNewThreadPreferenceStorage(input.hostId)
            : input.storage,
        ),
      ) ?? {};
    const permissionModeId = newThreadPermissionModeDefault(
      input.agent,
      input.hostId,
      inspection.permissionModes,
      hub,
    );
    return permissionModeId ? { ...remembered, permissionModeId } : remembered;
  } catch {
    // The Agent's own default is still a valid start; the Host validates the rest.
    return {};
  }
}

export async function startRendererThreadHandoff(
  input: RendererThreadHandoffInput,
): Promise<ThreadHandoffResult> {
  const handoff = input.client.handoffThread;
  if (!handoff) throw new Error("This Host cannot continue a conversation with another Agent");
  const configuration = await rememberedConfiguration(input);
  const result = await handoff.call(input.client, {
    threadId: hostThreadIdSchema.parse(input.threadId),
    targetHarnessId: harnessIdSchema.parse(input.agent),
    requestId: input.requestId ?? newRequestId(),
    ...configuration,
  });
  await input.open(result.threadId);
  return result;
}
