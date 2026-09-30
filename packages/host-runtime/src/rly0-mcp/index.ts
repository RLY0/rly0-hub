import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  Rly0McpAddParams,
  Rly0McpListResult,
  Rly0McpMutationResult,
} from "@codexhost/shared-contracts";
import { rly0McpNameSchema } from "@codexhost/shared-contracts";

import { backupAndWriteAtomic, resolveCodexHome } from "./file-io.js";
import { parseMcpServersForDisplay } from "./reader.js";
import { appendMcpServer, removeMcpServer, setMcpServerEnabled } from "./toml-editor.js";

export interface Rly0McpManagerOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

function assertSafeName(name: string): void {
  if (!rly0McpNameSchema.safeParse(name).success) throw new Error("MCP_SERVER_INVALID_NAME");
}

async function readConfig(configPath: string): Promise<string | null> {
  try {
    return await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Reads and edits `[mcp_servers.*]` in `${CODEX_HOME:-~/.codex}/config.toml`. See
 * `toml-editor.ts` for why writes are a line-level edit rather than a full TOML re-serialize.
 */
export class Rly0McpManager {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: Rly0McpManagerOptions = {}) {
    this.#environment = options.environment ?? process.env;
  }

  configPath(): string {
    return path.join(resolveCodexHome(this.#environment), "config.toml");
  }

  async list(): Promise<Rly0McpListResult> {
    const configPath = this.configPath();
    const content = await readConfig(configPath);
    if (content === null) {
      return {
        configPath,
        configExists: false,
        totalCount: 0,
        enabledCount: 0,
        servers: [],
      };
    }
    try {
      const servers = parseMcpServersForDisplay(content);
      return {
        configPath,
        configExists: true,
        totalCount: servers.length,
        enabledCount: servers.filter((server) => server.enabled).length,
        servers,
      };
    } catch (error) {
      return {
        configPath,
        configExists: true,
        totalCount: 0,
        enabledCount: 0,
        servers: [],
        parseError: error instanceof Error ? error.message.slice(0, 300) : "TOML_PARSE_ERROR",
      };
    }
  }

  async setEnabled(name: string, enabled: boolean): Promise<Rly0McpMutationResult> {
    assertSafeName(name);
    const configPath = this.configPath();
    const content = await readConfig(configPath);
    if (content === null) throw new Error("MCP_CONFIG_NOT_FOUND");
    const next = setMcpServerEnabled(content, name, enabled);
    await backupAndWriteAtomic(configPath, next);
    return { ok: true };
  }

  async remove(name: string): Promise<Rly0McpMutationResult> {
    assertSafeName(name);
    const configPath = this.configPath();
    const content = await readConfig(configPath);
    if (content === null) throw new Error("MCP_CONFIG_NOT_FOUND");
    const next = removeMcpServer(content, name);
    await backupAndWriteAtomic(configPath, next);
    return { ok: true };
  }

  async add(params: Rly0McpAddParams): Promise<Rly0McpMutationResult> {
    assertSafeName(params.name);
    const configPath = this.configPath();
    const content = (await readConfig(configPath)) ?? "";
    const next =
      params.type === "stdio"
        ? appendMcpServer(content, {
            type: "stdio",
            name: params.name,
            command: params.command,
            ...(params.args ? { args: params.args } : {}),
          })
        : appendMcpServer(content, { type: "http", name: params.name, url: params.url });
    await backupAndWriteAtomic(configPath, next);
    return { ok: true };
  }
}

const KNOWN_MCP_ERROR_MESSAGES = new Set([
  "MCP_SERVER_INVALID_NAME",
  "MCP_SERVER_NOT_FOUND",
  "MCP_SERVER_ALREADY_EXISTS",
  "MCP_CONFIG_NOT_FOUND",
]);

/** Maps a rejected `Rly0McpManager` call to a JSON-RPC error; unknown failures never leak detail. */
export function rly0McpRpcError(error: unknown): { code: number; message: string } {
  if (error instanceof Error && KNOWN_MCP_ERROR_MESSAGES.has(error.message)) {
    return { code: -32000, message: error.message };
  }
  return { code: -32000, message: "MCP_OPERATION_FAILED" };
}
