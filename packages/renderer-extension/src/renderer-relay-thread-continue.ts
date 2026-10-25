import {
  hostThreadIdSchema,
  RLY0_THREAD_PROVIDER_LOCKED_CODE,
  type HostThreadId,
  type ThreadHandoffParams,
  type ThreadHandoffResult,
} from "@codexhost/shared-contracts";

import { applyRendererPopoverChrome } from "./renderer-usage-control.js";

/**
 * "在新对话里继续（带上之前的内容）" for a Codex Thread whose chosen model needs another provider
 * than the one Codex loaded it on (official account vs. relay). Codex cannot switch a loaded
 * Thread's provider, so the Host refuses the turn with `RLY0_THREAD_PROVIDER_LOCKED`; this offers
 * one click that continues in a new Codex Thread through the existing Handoff, carrying the
 * conversation and the unsent message.
 */

type TurnStartSender = (params: unknown, send: (params: unknown) => unknown) => unknown;

const FOLLOW_UP_MAX_LENGTH = 20_000;
export const RELAY_THREAD_CONTINUE_LABEL = "在新对话里继续（带上之前的内容）";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    if (typeof error.message === "string") return error.message;
    if (isRecord(error.error) && typeof error.error.message === "string")
      return error.error.message;
  }
  return error instanceof Error ? error.message : "";
}

/** Whether a rejected `turn/start` is the Host's provider-lock refusal. */
export function isThreadProviderLockedError(error: unknown): boolean {
  return errorText(error).includes(RLY0_THREAD_PROVIDER_LOCKED_CODE);
}

/** The person's message text without the trailing marker meant for code. */
export function threadProviderLockedReason(error: unknown): string {
  return errorText(error).replace(`(${RLY0_THREAD_PROVIDER_LOCKED_CODE})`, "").trim();
}

/** The text of a `turn/start`, sent again as the new conversation's request. */
export function turnStartFollowUp(params: unknown): string | undefined {
  if (!isRecord(params) || !Array.isArray(params.input)) return undefined;
  const text = params.input
    .flatMap((item) =>
      isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n")
    .trim();
  return text ? text.slice(0, FOLLOW_UP_MAX_LENGTH) : undefined;
}

export interface RelayThreadContinueOffer {
  threadId: HostThreadId;
  reason: string;
  /** Starts the handoff and opens the new Thread. */
  continue(): Promise<void>;
}

export interface RelayThreadContinueDeps {
  handoff(input: ThreadHandoffParams): Promise<ThreadHandoffResult>;
  open(threadId: HostThreadId): Promise<void>;
  /** Presents the offer; the default is a small notice with one button. */
  show(offer: RelayThreadContinueOffer): void;
  requestId?: () => string;
}

function newRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Wraps the outgoing `turn/start` sender: a provider-lock refusal still rejects as before (Desktop
 * keeps the draft and shows its own error), and additionally offers the one-click continuation.
 */
export function withRelayThreadContinue(
  inner: TurnStartSender | undefined,
  deps: RelayThreadContinueDeps,
): TurnStartSender {
  return (params, send) => {
    const result = inner ? inner(params, send) : send(params);
    if (!isRecord(result) || typeof result.then !== "function") return result;
    return (result as unknown as Promise<unknown>).then(undefined, (error: unknown) => {
      const threadId = hostThreadIdSchema.safeParse(isRecord(params) ? params.threadId : null);
      if (threadId.success && isThreadProviderLockedError(error)) {
        const followUp = turnStartFollowUp(params);
        const requestId = (deps.requestId ?? newRequestId)();
        try {
          deps.show({
            threadId: threadId.data,
            reason: threadProviderLockedReason(error),
            continue: async () => {
              const created = await deps.handoff({
                threadId: threadId.data,
                targetHarnessId: "codex" as ThreadHandoffParams["targetHarnessId"],
                requestId,
                ...(followUp ? { followUp } : {}),
              });
              await deps.open(created.threadId);
            },
          });
        } catch {
          // The offer is an addition; the original rejection still reaches Desktop.
        }
      }
      throw error;
    });
  };
}

/** A fixed notice above the Composer area with the reason and one button. */
export function showRelayThreadContinueNotice(offer: RelayThreadContinueOffer): void {
  const document = globalThis.document;
  if (!document?.body) return;
  document.querySelector("[data-codexhost-relay-thread-continue]")?.remove();
  const notice = document.createElement("div");
  notice.dataset.codexhostRelayThreadContinue = "true";
  notice.setAttribute("role", "alert");
  notice.style.cssText =
    "position:fixed;left:50%;bottom:120px;transform:translateX(-50%);box-sizing:border-box;width:min(560px,calc(100vw - 32px));padding:12px 14px;font:13px/1.5 system-ui,sans-serif;z-index:2147483647;display:flex;flex-direction:column;gap:10px";
  applyRendererPopoverChrome(notice);
  const message = document.createElement("div");
  message.textContent = offer.reason;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = RELAY_THREAD_CONTINUE_LABEL;
  go.style.fontWeight = "600";
  for (const button of [close, go]) {
    button.style.cssText +=
      ";padding:5px 12px;border-radius:8px;border:1px solid color-mix(in srgb, CanvasText 18%, transparent);background:transparent;color:inherit;font:inherit;cursor:pointer";
  }
  close.addEventListener("click", () => notice.remove());
  go.addEventListener("click", () => {
    go.disabled = true;
    go.textContent = "正在新建对话…";
    offer.continue().then(
      () => notice.remove(),
      (error: unknown) => {
        go.disabled = false;
        go.textContent = RELAY_THREAD_CONTINUE_LABEL;
        message.textContent = `没能在新对话里继续：${errorText(error) || "请稍后再试"}`;
      },
    );
  });
  row.append(close, go);
  notice.append(message, row);
  document.body.append(notice);
}
