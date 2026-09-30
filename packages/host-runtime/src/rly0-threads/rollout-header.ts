import { promises as fs } from "node:fs";

import { RLY0_THREADS_TITLE_MAX_LENGTH } from "@codexhost/shared-contracts";

/** Only this many bytes from the start of a rollout file are ever read. */
export const ROLLOUT_HEADER_MAX_BYTES = 64 * 1024;

export interface RolloutHeader {
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly firstUserMessage?: string;
  /** Bytes actually read from disk; always ≤ the `maxBytes` cap. */
  readonly bytesRead: number;
}

/** Context blocks Codex injects as `role: "user"` items before the person's first real prompt. */
const INJECTED_USER_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<permissions instructions>",
  "# AGENTS.md instructions",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanRolloutTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("\0", "").replaceAll(/\s+/gu, " ").trim();
  if (!normalized) return null;
  if (INJECTED_USER_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return null;
  const characters = [...normalized];
  if (characters.length <= RLY0_THREADS_TITLE_MAX_LENGTH) return normalized;
  return `${characters
    .slice(0, RLY0_THREADS_TITLE_MAX_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter(
      (block) =>
        isRecord(block) &&
        (block.type === "input_text" || block.type === "text") &&
        typeof block.text === "string",
    )
    .map((block) => String((block as { text: string }).text));
  return parts.length > 0 ? parts.join(" ") : null;
}

function userMessageFromRecord(record: Record<string, unknown>): string | null {
  const payload = isRecord(record.payload) ? record.payload : null;
  if (record.type === "event_msg" && payload?.type === "user_message") {
    return cleanRolloutTitle(payload.message);
  }
  if (record.type === "response_item" && payload?.type === "message" && payload.role === "user") {
    return cleanRolloutTitle(contentText(payload.content));
  }
  // Legacy (pre-`type` envelope) rollouts stored response items at the top level.
  if (record.type === "message" && record.role === "user") {
    return cleanRolloutTitle(contentText(record.content));
  }
  return null;
}

/**
 * Reads at most `maxBytes` from the start of a Codex rollout file and extracts the `session_meta`
 * fields (cwd, start time) and the first real user message. The file is never loaded whole: a
 * single bounded `read()` into a fixed-size buffer is all the I/O done here. Corrupt or partial
 * lines are skipped, like Codex's own history reader.
 */
export async function readRolloutHeader(
  filePath: string,
  maxBytes: number = ROLLOUT_HEADER_MAX_BYTES,
): Promise<RolloutHeader> {
  const cap = Math.max(1, Math.min(maxBytes, ROLLOUT_HEADER_MAX_BYTES));
  const buffer = Buffer.alloc(cap);
  const handle = await fs.open(filePath, "r");
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, cap, 0));
  } finally {
    await handle.close();
  }
  const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
  // A full buffer almost certainly ends mid-line; that fragment is not valid JSON anyway.
  if (bytesRead === cap) lines.pop();

  let cwd: string | undefined;
  let startedAt: string | undefined;
  let firstUserMessage: string | undefined;
  let sawMeta = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (!sawMeta) {
      const payload = isRecord(record.payload) ? record.payload : null;
      const legacyMeta =
        index === 0 && record.type === undefined && typeof record.id === "string" ? record : null;
      const meta = record.type === "session_meta" && payload ? payload : legacyMeta;
      if (meta) {
        sawMeta = true;
        if (typeof meta.cwd === "string" && meta.cwd.trim()) cwd = meta.cwd;
        const timestamp =
          typeof meta.timestamp === "string"
            ? meta.timestamp
            : typeof record.timestamp === "string"
              ? record.timestamp
              : undefined;
        if (timestamp && !Number.isNaN(Date.parse(timestamp))) startedAt = timestamp;
        continue;
      }
    }
    if (!firstUserMessage) {
      const message = userMessageFromRecord(record);
      if (message) firstUserMessage = message;
    }
    if (sawMeta && firstUserMessage) break;
  }
  return {
    ...(cwd ? { cwd } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(firstUserMessage ? { firstUserMessage } : {}),
    bytesRead,
  };
}
