import { readMcpOwnership, matchesMcpOwnership } from "./ownership.js";
import { syncNativeResources } from "../rly0-bridge/native-resources.js";
import { sharedResourceSettings } from "../shared-harness-resources.js";
import { resourceAddedAt } from "../resource-added-at.js";
import {
  controlExternalMcp,
  externalMcp,
  externalMcpDisplay,
  externalMcpLocations,
  readCodexMcp,
} from "./discovery.js";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  Rly0McpAddParams,
  Rly0McpListResult,
  Rly0McpMutationResult,
  Rly0McpServer,
} from "@codexhost/shared-contracts";
import { rly0McpNameSchema } from "@codexhost/shared-contracts";

import { backupAndWriteAtomic, resolveCodexHome } from "./file-io.js";
import { parseMcpServersForDisplay } from "./reader.js";
import {
  appendMcpServer,
  removeMcpServer,
  setMcpServerEnabled,
  updateMcpServerConnection,
} from "./toml-editor.js";

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

  async #withAddedAt(servers: Rly0McpServer[]): Promise<Rly0McpServer[]> {
    return Promise.all(
      servers.map(async (server) => {
        const addedAt = await resourceAddedAt(
          this.#environment,
          "mcp",
          server.name,
          server.sourcePath ?? this.configPath(),
        );
        return { ...server, ...(addedAt !== undefined ? { addedAt } : {}) };
      }),
    );
  }

  async list(): Promise<Rly0McpListResult> {
    const configPath = this.configPath();
    const content = await readConfig(configPath);
    const unavailable: string[] = [];
    const external = (await externalMcp(this.#environment, false, unavailable)).map(
      externalMcpDisplay,
    );
    const warning = unavailable.length
      ? { native: { error: "GLOBAL_CONFIG_MCP_SOURCE_UNAVAILABLE" } }
      : {};
    if (content === null) {
      return {
        configPath,
        configExists: false,
        totalCount: external.length,
        enabledCount: external.filter((v) => v.enabled).length,
        servers: await this.#withAddedAt(external),
        ...warning,
      };
    }
    try {
      const ownership = await readMcpOwnership(this.#environment);
      const raw = await readCodexMcp(this.#environment);
      const native = parseMcpServersForDisplay(content).map((view) => {
        const owner = ownership[view.name];
        const source =
          owner && !owner.disposed && matchesMcpOwnership(owner, raw[view.name])
            ? externalMcpLocations(this.#environment).find(
                ([, file]) => file === owner.sourcePath,
              )?.[0]
            : undefined;
        return source ? { ...view, source, sourcePath: owner?.sourcePath, external: true } : view;
      });
      const servers = [
        ...native,
        ...external.filter((v) => !native.some((n) => n.name === v.name)),
      ];
      return {
        configPath,
        configExists: true,
        totalCount: servers.length,
        enabledCount: servers.filter((server) => server.enabled).length,
        servers: await this.#withAddedAt(servers),
        ...warning,
      };
    } catch (error) {
      return {
        configPath,
        configExists: true,
        totalCount: 0,
        enabledCount: 0,
        servers: [],
        parseError: error instanceof Error ? error.message.slice(0, 300) : "TOML_PARSE_ERROR",
        ...warning,
      };
    }
  }

  async setEnabled(name: string, enabled: boolean): Promise<Rly0McpMutationResult> {
    assertSafeName(name);
    if (await controlExternalMcp(this.#environment, name, enabled ? "enabled" : "disabled")) {
      return this.#syncExternal();
    }
    const configPath = this.configPath();
    const content = await readConfig(configPath);
    if (content === null) throw new Error("MCP_CONFIG_NOT_FOUND");
    const next = setMcpServerEnabled(content, name, enabled);
    await backupAndWriteAtomic(configPath, next);
    return { ok: true };
  }

  async remove(name: string): Promise<Rly0McpMutationResult> {
    assertSafeName(name);
    if (await controlExternalMcp(this.#environment, name, "removed")) {
      return this.#syncExternal();
    }
    const configPath = this.configPath();
    const content = await readConfig(configPath);
    if (content === null) throw new Error("MCP_CONFIG_NOT_FOUND");
    const next = removeMcpServer(content, name);
    await backupAndWriteAtomic(configPath, next);
    return { ok: true };
  }

  async #syncExternal(): Promise<Rly0McpMutationResult> {
    try {
      await syncNativeResources(this.#environment, await sharedResourceSettings(this.#environment));
      return { ok: true };
    } catch {
      return { ok: true, native: { error: "GLOBAL_CONFIG_NATIVE_SYNC_FAILED" } };
    }
  }

  /** Changes how a server connects; its other settings stay. */
  async update(params: Rly0McpAddParams): Promise<Rly0McpMutationResult> {
    assertSafeName(params.name);
    const configPath = this.configPath();
    const content = await readConfig(configPath);
    if (content === null) throw new Error("MCP_CONFIG_NOT_FOUND");
    const next = updateMcpServerConnection(
      content,
      params.type === "stdio"
        ? {
            type: "stdio",
            name: params.name,
            command: params.command,
            ...(params.args ? { args: params.args } : {}),
          }
        : { type: "http", name: params.name, url: params.url },
    );
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
