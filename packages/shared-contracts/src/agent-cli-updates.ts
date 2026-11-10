import { z } from "zod";

export const agentCliUpdateIdSchema = z.enum([
  "grok",
  "opencode",
  "pi",
  "hermes",
  "cursor-cli",
  "kiro-cli",
  "kimi-code",
  "antigravity",
  "deepseek-harness",
  "omp",
  "qoder",
  "qoder-cn",
  "codebuddy",
  "copilot",
  "devin",
  "qwen-code",
]);
export type AgentCliUpdateId = z.infer<typeof agentCliUpdateIdSchema>;
export const agentCliUpdateErrorSchema = z.enum([
  "CHECK_FAILED",
  "INSTALL_FAILED",
  "VERSION_MISMATCH",
  "CONNECTION_NOT_READY",
  "ROLLBACK_FAILED",
  "HOST_UNAVAILABLE",
  "BUSY",
  "BAD_VERSION",
  "NOT_INSTALLED",
  "ORIGINAL_INSTALLER",
  "NO_OFFICIAL_UPDATER",
  "ROLLBACK_UNSUPPORTED",
  "STATE_INVALID",
  "STATE_WRITE_FAILED",
  "INTERRUPTED",
  "DISABLED",
  "PERMISSION_DENIED",
]);
export type AgentCliUpdateError = z.infer<typeof agentCliUpdateErrorSchema>;
export const agentCliUpdateResultSchema = z.enum([
  "updated",
  "rolled-back",
  "skipped-busy",
  "failed",
  "up-to-date",
  "skipped-disabled",
  "skipped-not-installed",
  "skipped-unsupported",
  "skipped-bad-version",
]);
export const agentCliUpdateEntrySchema = z.strictObject({
  agent: agentCliUpdateIdSchema,
  currentVersion: z.string().max(128).nullable(),
  latestVersion: z.string().max(128).nullable(),
  lastCheckedAt: z.number().int().nonnegative().nullable(),
  lastUpdatedAt: z.number().int().nonnegative().nullable(),
  phase: z.enum(["idle", "checking", "updating", "verifying", "rolling-back"]),
  result: agentCliUpdateResultSchema.nullable(),
  errorCode: agentCliUpdateErrorSchema.nullable(),
  causeCode: agentCliUpdateErrorSchema.nullable(),
  badVersions: z.array(z.string().max(128)),
  installKind: z.enum(["npm", "script", "unknown"]),
  canUpdate: z.boolean(),
});
export type AgentCliUpdateEntry = z.infer<typeof agentCliUpdateEntrySchema>;
export const agentCliUpdateStatusSchema = z.strictObject({
  enabled: z.boolean(),
  checking: z.boolean(),
  intervalMs: z.number().int().positive(),
  agents: z.array(agentCliUpdateEntrySchema),
});
export type AgentCliUpdateStatus = z.infer<typeof agentCliUpdateStatusSchema>;
export const agentCliUpdateSetParamsSchema = z.strictObject({ enabled: z.boolean() });
export const agentCliUpdateCheckParamsSchema = z.strictObject({
  agent: agentCliUpdateIdSchema.optional(),
});
export const AGENT_CLI_BUSY_METHOD = "codexhost/harness/cli-update-busy";
export const agentCliBusyParamsSchema = z.strictObject({ agent: agentCliUpdateIdSchema });
export const agentCliBusyResultSchema = z.strictObject({
  busy: z.boolean(),
  guarded: z.literal(true),
});
