import {
  rly0McpAddParamsSchema,
  rly0McpRemoveParamsSchema,
  rly0McpSetEnabledParamsSchema,
  rly0SkillsDeactivateParamsSchema,
  rly0SkillsImportParamsSchema,
  rly0SkillsRestoreParamsSchema,
  rly0ThreadsListParamsSchema,
  rly0ThreadsMoveParamsSchema,
} from "@codexhost/shared-contracts";
import { z } from "zod";

import { Rly0MaintenanceManager, rly0MaintenanceRpcError } from "../rly0-maintenance/index.js";
import { Rly0McpManager, rly0McpRpcError } from "../rly0-mcp/index.js";
import { Rly0SkillsManager, rly0SkillsRpcError } from "../rly0-skills/index.js";
import { Rly0ThreadsManager, rly0ThreadsRpcError } from "../rly0-threads/index.js";
import type { HostUpdateCoordinator } from "../update-coordinator.js";
import { checkHubUpdate } from "./update-check.js";
import type { Rly0CodexControl } from "./codex-control.js";
import type { Rly0CoreBridge } from "../rly0-core/index.js";

const empty = z.object({}).strict();
type RpcFailure = (error: unknown) => { code: number; message: string };

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
}) {
  const { environment, core, codex } = options;
  const mcp = new Rly0McpManager({ environment });
  const skills = new Rly0SkillsManager({ environment });
  const threads = new Rly0ThreadsManager({ environment });
  const maintenance = new Rly0MaintenanceManager({ environment, core });
  const updates = options.updates ?? { check: () => checkHubUpdate(options.installRoot) };
  const updateFailure = () => ({ code: -32000, message: "UPDATE_CHECK_FAILED" });
  return {
    "mcp.list": route(
      empty,
      async () => {
        const result = await mcp.list();
        // TOML parser errors may quote config content; expose a code only.
        return { ...result, ...(result.parseError ? { parseError: "MCP_CONFIG_INVALID" } : {}) };
      },
      rly0McpRpcError,
    ),
    "mcp.add": route(rly0McpAddParamsSchema, (p) => mcp.add(p), rly0McpRpcError),
    "mcp.setEnabled": route(
      rly0McpSetEnabledParamsSchema,
      (p) => mcp.setEnabled(p.name, p.enabled),
      rly0McpRpcError,
    ),
    "mcp.remove": route(rly0McpRemoveParamsSchema, (p) => mcp.remove(p.name), rly0McpRpcError),
    "skills.list": route(empty, () => skills.list(), rly0SkillsRpcError),
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
    "maintenance.cacheInfo": route(empty, () => maintenance.cacheInfo(), rly0MaintenanceRpcError),
    "maintenance.clearCache": route(empty, () => maintenance.clearCache(), rly0MaintenanceRpcError),
    "maintenance.forceQuitCodex": route(empty, () => codex.forceQuit(), rly0MaintenanceRpcError),
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
