import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tokens the person stored for remote MCP servers, one keychain item per server:
 * service {@link MCP_KEYCHAIN_SERVICE}, account = the server name in Codex `config.toml`.
 *
 * The Host only checks that an item exists (no secret is read). The value is read by the
 * headers helper, which Claude Code runs when it connects, and goes straight to its stdout —
 * never into argv, environment, configuration files, logs or model context. Codex's own OAuth
 * tokens are never copied: rotating refresh tokens would sign one client out and widen exposure.
 */
export const MCP_KEYCHAIN_SERVICE = "RLY0 Hub MCP";
export const MCP_HEADERS_ARGUMENT = "--rly0-mcp-headers";
const SECURITY = "/usr/bin/security";
export const MCP_CREDENTIAL_NAME = /^[A-Za-z0-9._-]{1,64}$/u;
export const MCP_HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;

export interface McpCredentialStore {
  /** Whether a token is stored for this server, without reading it. */
  has(name: string): Promise<boolean>;
  read(name: string): Promise<string | null>;
}

function run(args: string[], wantOutput: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      SECURITY,
      args,
      { timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : wantOutput ? stdout : ""),
    );
  });
}

/** macOS login keychain; other systems report no stored token. */
export const systemMcpCredentialStore: McpCredentialStore = {
  async has(name) {
    if (process.platform !== "darwin" || !MCP_CREDENTIAL_NAME.test(name)) return false;
    // Without -w/-g `security` prints item attributes only, and they are discarded here.
    return (
      (await run(["find-generic-password", "-s", MCP_KEYCHAIN_SERVICE, "-a", name], false)) !== null
    );
  },
  async read(name) {
    if (process.platform !== "darwin" || !MCP_CREDENTIAL_NAME.test(name)) return null;
    const value = await run(
      ["find-generic-password", "-s", MCP_KEYCHAIN_SERVICE, "-a", name, "-w"],
      true,
    );
    const token = value?.replace(/\r?\n$/u, "") ?? "";
    return token && !/[\r\n]/u.test(token) ? token : null;
  },
};

/** Which header a stored token fills for one Codex server entry, or null when none applies. */
export function credentialHeaderFor(
  server: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): string | null {
  if (typeof server.bearer_token_env_var === "string")
    return env[server.bearer_token_env_var] ? null : "Authorization";
  const envHeaders = server.env_http_headers;
  if (typeof envHeaders === "object" && envHeaders !== null && !Array.isArray(envHeaders)) {
    for (const [header, variable] of Object.entries(envHeaders))
      if (typeof variable === "string" && !env[variable] && MCP_HEADER_NAME.test(header))
        return header;
    return null;
  }
  const headers = { ...(server.headers as object), ...(server.http_headers as object) };
  if (Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) return null;
  return "Authorization";
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Shell command Claude Code runs as `headersHelper`; it carries names only, no secret. */
export function mcpHeadersHelperCommand(input: {
  entryUrl: string;
  name: string;
  header: string;
  nodePath?: string;
}): string | null {
  if (!MCP_CREDENTIAL_NAME.test(input.name) || !MCP_HEADER_NAME.test(input.header)) return null;
  const entry = fileURLToPath(input.entryUrl);
  const script = entry.endsWith(".mjs")
    ? [entry, MCP_HEADERS_ARGUMENT]
    : [path.join(path.dirname(entry), "rly0-mcp", "headers-main.js")];
  return [input.nodePath ?? process.execPath, ...script, input.name, input.header]
    .map(quote)
    .join(" ");
}

/** `headersHelper` entry: prints `{ header: value }` JSON, or fails without output. */
export async function runMcpHeadersHelper(
  args: readonly string[],
  store: McpCredentialStore = systemMcpCredentialStore,
  output: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const [name = "", header = ""] = args;
  if (!MCP_CREDENTIAL_NAME.test(name) || !MCP_HEADER_NAME.test(header)) return 2;
  const token = await store.read(name);
  if (!token) {
    process.stderr.write(`RLY/0 Hub: no stored token for MCP server ${name}\n`);
    return 1;
  }
  const value =
    header.toLowerCase() === "authorization" && !/\s/u.test(token) ? `Bearer ${token}` : token;
  output.write(JSON.stringify({ [header]: value }));
  return 0;
}
