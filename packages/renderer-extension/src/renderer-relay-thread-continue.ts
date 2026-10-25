import {
  hostThreadIdSchema,
  RLY0_THREAD_CONTINUED_CODE,
  RLY0_THREAD_CONTINUED_NOTE,
  RLY0_THREAD_PROVIDER_LOCKED_CODE,
  type HostThreadId,
} from "@codexhost/shared-contracts";

import { applyRendererPopoverChrome } from "./renderer-usage-control.js";

/**
 * A Codex Thread whose chosen model needs another provider than the one Codex loaded it on
 * (official account vs. relay or config.toml provider). Codex cannot switch a loaded Thread's
 * provider, so the Host forks it onto the right provider with its whole history and sends the
 * message there; its `turn/start` reply carries `RLY0_THREAD_CONTINUED:<new thread id>`. This
 * opens that Thread and shows a small note — no choice to make. When even the fork failed, the
 * Host's reason (`RLY0_THREAD_PROVIDER_LOCKED`) is shown the same way.
 */

type TurnStartSender = (params: unknown, send: (params: unknown) => unknown) => unknown;

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

/** The Thread a `turn/start` was continued in, from the Host's reply. */
export function threadContinuedTarget(error: unknown): HostThreadId | undefined {
  const match = new RegExp(`${RLY0_THREAD_CONTINUED_CODE}:([^\\s)]+)`, "u").exec(errorText(error));
  const parsed = hostThreadIdSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : undefined;
}

export interface RelayThreadContinueDeps {
  open(threadId: HostThreadId): Promise<void>;
  /** A small note that does not block anything; the default fades by itself. */
  note(text: string): void;
}

/**
 * Wraps the outgoing `turn/start` sender. The Host's reply still reaches Desktop as it came (the
 * original conversation is kept unchanged); a continued turn additionally opens the new Thread.
 */
export function withRelayThreadContinue(
  inner: TurnStartSender | undefined,
  deps: RelayThreadContinueDeps,
): TurnStartSender {
  return (params, send) => {
    const result = inner ? inner(params, send) : send(params);
    if (!isRecord(result) || typeof result.then !== "function") return result;
    return (result as unknown as Promise<unknown>).then(undefined, (error: unknown) => {
      try {
        const target = threadContinuedTarget(error);
        if (target) {
          void deps.open(target).then(
            () => deps.note(RLY0_THREAD_CONTINUED_NOTE),
            () => deps.note(`${RLY0_THREAD_CONTINUED_NOTE}，请在左侧列表里打开它`),
          );
        } else if (isThreadProviderLockedError(error)) {
          deps.note(threadProviderLockedReason(error));
        }
      } catch {
        // The note is an addition; the original reply still reaches Desktop.
      }
      throw error;
    });
  };
}

/** A small note near the Composer that fades after a few seconds. */
export function showRelayThreadNote(text: string): void {
  const document = globalThis.document;
  if (!document?.body) return;
  document.querySelector("[data-codexhost-relay-thread-note]")?.remove();
  const note = document.createElement("div");
  note.dataset.codexhostRelayThreadNote = "true";
  note.setAttribute("role", "status");
  note.textContent = text;
  note.style.cssText =
    "position:fixed;left:50%;bottom:120px;transform:translateX(-50%);box-sizing:border-box;max-width:min(560px,calc(100vw - 32px));padding:8px 14px;font:13px/1.5 system-ui,sans-serif;z-index:2147483647;pointer-events:none";
  applyRendererPopoverChrome(note);
  document.body.append(note);
  setTimeout(() => note.remove(), 6_000);
}
