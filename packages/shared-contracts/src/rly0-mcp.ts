import { z } from "zod";

/**
 * Contracts for the MCP server manager page. It reads and edits the `[mcp_servers.*]` tables in
 * `${CODEX_HOME:-~/.codex}/config.toml`. Secret-shaped values (environment variable values,
 * header/token values) never cross this boundary — only their key names do.
 */

export const RLY0_MCP_LIST_METHOD = "codexhost/rly0/mcp/list";
export const RLY0_MCP_SET_ENABLED_METHOD = "codexhost/rly0/mcp/setEnabled";
export const RLY0_MCP_REMOVE_METHOD = "codexhost/rly0/mcp/remove";
export const RLY0_MCP_ADD_METHOD = "codexhost/rly0/mcp/add";

/** Server names double as the TOML table key and (for STDIO) part of a shell argv, so the
 * character set is kept narrow to rule out directory traversal and TOML/shell injection. */
export const rly0McpNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u);
export type Rly0McpName = z.infer<typeof rly0McpNameSchema>;

export const rly0McpServerTypeSchema = z.enum(["stdio", "http"]);
export type Rly0McpServerType = z.infer<typeof rly0McpServerTypeSchema>;

export const rly0McpServerSchema = z
  .object({
    name: rly0McpNameSchema,
    type: rly0McpServerTypeSchema,
    enabled: z.boolean(),
    command: z.string().max(4096).optional(),
    args: z.array(z.string().max(1024)).max(64).optional(),
    url: z.string().max(2048).optional(),
    /** Names only — never the values — of any `env` table under the server. */
    envKeys: z.array(z.string().max(128)).max(128).optional(),
    /** Names only — never the values — of any `headers`/`http_headers` table under the server. */
    headerKeys: z.array(z.string().max(128)).max(128).optional(),
  })
  .strict();
export type Rly0McpServer = z.infer<typeof rly0McpServerSchema>;

export const rly0McpListParamsSchema = z.object({}).strict();
export type Rly0McpListParams = z.infer<typeof rly0McpListParamsSchema>;

export const rly0McpListResultSchema = z
  .object({
    configPath: z.string().max(4096),
    configExists: z.boolean(),
    totalCount: z.number().int().nonnegative(),
    enabledCount: z.number().int().nonnegative(),
    servers: z.array(rly0McpServerSchema).max(256),
    /** Set when `config.toml` exists but failed to parse; `servers` is empty in that case. */
    parseError: z.string().max(300).optional(),
  })
  .strict();
export type Rly0McpListResult = z.infer<typeof rly0McpListResultSchema>;

export const rly0McpSetEnabledParamsSchema = z
  .object({ name: rly0McpNameSchema, enabled: z.boolean() })
  .strict();
export type Rly0McpSetEnabledParams = z.infer<typeof rly0McpSetEnabledParamsSchema>;

export const rly0McpMutationResultSchema = z.object({ ok: z.boolean() }).strict();
export type Rly0McpMutationResult = z.infer<typeof rly0McpMutationResultSchema>;

export const rly0McpRemoveParamsSchema = z.object({ name: rly0McpNameSchema }).strict();
export type Rly0McpRemoveParams = z.infer<typeof rly0McpRemoveParamsSchema>;

export const rly0McpAddParamsSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("stdio"),
      name: rly0McpNameSchema,
      command: z.string().trim().min(1).max(4096),
      args: z.array(z.string().max(1024)).max(64).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      name: rly0McpNameSchema,
      url: z.string().trim().min(1).max(2048),
    })
    .strict(),
]);
export type Rly0McpAddParams = z.infer<typeof rly0McpAddParamsSchema>;
