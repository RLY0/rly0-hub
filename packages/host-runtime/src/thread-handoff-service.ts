import type { StoredDelegationRecordV1 } from "@codexhost/mapping-store";
import type { JsonObject, RoutedHarnessId } from "@codexhost/protocol-core";
import type { ThreadHandoffParams, ThreadHandoffResult } from "@codexhost/shared-contracts";

import {
  DelegationControlError,
  type DelegationStartInput,
  type DelegationStartResult,
  type ThreadSendInput,
  type ThreadSendResult,
} from "./delegation-types.js";
import {
  buildHandoffSeed,
  HANDOFF_REQUEST_PREFIX,
  handoffTitle,
  sourceThreadTitle,
} from "./thread-handoff.js";

function isUserMessage(item: unknown): boolean {
  return typeof item === "object" && item !== null && "type" in item && item.type === "userMessage";
}

export interface ThreadHandoffDeps {
  source(threadId: string): Promise<{
    harnessId: RoutedHarnessId;
    thread: JsonObject;
    turns: JsonObject[];
    cwd?: string;
  }>;
  start(input: DelegationStartInput): Promise<DelegationStartResult>;
  send(input: ThreadSendInput): Promise<ThreadSendResult>;
  delegationByChild(threadId: string): Promise<StoredDelegationRecordV1 | null>;
  /** Display name of a Harness ("Claude Code"); falls back to the ID. */
  label(harnessId: string): string;
}

/**
 * Continues a conversation with another Harness. A Thread never changes Harness, so this
 * creates a linked Thread seeded with the source transcript. Going back to the Harness a
 * handoff came from sends only the new turns to the original Thread instead of a third copy.
 */
export async function runThreadHandoff(
  deps: ThreadHandoffDeps,
  params: ThreadHandoffParams,
): Promise<ThreadHandoffResult> {
  const source = await deps.source(params.threadId);
  if (source.harnessId === params.targetHarnessId) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "This conversation already uses the selected Agent",
    );
  }
  const sourceLabel = deps.label(source.harnessId);
  const targetLabel = deps.label(params.targetHarnessId);
  const title = sourceThreadTitle(source.thread);
  const link = await deps.delegationByChild(params.threadId);
  if (
    link?.requestId?.startsWith(HANDOFF_REQUEST_PREFIX) &&
    link.sourceHarnessId === params.targetHarnessId
  ) {
    // The first message of a handoff Thread is the transcript the origin already has; the
    // reply to it stays (with a draft as follow-up it may hold real work).
    const [first, ...later] = source.turns;
    const firstReply =
      first && Array.isArray(first.items)
        ? { ...first, items: first.items.filter((item) => !isUserMessage(item)) }
        : null;
    const seed = buildHandoffSeed({
      turns: firstReply ? [firstReply, ...later] : later,
      sourceLabel,
      targetLabel,
      sourceTitle: title,
      returning: true,
      ...(source.cwd ? { cwd: source.cwd } : {}),
      ...(params.followUp ? { followUp: params.followUp } : {}),
    });
    // Only the acknowledgement of the hand-over is not worth a new turn in the origin.
    if (later.length > 0 || params.followUp?.trim()) {
      await deps.send({ threadId: link.parentHostThreadId, message: seed.text });
    }
    return {
      threadId: link.parentHostThreadId as ThreadHandoffResult["threadId"],
      mode: "returned",
      title: null,
      carried: seed.carried,
    };
  }
  const seed = buildHandoffSeed({
    turns: source.turns,
    sourceLabel,
    targetLabel,
    sourceTitle: title,
    ...(source.cwd ? { cwd: source.cwd } : {}),
    ...(params.followUp ? { followUp: params.followUp } : {}),
  });
  const newTitle = handoffTitle(title, targetLabel);
  const started = await deps.start({
    harnessId: params.targetHarnessId as RoutedHarnessId,
    task: seed.text,
    parentThreadId: params.threadId,
    requestId: `${HANDOFF_REQUEST_PREFIX}${params.requestId}`,
    ...(source.cwd ? { cwd: source.cwd } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.thinkingOptionId ? { thinkingOptionId: params.thinkingOptionId } : {}),
    handoff: {
      title: newTitle,
      ...(params.permissionModeId ? { permissionModeId: params.permissionModeId } : {}),
    },
  });
  return {
    threadId: started.threadId as ThreadHandoffResult["threadId"],
    mode: "created",
    title: newTitle,
    carried: seed.carried,
  };
}
