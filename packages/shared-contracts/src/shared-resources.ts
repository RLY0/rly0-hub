import { z } from "zod";

import { hostThreadIdSchema } from "./ids.js";

/** Which Codex MCP servers / skills / memory an external Agent Thread receives. */
export const SHARED_RESOURCES_INSPECT_METHOD = "codexhost/thread/shared-resources/inspect";

const kindsSchema = z
  .object({ mcp: z.boolean(), skills: z.boolean(), memory: z.boolean() })
  .strict();
export type SharedResourceKinds = z.infer<typeof kindsSchema>;
export const sharedResourceKindsSchema = kindsSchema;

export const sharedResourcesInspectParamsSchema = z
  .object({ threadId: hostThreadIdSchema })
  .strict();
export type SharedResourcesInspectParams = z.infer<typeof sharedResourcesInspectParamsSchema>;

export const sharedResourcesInspectResultSchema = z
  .object({
    /** Not an external Agent Thread, or a Host that does not share (remote). */
    applicable: z.boolean(),
    /** The person's settings in RLY/0 Hub. */
    settings: kindsSchema,
    /** What this Agent's integration can consume. */
    support: kindsSchema,
    /** A reason nothing is shared even though settings allow it (e.g. Claude isolation). */
    blocked: z.string().max(200).nullable(),
    /** What this Agent last received for this project in the running Host, if known. */
    delivered: z
      .object({
        mcpServers: z.array(z.string().max(120)).max(64),
        skills: z.number().int().nonnegative(),
        memory: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SharedResourcesInspectResult = z.infer<typeof sharedResourcesInspectResultSchema>;
