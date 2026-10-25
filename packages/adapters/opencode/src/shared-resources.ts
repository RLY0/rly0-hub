import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SharedMcpServer,
  SharedResourceRequest,
  SharedResourcesProvider,
} from "@codexhost/harness-adapter/plugin";

/** OpenCode mounts MCP from its config and reads extra instruction files. */
export const OPENCODE_SHARED_RESOURCE_REQUEST: SharedResourceRequest = Object.freeze({
  harnessId: "opencode",
  mcp: true,
  skills: true,
  memory: true,
  memoryMcp: true,
});

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * OpenCode's `mcp` config map. Adapted from amtiYo/agents `renderOpencodeMcp`
 * (src/core/renderers.ts, Apache-2.0; see NOTICE.md): local servers take one command array and
 * `environment`, remote ones `url` and `headers`.
 */
export function renderOpenCodeMcp(servers: Record<string, SharedMcpServer>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.type === "stdio"
        ? {
            type: "local",
            enabled: true,
            command: [server.command, ...server.args],
            ...(Object.keys(server.env).length ? { environment: server.env } : {}),
          }
        : {
            type: "remote",
            enabled: true,
            url: server.url,
            ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
          },
    ]),
  );
}

/**
 * The managed OpenCode process gets the shared resources through `OPENCODE_CONFIG_CONTENT`, which
 * OpenCode merges over the person's own config files (never rewritten): MCP options stay in that
 * process environment; the skill index / memory instruction is an `instructions` file in a private
 * temporary folder, removed when the Session closes.
 */
export async function openCodeSharedEnvironment(
  provider: SharedResourcesProvider | undefined,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ environment: NodeJS.ProcessEnv; dispose(): Promise<void> }> {
  const unchanged = { environment, dispose: async () => {} };
  if (!provider) return unchanged;
  const shared = await provider(cwd, OPENCODE_SHARED_RESOURCE_REQUEST).catch(() => undefined);
  if (!shared || (!Object.keys(shared.mcpServers).length && !shared.context)) return unchanged;
  let config: Record<string, unknown> = {};
  if (environment.OPENCODE_CONFIG_CONTENT !== undefined) {
    try {
      const parsed: unknown = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);
      if (!record(parsed)) return unchanged;
      config = parsed;
    } catch {
      return unchanged;
    }
  }
  let directory: string | undefined;
  const instructions: string[] = Array.isArray(config.instructions)
    ? config.instructions.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (shared.context) {
    directory = await mkdtemp(path.join(os.tmpdir(), "rly0-opencode-shared-"));
    const file = path.join(directory, "rly0-shared-resources.md");
    await writeFile(file, `${shared.context}\n`, { mode: 0o600 });
    instructions.push(file);
  }
  const mcp = { ...(record(config.mcp) ? config.mcp : {}), ...renderOpenCodeMcp(shared.mcpServers) };
  return {
    environment: {
      ...environment,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        ...(Object.keys(mcp).length ? { mcp } : {}),
        ...(instructions.length ? { instructions } : {}),
      }),
    },
    dispose: async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
