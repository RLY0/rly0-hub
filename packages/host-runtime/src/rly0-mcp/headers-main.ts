// Source-build entry of the MCP headers helper (`node dist/rly0-mcp/headers-main.js <name> <header>`).
// The release bundle runs the same helper through `host-runtime.mjs --rly0-mcp-headers`; this file
// is never imported, so its top-level start cannot fire inside the Host.
import { runMcpHeadersHelper } from "./credentials.js";

process.exitCode = await runMcpHeadersHelper(process.argv.slice(2));
