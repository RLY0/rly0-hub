import { syncNativeResourcesIfChanged } from "../rly0-bridge/native-resources.js";
import { sharedResourceSettings } from "../shared-harness-resources.js";
import {
  rly0MaintenanceExportFeedbackParamsSchema,
  rly0MaintenanceFeedbackFolderSchema,
  rly0McpAddParamsSchema,
  rly0McpRemoveParamsSchema,
  rly0McpSetEnabledParamsSchema,
  rly0SkillsDeactivateParamsSchema,
  rly0SkillsImportParamsSchema,
  rly0SkillsRestoreParamsSchema,
  rly0ThreadsListParamsSchema,
  rly0ThreadsMoveParamsSchema,
  rly0CodexPreferenceValuesSchema,
} from "@codexhost/shared-contracts";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { Rly0MaintenanceManager, rly0MaintenanceRpcError } from "../rly0-maintenance/index.js";
import { ChatRepair } from "../rly0-maintenance/chat-repair.js";
import {
  Rly0DesktopCompatibility,
  type DesktopCompatibilitySource,
} from "../rly0-maintenance/desktop-compatibility.js";
import { ChatReadableRecovery } from "../rly0-maintenance/chat-recovery.js";
import { resolveRly0DiagnosticsDir } from "../rly0-maintenance/paths.js";
import { Rly0InstructionsManager, rly0InstructionsRpcError } from "../rly0-instructions/index.js";
import { Rly0McpManager, rly0McpRpcError } from "../rly0-mcp/index.js";
import { Rly0SkillsManager, rly0SkillsRpcError } from "../rly0-skills/index.js";
import { Rly0ThreadsManager, rly0ThreadsRpcError } from "../rly0-threads/index.js";
import { Rly0DashboardManager, rly0DashboardRpcError } from "../rly0-dashboard/index.js";
import {
  readCodexPreferences,
  writeCodexPreferences,
} from "../rly0-appearance/codex-preferences.js";
import type { HostUpdateCoordinator } from "../update-coordinator.js";
import { checkHubUpdate } from "./update-check.js";
import type { Rly0CodexControl } from "./codex-control.js";
import type { Rly0CoreBridge } from "../rly0-core/index.js";

const empty = z.object({}).strict();
type RpcFailure = (error: unknown) => { code: number; message: string };

const codexPrefsRpcError = () => ({ code: -32000, message: "CODEX_PREFERENCES_FAILED" });

function route<T>(schema: z.ZodType<T>, run: (params: T) => unknown, failure: RpcFailure) {
  return async (raw: unknown): Promise<unknown> => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw Object.assign(new Error("INVALID_PARAMS"), { code: -32602 });
    try {
      return await run(parsed.data);
    } catch (error) {
      const safe = failure(error);
      throw Object.assign(new Error(safe.message), { code: safe.code });
    }
  };
}

/** Independent managers; these routes never need a live Codex app-server. */
export function createHubManagementRoutes(options: {
  environment: NodeJS.ProcessEnv;
  installRoot: string;
  core: Rly0CoreBridge;
  codex: Rly0CodexControl;
  updates?: Pick<HostUpdateCoordinator, "check">;
  compatibility?: DesktopCompatibilitySource;
  /** An update is downloading or installing: its installer folder is not cleared. */
  updateBusy?: () => boolean;
  /** Shows a folder in Explorer; the default runs `explorer.exe`. */
  openFolder?: (directory: string) => void;
}) {
  const { environment, core, codex } = options;
  const mcp = new Rly0McpManager({ environment });
  const skills = new Rly0SkillsManager({ environment });
  const threads = new Rly0ThreadsManager({ environment });
  const dashboard = new Rly0DashboardManager({ environment, threads });
  const instructions = new Rly0InstructionsManager({ environment });
  const content = z.string().max(64 * 1024);
  const chatRepair = new ChatRepair({ environment, codex });
  const chatRecovery = new ChatReadableRecovery(environment);
  const maintenance = new Rly0MaintenanceManager({
    environment,
    core,
    compatibility:
      options.compatibility ??
      new Rly0DesktopCompatibility({ environment, installRoot: options.installRoot }),
    busyEntries: () => (options.updateBusy?.() ? ["updates"] : []),
  });
  const openFolder =
    options.openFolder ??
    ((directory: string) => {
      const child = spawn("explorer.exe", [directory], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    });
  const updates = options.updates ?? { check: () => checkHubUpdate(options.installRoot) };
  const updateFailure = () => ({ code: -32000, message: "UPDATE_CHECK_FAILED" });
  return {
    "instructions.state": route(empty, () => instructions.state(), rly0InstructionsRpcError),
    "instructions.preview": route(
      z.object({ content }).strict(),
      (p) => instructions.preview(p.content),
      rly0InstructionsRpcError,
    ),
    "instructions.apply": route(
      z.object({ content, template: z.string().max(40).optional() }).strict(),
      (p) => instructions.apply(p.content, p.template),
      rly0InstructionsRpcError,
    ),
    "instructions.clear": route(empty, () => instructions.clear(), rly0InstructionsRpcError),
    "instructions.rollback": route(
      z.object({ id: z.string().regex(/^\d{12}-[a-z0-9]{1,8}$/u) }).strict(),
      (p) => instructions.rollback(p.id),
      rly0InstructionsRpcError,
    ),
    "mcp.list": route(
      empty,
      async () => {
        await syncNativeResourcesIfChanged(
          environment,
          await sharedResourceSettings(environment),
        ).catch(() => undefined);
        const result = await mcp.list();
        // TOML parser errors may quote config content; expose a code only.
        return { ...result, ...(result.parseError ? { parseError: "MCP_CONFIG_INVALID" } : {}) };
      },
      rly0McpRpcError,
    ),
    "mcp.add": route(rly0McpAddParamsSchema, (p) => mcp.add(p), rly0McpRpcError),
    "mcp.update": route(rly0McpAddParamsSchema, (p) => mcp.update(p), rly0McpRpcError),
    "mcp.setEnabled": route(
      rly0McpSetEnabledParamsSchema,
      (p) => mcp.setEnabled(p.name, p.enabled),
      rly0McpRpcError,
    ),
    "mcp.remove": route(rly0McpRemoveParamsSchema, (p) => mcp.remove(p.name), rly0McpRpcError),
    "skills.list": route(
      empty,
      async () => {
        // A page refresh also discovers installers that ran after Hub startup.
        let native: { error: string } | undefined;
        try {
          await syncNativeResourcesIfChanged(
            environment,
            await sharedResourceSettings(environment),
          );
        } catch {
          native = { error: "GLOBAL_CONFIG_NATIVE_SYNC_FAILED" };
        }
        return { ...(await skills.list()), ...(native ? { native } : {}) };
      },
      rly0SkillsRpcError,
    ),
    "skills.openFolder": route(
      z
        .object({
          name: z
            .string()
            .regex(/^[A-Za-z0-9._-]{1,128}$/u)
            .optional(),
        })
        .strict(),
      async (p) => {
        const root = skills.skillsRoot();
        const target = p.name ? await skills.skillPath(p.name) : root;
        if (
          !(await fs.stat(target).then(
            (stat) => stat.isDirectory(),
            () => false,
          ))
        )
          throw new Error("SKILL_NOT_FOUND");
        openFolder(target);
        return { ok: true };
      },
      () => ({ code: -32000, message: "SKILL_NOT_FOUND" }),
    ),
    "skills.import": route(
      rly0SkillsImportParamsSchema,
      (p) => skills.importSkill(p),
      rly0SkillsRpcError,
    ),
    "skills.deactivate": route(
      rly0SkillsDeactivateParamsSchema,
      (p) => skills.deactivate(p.name),
      rly0SkillsRpcError,
    ),
    "skills.restore": route(
      rly0SkillsRestoreParamsSchema,
      (p) => skills.restore(p.backupId),
      rly0SkillsRpcError,
    ),
    "threads.list": route(
      rly0ThreadsListParamsSchema,
      (p) => threads.list(p.limit),
      rly0ThreadsRpcError,
    ),
    // 设置 → 通用 → Codex 里: what the in-Codex 通用 page set; Codex applies it on its next check.
    "prefs.codexGet": route(
      empty,
      async () => ({ preferences: await readCodexPreferences(environment) }),
      codexPrefsRpcError,
    ),
    "prefs.codexSet": route(
      rly0CodexPreferenceValuesSchema,
      async (p) => ({ preferences: await writeCodexPreferences(environment, p) }),
      codexPrefsRpcError,
    ),
    // 首页 → Codex 概况 (the former in-Codex 仪表盘): session totals and the 12-week activity.
    "dashboard.threadStats": route(empty, () => dashboard.threadStats(), rly0DashboardRpcError),
    "threads.listTrash": route(empty, () => threads.listTrash(), rly0ThreadsRpcError),
    "threads.trash": route(
      rly0ThreadsMoveParamsSchema,
      (p) => threads.trash(p.relPaths),
      rly0ThreadsRpcError,
    ),
    "threads.restore": route(
      rly0ThreadsMoveParamsSchema,
      (p) => threads.restore(p.relPaths),
      rly0ThreadsRpcError,
    ),
    "maintenance.diagnostics": route(
      empty,
      () => maintenance.diagnostics(),
      rly0MaintenanceRpcError,
    ),
    "maintenance.exportDiagnostics": route(
      empty,
      () => maintenance.exportDiagnostics(),
      rly0MaintenanceRpcError,
    ),
    "maintenance.exportFeedback": route(
      rly0MaintenanceExportFeedbackParamsSchema,
      (p) => maintenance.exportFeedback(p),
      rly0MaintenanceRpcError,
    ),
    "maintenance.startEndpointApp": route(
      empty,
      () => maintenance.startEndpointApp(),
      rly0MaintenanceRpcError,
    ),
    "maintenance.cacheInfo": route(empty, () => maintenance.cacheInfo(), rly0MaintenanceRpcError),
    "maintenance.clearCache": route(empty, () => maintenance.clearCache(), rly0MaintenanceRpcError),
    "maintenance.forceQuitCodex": route(empty, () => codex.forceQuit(), rly0MaintenanceRpcError),
    "maintenance.modelCheck": route(empty, () => maintenance.modelCheck(), rly0MaintenanceRpcError),
    "maintenance.setModel": route(
      z.object({ model: z.string().min(1).max(80) }).strict(),
      (p) => maintenance.setModel(p.model),
      rly0MaintenanceRpcError,
    ),
    "maintenance.chatRepairScan": route(empty, () => chatRepair.scan(), rly0MaintenanceRpcError),
    "maintenance.chatRecoverReadable": route(
      empty,
      () => chatRecovery.start(),
      rly0MaintenanceRpcError,
    ),
    "maintenance.chatRecoverStatus": route(
      empty,
      () => chatRecovery.status(),
      rly0MaintenanceRpcError,
    ),
    "maintenance.openRecoveredHistory": route(
      empty,
      async () => {
        openFolder(await chatRecovery.completedIndex());
        return { ok: true };
      },
      rly0MaintenanceRpcError,
    ),
    "maintenance.chatRepair": route(
      z.object({ includeDeleted: z.boolean().optional() }).strict(),
      (p) => chatRepair.repair(p),
      rly0MaintenanceRpcError,
    ),
    // Without a folder: the diagnostics directory; with one: that feedback report inside it.
    "maintenance.openDiagnosticsFolder": route(
      z.object({ folder: rly0MaintenanceFeedbackFolderSchema.optional() }).strict(),
      async (p) => {
        const base = resolveRly0DiagnosticsDir(environment);
        const directory = p.folder ? path.join(base, p.folder) : base;
        await fs.mkdir(directory, { recursive: true });
        openFolder(directory);
        return { ok: true };
      },
      rly0MaintenanceRpcError,
    ),
    "maintenance.filtersGet": route(
      empty,
      async () => {
        const filters = await core.filters();
        return filters ? { available: true, ...filters } : { available: false };
      },
      rly0MaintenanceRpcError,
    ),
    "maintenance.filtersSet": route(
      z
        .object({ imageTool: z.boolean().optional(), webSearchTool: z.boolean().optional() })
        .strict(),
      async (p) => {
        const filters = await core.filters(p);
        return filters ? { available: true, ...filters } : { available: false };
      },
      rly0MaintenanceRpcError,
    ),
    "maintenance.restartCodex": route(empty, () => codex.restart(), rly0MaintenanceRpcError),
    "updates.check": route(
      empty,
      async () => {
        const result = await updates.check();
        return {
          ...result,
          error: result.error ? "UPDATE_CHECK_FAILED" : null,
          status: result.status
            ? { ...result.status, error: result.status.error ? "UPDATE_FAILED" : null }
            : null,
        };
      },
      updateFailure,
    ),
  };
}
