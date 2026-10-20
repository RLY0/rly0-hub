import {
  rly0AgentAccountAliasParamsSchema,
  rly0AgentAccountIdParamsSchema,
  rly0AgentAccountImportFileParamsSchema,
  rly0AgentAccountRenameParamsSchema,
  rly0AgentAddLoginIdParamsSchema,
} from "@codexhost/shared-contracts";
import { z } from "zod";

import type { AntigravityUsageReader } from "../rly0-agents/antigravity-usage.js";
import type { Rly0CoreBridge } from "../rly0-core/index.js";
import { importGrokAccountFile, type GrokAddLogin } from "./grok-add-login.js";

const empty = z.object({}).strict();

function coded(code: string): Error {
  return Object.assign(new Error(code), { code: -32000 });
}

function route<S extends z.ZodTypeAny>(
  schema: S,
  run: (params: z.infer<S>) => Promise<unknown> | unknown,
) {
  return async (raw: unknown): Promise<unknown> => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw Object.assign(new Error("INVALID_PARAMS"), { code: -32602 });
    return run(parsed.data);
  };
}

/**
 * The Grok and Gemini (Antigravity) halves of the 账号 page.
 * - Grok: saved Grok CLI accounts kept by rly0-core (`grok/*`), switched by swapping the CLI's
 *   `auth.json`; added by the official `grok login` in a throw-away GROK_HOME or from a file.
 *   Switching is manual and affects new Grok conversations.
 * - Antigravity: only the current login's quota from `agy /usage`, on request. Its login lives in
 *   the keyring entry the Antigravity App, CLI and IDEs share, so the Hub keeps no accounts.
 */
export function createAgentAccountRoutes(options: {
  core: Rly0CoreBridge;
  grokAdd: GrokAddLogin;
  antigravity: AntigravityUsageReader;
  /** Saves an xAI API key found in a file (a Sub2API export) as the official key. */
  saveXaiKeyFile: (content: string) => Promise<unknown>;
}) {
  const { core, grokAdd, antigravity } = options;
  const grok = async (
    method: Parameters<Rly0CoreBridge["grokAccounts"]>[0],
    params: Record<string, unknown> = {},
  ) => {
    const result = await core.grokAccounts(method, params);
    if (!result) throw coded("RLY0_CORE_UNAVAILABLE");
    return result;
  };
  return {
    "agents.grokAccounts.list": route(empty, () => grok("list")),
    "agents.grokAccounts.importCurrent": route(rly0AgentAccountAliasParamsSchema, (p) =>
      grok("importCurrent", p.alias ? { alias: p.alias } : {}),
    ),
    "agents.grokAccounts.addLoginStart": route(rly0AgentAccountAliasParamsSchema, (p) =>
      grokAdd.start(p.alias),
    ),
    "agents.grokAccounts.addLoginStatus": route(empty, () => grokAdd.status()),
    "agents.grokAccounts.addLoginOpen": route(rly0AgentAddLoginIdParamsSchema, (p) =>
      grokAdd.reopen(p.id),
    ),
    "agents.grokAccounts.addLoginCancel": route(rly0AgentAddLoginIdParamsSchema, (p) =>
      grokAdd.cancel(p.id),
    ),
    "agents.grokAccounts.importFile": route(rly0AgentAccountImportFileParamsSchema, (p) =>
      importGrokAccountFile(core, p.content, {
        ...(p.alias ? { alias: p.alias } : {}),
        saveKeyFile: options.saveXaiKeyFile,
      }),
    ),
    "agents.grokAccounts.switch": route(rly0AgentAccountIdParamsSchema, (p) =>
      grok("switch", { id: p.id }),
    ),
    "agents.grokAccounts.rename": route(rly0AgentAccountRenameParamsSchema, (p) =>
      grok("rename", p),
    ),
    "agents.grokAccounts.remove": route(rly0AgentAccountIdParamsSchema, (p) =>
      grok("remove", { id: p.id }),
    ),
    "agents.grokAccounts.usage": route(rly0AgentAccountIdParamsSchema, (p) =>
      grok("usage", { id: p.id }),
    ),
    "agents.grokAccounts.usageAll": route(empty, () => grok("usageAll")),
    "agents.antigravity.status": route(empty, () => antigravity.status()),
    "agents.antigravity.cached": route(empty, () => antigravity.cached()),
    "agents.antigravity.usage": route(empty, () => antigravity.refresh()),
  };
}
