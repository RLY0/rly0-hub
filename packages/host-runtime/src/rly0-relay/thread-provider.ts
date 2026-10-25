import {
  RLY0_RELAY_MODEL_ID_PREFIX,
  RLY0_THREAD_PROVIDER_LOCKED_CODE,
} from "@codexhost/shared-contracts";

/**
 * Which provider a Codex Thread runs on, as far as relay models are concerned.
 *
 * Codex app-server fixes a Thread's provider when the Thread is loaded (`thread/start`, or a
 * `thread/resume` of a Thread that is not running): `turn/start` and `thread/settings/update` can
 * change the model but never the provider, and a resume of a running Thread ignores every
 * override. A resume naming a model or provider replaces the Thread's stored pair entirely; one
 * naming neither keeps the stored pair. So a relay model has to be paired with the `rly0` provider
 * at resume time, and a Thread already loaded on another provider cannot switch in place.
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Codex's built-in provider for the signed-in ChatGPT / OpenAI account. */
export const OFFICIAL_CODEX_PROVIDER_ID = "openai";

/**
 * The model a `turn/start` names: a collaboration mode's model takes precedence over `model`
 * (Codex app-server semantics; Desktop sends `model: null` with the mode). `undefined` when the
 * request leaves the Thread's model unchanged.
 */
export function turnRequestModel(params: JsonRecord): string | undefined {
  const mode = isRecord(params.collaborationMode) ? params.collaborationMode : null;
  const settings = mode && isRecord(mode.settings) ? mode.settings : null;
  if (settings && typeof settings.model === "string" && settings.model) return settings.model;
  return typeof params.model === "string" && params.model ? params.model : undefined;
}

/** `turn/start` params naming `model` everywhere the request named one. */
export function withTurnRequestModel(params: JsonRecord, model: string): JsonRecord {
  const mode = isRecord(params.collaborationMode) ? params.collaborationMode : null;
  const settings = mode && isRecord(mode.settings) ? mode.settings : null;
  const next: JsonRecord = { ...params };
  if (mode && settings && typeof settings.model === "string" && settings.model) {
    next.collaborationMode = { ...mode, settings: { ...settings, model } };
  }
  if (typeof params.model === "string" && params.model) next.model = model;
  if (next.collaborationMode === params.collaborationMode && next.model === params.model) {
    next.model = model;
  }
  return next;
}

export function isRelaySelector(model: unknown): model is string {
  return typeof model === "string" && model.startsWith(RLY0_RELAY_MODEL_ID_PREFIX);
}

/** What `thread/read` tells about a stored Thread. */
export interface StoredThreadRoute {
  readonly provider?: string;
  readonly model?: string;
  /** Codex's `thread.status.type`: `notLoaded`, `idle`, `active`, ... */
  readonly status?: string;
}

/** Parses a `thread/read` (or any Thread-carrying) response. */
export function storedThreadRoute(response: unknown): StoredThreadRoute | undefined {
  if (!isRecord(response) || !isRecord(response.result)) return undefined;
  const thread = isRecord(response.result.thread) ? response.result.thread : null;
  if (!thread) return undefined;
  const status = isRecord(thread.status) ? thread.status.type : thread.status;
  return {
    ...(typeof thread.modelProvider === "string" && thread.modelProvider
      ? { provider: thread.modelProvider }
      : {}),
    ...(typeof thread.model === "string" && thread.model ? { model: thread.model } : {}),
    ...(typeof status === "string" ? { status } : {}),
  };
}

/**
 * Error for a `turn/start` whose model needs another provider than the one the Thread is loaded
 * on. The trailing code lets the Renderer offer "在新对话里继续（带上之前的内容）".
 */
export function threadProviderLockedMessage(toRelay: boolean): string {
  return toRelay
    ? `这个对话是用官方账号开始的，Codex 不能在同一个对话里改用中转模型（否则会报 “model is not supported when using Codex with a ChatGPT account”）。点“在新对话里继续（带上之前的内容）”就能用中转模型接着聊。 (${RLY0_THREAD_PROVIDER_LOCKED_CODE})`
    : `这个对话正在走零号中转，Codex 不能在同一个对话里改回官方模型。点“在新对话里继续（带上之前的内容）”就能用官方模型接着聊，或重新选择带站点名的中转模型。 (${RLY0_THREAD_PROVIDER_LOCKED_CODE})`;
}
