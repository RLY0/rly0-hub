import { z } from "zod";

import { rly0CoreStatusResultSchema } from "./rly0-core.js";

/**
 * Contracts for the "维护工具" (maintenance) settings page: read-only diagnostics, a sanitized
 * local diagnostics export, cache housekeeping for this program's own `~/.rly0-hub` state, and
 * (best-effort, injectable) Codex process control. Nothing here ever reads `auth.json` content,
 * and the export result never includes raw file content either.
 */

export const RLY0_MAINTENANCE_DIAGNOSTICS_METHOD = "codexhost/rly0/maintenance/diagnostics";
export const RLY0_MAINTENANCE_EXPORT_DIAGNOSTICS_METHOD =
  "codexhost/rly0/maintenance/exportDiagnostics";
export const RLY0_MAINTENANCE_CACHE_INFO_METHOD = "codexhost/rly0/maintenance/cacheInfo";
export const RLY0_MAINTENANCE_CLEAR_CACHE_METHOD = "codexhost/rly0/maintenance/clearCache";
export const RLY0_MAINTENANCE_FORCE_QUIT_CODEX_METHOD = "codexhost/rly0/maintenance/forceQuitCodex";
export const RLY0_MAINTENANCE_RESTART_CODEX_METHOD = "codexhost/rly0/maintenance/restartCodex";
/**
 * Hot-reloads the official app-server behind the Desktop window so a switched account or a
 * changed relay provider takes effect without closing Codex. Never touches the Desktop process.
 */
export const RLY0_CODEX_RELOAD_BACKEND_METHOD = "codexhost/rly0/codex/reloadBackend";

/** Machine-readable advice codes; the renderer owns the localized copy for each. */
export const rly0MaintenanceAdviceCodeSchema = z.enum([
  "CODEX_HOME_MISSING",
  "AUTH_JSON_MISSING",
  "CONFIG_TOML_MISSING",
  "CONFIG_TOML_INVALID",
  "SESSIONS_DIR_MISSING",
  "CORE_UNAVAILABLE",
]);
export type Rly0MaintenanceAdviceCode = z.infer<typeof rly0MaintenanceAdviceCodeSchema>;

export const rly0MaintenanceDiagnosticsParamsSchema = z.object({}).strict();
export type Rly0MaintenanceDiagnosticsParams = z.infer<
  typeof rly0MaintenanceDiagnosticsParamsSchema
>;

export const rly0MaintenanceDiagnosticsResultSchema = z
  .object({
    generatedAt: z.string().max(64),
    codexHome: z.string().max(4096),
    codexHomeExists: z.boolean(),
    authJsonExists: z.boolean(),
    configTomlExists: z.boolean(),
    /** `null` when config.toml does not exist. */
    configTomlParses: z.boolean().nullable(),
    sessionsDirExists: z.boolean(),
    core: rly0CoreStatusResultSchema,
    advice: z.array(rly0MaintenanceAdviceCodeSchema).max(16),
  })
  .strict();
export type Rly0MaintenanceDiagnosticsResult = z.infer<
  typeof rly0MaintenanceDiagnosticsResultSchema
>;

export const rly0MaintenanceExportDiagnosticsParamsSchema = z.object({}).strict();
export type Rly0MaintenanceExportDiagnosticsParams = z.infer<
  typeof rly0MaintenanceExportDiagnosticsParamsSchema
>;

export const rly0MaintenanceExportDiagnosticsResultSchema = z
  .object({
    filePath: z.string().max(4096),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type Rly0MaintenanceExportDiagnosticsResult = z.infer<
  typeof rly0MaintenanceExportDiagnosticsResultSchema
>;

export const rly0MaintenanceCacheInfoParamsSchema = z.object({}).strict();
export type Rly0MaintenanceCacheInfoParams = z.infer<typeof rly0MaintenanceCacheInfoParamsSchema>;

export const rly0MaintenanceCacheEntrySchema = z
  .object({
    /** Stable, short identifier such as `"cache"` or `"tmp"`; never a raw filesystem path. */
    name: z.string().max(64),
    exists: z.boolean(),
    sizeBytes: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
  })
  .strict();
export type Rly0MaintenanceCacheEntry = z.infer<typeof rly0MaintenanceCacheEntrySchema>;

export const rly0MaintenanceCacheInfoResultSchema = z
  .object({
    entries: z.array(rly0MaintenanceCacheEntrySchema).max(16),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
export type Rly0MaintenanceCacheInfoResult = z.infer<typeof rly0MaintenanceCacheInfoResultSchema>;

export const rly0MaintenanceClearCacheParamsSchema = z.object({}).strict();
export type Rly0MaintenanceClearCacheParams = z.infer<typeof rly0MaintenanceClearCacheParamsSchema>;

export const rly0MaintenanceClearCacheResultSchema = z
  .object({
    clearedBytes: z.number().int().nonnegative(),
    clearedEntries: z.array(z.string().max(64)).max(16),
  })
  .strict();
export type Rly0MaintenanceClearCacheResult = z.infer<typeof rly0MaintenanceClearCacheResultSchema>;

export const rly0MaintenanceProcessActionParamsSchema = z.object({}).strict();
export type Rly0MaintenanceProcessActionParams = z.infer<
  typeof rly0MaintenanceProcessActionParamsSchema
>;

/** `supported: false` means no process-control capability is wired up on this Host. */
export const rly0MaintenanceProcessActionResultSchema = z.discriminatedUnion("supported", [
  z.object({ supported: z.literal(false) }).strict(),
  z.object({ supported: z.literal(true), ok: z.boolean() }).strict(),
]);
export type Rly0MaintenanceProcessActionResult = z.infer<
  typeof rly0MaintenanceProcessActionResultSchema
>;

export const rly0CodexReloadBackendParamsSchema = z.object({}).strict();
export type Rly0CodexReloadBackendParams = z.infer<typeof rly0CodexReloadBackendParamsSchema>;

/**
 * `reloaded`: the new backend is already serving requests. `deferred`: a turn is running; the
 * reload happens automatically once all work finishes. `failed`: the reload did not complete
 * (restarting Codex manually still works).
 */
export const rly0CodexReloadBackendResultSchema = z
  .object({ status: z.enum(["reloaded", "deferred", "failed"]) })
  .strict();
export type Rly0CodexReloadBackendResult = z.infer<typeof rly0CodexReloadBackendResultSchema>;
