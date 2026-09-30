import { z } from "zod";

/**
 * Contracts for the Skills manager page. It reads `SKILL.md` front matter under
 * `${CODEX_HOME:-~/.codex}/skills/` and can move skill directories to (and restore them from) a
 * backup folder under `~/.rly0-hub/skills-backup/`. Deletion is never permanent from this page —
 * "deactivate" only moves a skill to the backup folder.
 */

export const RLY0_SKILLS_LIST_METHOD = "codexhost/rly0/skills/list";
export const RLY0_SKILLS_DEACTIVATE_METHOD = "codexhost/rly0/skills/deactivate";
export const RLY0_SKILLS_RESTORE_METHOD = "codexhost/rly0/skills/restore";
export const RLY0_SKILLS_IMPORT_METHOD = "codexhost/rly0/skills/import";

/** Skill directory names are used as path segments, so the character set rules out traversal. */
export const rly0SkillNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u);
export type Rly0SkillName = z.infer<typeof rly0SkillNameSchema>;

/** Backup directory names (`<name>-<timestamp>`); same narrow character set as skill names. */
export const rly0SkillBackupIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,140}$/u);
export type Rly0SkillBackupId = z.infer<typeof rly0SkillBackupIdSchema>;

export const rly0SkillEntrySchema = z
  .object({
    name: rly0SkillNameSchema,
    title: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
  })
  .strict();
export type Rly0SkillEntry = z.infer<typeof rly0SkillEntrySchema>;

export const rly0SkillBackupEntrySchema = z
  .object({
    backupId: rly0SkillBackupIdSchema,
    name: rly0SkillNameSchema,
    title: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    backedUpAt: z.string().max(64).optional(),
  })
  .strict();
export type Rly0SkillBackupEntry = z.infer<typeof rly0SkillBackupEntrySchema>;

export const rly0SkillsListParamsSchema = z.object({}).strict();
export type Rly0SkillsListParams = z.infer<typeof rly0SkillsListParamsSchema>;

export const rly0SkillsListResultSchema = z
  .object({
    skillsRoot: z.string().max(4096),
    rootExists: z.boolean(),
    installedCount: z.number().int().nonnegative(),
    installed: z.array(rly0SkillEntrySchema).max(512),
    backups: z.array(rly0SkillBackupEntrySchema).max(512),
  })
  .strict();
export type Rly0SkillsListResult = z.infer<typeof rly0SkillsListResultSchema>;

export const rly0SkillsDeactivateParamsSchema = z.object({ name: rly0SkillNameSchema }).strict();
export type Rly0SkillsDeactivateParams = z.infer<typeof rly0SkillsDeactivateParamsSchema>;

export const rly0SkillsDeactivateResultSchema = z
  .object({ ok: z.boolean(), backupId: rly0SkillBackupIdSchema.optional() })
  .strict();
export type Rly0SkillsDeactivateResult = z.infer<typeof rly0SkillsDeactivateResultSchema>;

export const rly0SkillsRestoreParamsSchema = z
  .object({ backupId: rly0SkillBackupIdSchema })
  .strict();
export type Rly0SkillsRestoreParams = z.infer<typeof rly0SkillsRestoreParamsSchema>;

export const rly0SkillsRestoreResultSchema = z.object({ ok: z.boolean() }).strict();
export type Rly0SkillsRestoreResult = z.infer<typeof rly0SkillsRestoreResultSchema>;

export const rly0SkillsImportParamsSchema = z
  .object({
    sourcePath: z.string().trim().min(1).max(4096),
    name: rly0SkillNameSchema.optional(),
  })
  .strict();
export type Rly0SkillsImportParams = z.infer<typeof rly0SkillsImportParamsSchema>;

export const rly0SkillsImportResultSchema = z
  .object({ ok: z.boolean(), name: rly0SkillNameSchema.optional() })
  .strict();
export type Rly0SkillsImportResult = z.infer<typeof rly0SkillsImportResultSchema>;
