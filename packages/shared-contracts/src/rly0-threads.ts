import { z } from "zod";

/**
 * Contracts for the thread (Codex session) manager page. It lists
 * `${CODEX_HOME:-~/.codex}/sessions/**\/rollout-*.jsonl` files and moves them to/from
 * `~/.rly0-hub/threads-trash/` (same relative layout). Nothing here ever deletes a session file.
 * Only a short header of each file is read (session_meta + first user message) — never the whole
 * transcript.
 */

export const RLY0_THREADS_LIST_METHOD = "codexhost/rly0/threads/list";
export const RLY0_THREADS_LIST_TRASH_METHOD = "codexhost/rly0/threads/listTrash";
export const RLY0_THREADS_TRASH_METHOD = "codexhost/rly0/threads/trash";
export const RLY0_THREADS_RESTORE_METHOD = "codexhost/rly0/threads/restore";

/** Upper bound on how many thread rows a single list call returns. */
export const RLY0_THREADS_LIST_MAX = 500;
/** Titles are the first user message, cut to this many characters. */
export const RLY0_THREADS_TITLE_MAX_LENGTH = 80;

/**
 * A session file path relative to the sessions (or trash) root, always `/`-separated, e.g.
 * `2026/09/30/rollout-2026-09-30T10-00-00-<uuid>.jsonl`. The host re-validates every path with a
 * resolve + separator-aligned prefix check; this schema is the first, coarse gate.
 */
export const rly0ThreadRelPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(?:[A-Za-z0-9._-]+\/){0,8}rollout-[^/\\\0]+\.jsonl$/u)
  .refine((value) => !value.split("/").some((segment) => segment === ".." || segment === "."), {
    message: "Path segments must not be '.' or '..'",
  });
export type Rly0ThreadRelPath = z.infer<typeof rly0ThreadRelPathSchema>;

export const rly0ThreadStatsSchema = z
  .object({
    totalThreads: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    /** Distinct local calendar days with at least one session (by file mtime). */
    activeDays: z.number().int().nonnegative(),
    /** `totalThreads / activeDays`, `0` when there are no active days. */
    averagePerActiveDay: z.number().nonnegative(),
  })
  .strict();
export type Rly0ThreadStats = z.infer<typeof rly0ThreadStatsSchema>;

export const rly0ThreadEntrySchema = z
  .object({
    relPath: rly0ThreadRelPathSchema,
    fileName: z.string().max(512),
    /** First user message (≤ 80 chars) or the file name when none could be read. */
    title: z.string().max(512),
    titleFromMessage: z.boolean(),
    /** Project directory from the `session_meta` line; absent when unknown. */
    cwd: z.string().max(4096).optional(),
    /** Session start time from `session_meta`, ISO 8601; absent when unknown. */
    startedAt: z.string().max(64).optional(),
    mtimeMs: z.number().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type Rly0ThreadEntry = z.infer<typeof rly0ThreadEntrySchema>;

export const rly0ThreadsListParamsSchema = z
  .object({ limit: z.number().int().min(1).max(RLY0_THREADS_LIST_MAX).optional() })
  .strict();
export type Rly0ThreadsListParams = z.infer<typeof rly0ThreadsListParamsSchema>;

export const rly0ThreadsListResultSchema = z
  .object({
    sessionsRoot: z.string().max(4096),
    rootExists: z.boolean(),
    stats: rly0ThreadStatsSchema,
    /** Newest first, at most `limit` (default and cap: 500) entries. */
    threads: z.array(rly0ThreadEntrySchema).max(RLY0_THREADS_LIST_MAX),
    truncated: z.boolean(),
  })
  .strict();
export type Rly0ThreadsListResult = z.infer<typeof rly0ThreadsListResultSchema>;

export const rly0ThreadsListTrashParamsSchema = z.object({}).strict();
export type Rly0ThreadsListTrashParams = z.infer<typeof rly0ThreadsListTrashParamsSchema>;

export const rly0ThreadsListTrashResultSchema = z
  .object({
    trashRoot: z.string().max(4096),
    totalCount: z.number().int().nonnegative(),
    threads: z.array(rly0ThreadEntrySchema).max(RLY0_THREADS_LIST_MAX),
    truncated: z.boolean(),
  })
  .strict();
export type Rly0ThreadsListTrashResult = z.infer<typeof rly0ThreadsListTrashResultSchema>;

export const rly0ThreadsMoveParamsSchema = z
  .object({ relPaths: z.array(rly0ThreadRelPathSchema).min(1).max(RLY0_THREADS_LIST_MAX) })
  .strict();
export type Rly0ThreadsMoveParams = z.infer<typeof rly0ThreadsMoveParamsSchema>;

export const rly0ThreadMoveFailureCodeSchema = z.enum([
  "THREAD_NOT_FOUND",
  "THREAD_ALREADY_EXISTS",
  "THREAD_MOVE_FAILED",
]);
export type Rly0ThreadMoveFailureCode = z.infer<typeof rly0ThreadMoveFailureCodeSchema>;

export const rly0ThreadsMoveResultSchema = z
  .object({
    movedCount: z.number().int().nonnegative(),
    failed: z
      .array(
        z
          .object({ relPath: rly0ThreadRelPathSchema, code: rly0ThreadMoveFailureCodeSchema })
          .strict(),
      )
      .max(RLY0_THREADS_LIST_MAX),
  })
  .strict();
export type Rly0ThreadsMoveResult = z.infer<typeof rly0ThreadsMoveResultSchema>;
