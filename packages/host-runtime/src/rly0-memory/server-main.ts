// Source-build entry of the shared memory MCP server (`node dist/rly0-memory/server-main.js`).
// The release bundle runs the same server through `host-runtime.mjs --rly0-memory-mcp`; this file
// is never imported, so its top-level start cannot fire inside the Host.
import { runRly0MemoryServer } from "./launch.js";

process.exitCode = await runRly0MemoryServer(process.env);
