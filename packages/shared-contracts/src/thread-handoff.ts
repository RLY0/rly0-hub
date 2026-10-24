import { z } from "zod";

import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "./harness-models.js";
import { harnessPermissionModeIdSchema } from "./harness-permission-modes.js";
import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";

/** Continue a Thread's conversation with another Harness (a new linked Thread). */
export const THREAD_HANDOFF_METHOD = "codexhost/thread/handoff";

export const threadHandoffParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    targetHarnessId: harnessIdSchema,
    /** Idempotency key for one click; a retry returns the same Thread. */
    requestId: z.string().min(8).max(128),
    model: harnessModelRefSchema.optional(),
    thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    permissionModeId: harnessPermissionModeIdSchema.optional(),
    /** The person's unsent draft, sent as the new request instead of a plain hand-over. */
    followUp: z.string().max(20_000).optional(),
  })
  .strict();
export type ThreadHandoffParams = z.infer<typeof threadHandoffParamsSchema>;

export const threadHandoffResultSchema = z
  .object({
    threadId: hostThreadIdSchema,
    /** `created`: a new Thread; `returned`: the new turns went back to the original Thread. */
    mode: z.enum(["created", "returned"]),
    title: z.string().max(200).nullable(),
    carried: z
      .object({
        turns: z.number().int().nonnegative(),
        includedTurns: z.number().int().nonnegative(),
        omittedTurns: z.number().int().nonnegative(),
        commands: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ThreadHandoffResult = z.infer<typeof threadHandoffResultSchema>;
