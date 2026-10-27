import { suspectedMcpCredentials } from "../rly0-mcp/discovery.js";
import type { SharedMcpServer } from "@codexhost/harness-adapter/plugin";

/**
 * MCP entries for the agents whose only MCP source is a global config file (the Hub's opt-in
 * managed blocks). Adapted from amtiYo/agents `src/core/renderers.ts` (Apache-2.0, v0.9.2,
 * 9d2f3e92; see NOTICE.md): `renderAntigravityMcp` (stdio command/args/env, remote `serverUrl`)
 * and the YAML form follows Hermes's documented `mcp_servers` keys. Pure functions; the callers
 * decide which servers may be written to a global file at all.
 */
export function renderAntigravityMcp(
  servers: Record<string, SharedMcpServer>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.type === "stdio"
        ? {
            command: server.command,
            args: server.args,
            ...(Object.keys(server.env).length ? { env: server.env } : {}),
          }
        : {
            serverUrl: server.url,
            ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
          },
    ]),
  );
}

/**
 * Hermes `mcp_servers` entries as YAML lines indented under that key. Each value is a JSON flow
 * mapping, which YAML 1.2 reads as the same mapping, so no quoting rules are reimplemented.
 */
export function renderHermesMcpLines(servers: Record<string, SharedMcpServer>): string[] {
  return Object.entries(servers).map(([name, server]) => {
    const value =
      server.type === "stdio"
        ? {
            command: server.command,
            args: server.args,
            ...(Object.keys(server.env).length ? { env: server.env } : {}),
          }
        : {
            url: server.url,
            ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
          };
    return `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`;
  });
}

/** A server with credentials in its options never goes into a global file. */
export function carriesCredentials(server: SharedMcpServer): boolean {
  return suspectedMcpCredentials(
    server.type === "stdio"
      ? {
          ...server,
          env: Object.fromEntries(
            Object.entries(server.env).filter(([key]) => !key.startsWith("RLY0_MEMORY_")),
          ),
        }
      : { ...server },
  );
}
