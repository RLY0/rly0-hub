import { parse as parseToml } from "smol-toml";

import type { Rly0McpServer } from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringKeys(value: unknown): string[] | undefined {
  if (!isRecord(value)) return undefined;
  return Object.keys(value);
}

/**
 * Parses `config.toml` with `smol-toml` (full re-parse, read-only — see `toml-editor.ts` for why
 * writes go through a line editor instead) and shapes each `[mcp_servers.<name>]` table into the
 * shared-contracts summary. Only key *names* are read from `env`/`headers`/`http_headers`
 * sub-tables; their values never leave this function.
 */
export function parseMcpServersForDisplay(content: string): Rly0McpServer[] {
  const parsed: unknown = parseToml(content);
  if (!isRecord(parsed)) return [];
  const servers = parsed.mcp_servers;
  if (!isRecord(servers)) return [];
  const result: Rly0McpServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) continue;
    const hasCommand = typeof raw.command === "string";
    const hasUrl = typeof raw.url === "string";
    if (!hasCommand && !hasUrl) continue;
    const type = hasCommand ? ("stdio" as const) : ("http" as const);
    const enabled = raw.enabled !== false;
    const envKeys = stringKeys(raw.env);
    const headerKeys = stringKeys(raw.headers) ?? stringKeys(raw.http_headers);
    const args = Array.isArray(raw.args)
      ? raw.args.filter((value): value is string => typeof value === "string")
      : undefined;
    result.push({
      name,
      type,
      enabled,
      ...(hasCommand ? { command: raw.command as string } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(hasUrl ? { url: raw.url as string } : {}),
      ...(envKeys && envKeys.length > 0 ? { envKeys } : {}),
      ...(headerKeys && headerKeys.length > 0 ? { headerKeys } : {}),
    });
  }
  return result;
}
