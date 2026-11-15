// Synthetic fixtures only: no real Codex config, keychain item or token is read.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_SHARED_RESOURCE_REQUEST } from "@codexhost/adapter-claude-code";

import { checkLocalCommand, localCandidates } from "../../src/rly0-mcp/local-availability.js";
import {
  credentialHeaderFor,
  runMcpHeadersHelper,
  type McpCredentialStore,
} from "../../src/rly0-mcp/credentials.js";
import { readAgentMcpStatus, recordAgentMcpStatus } from "../../src/rly0-mcp/agent-status.js";
import { Rly0McpManager } from "../../src/rly0-mcp/index.js";
import { sharedResourcesProvider } from "../../src/shared-harness-resources.js";

const posix = process.platform === "win32" ? describe.skip : describe;
// Claude Code's request without skills: no background skill sync writes into the fixture.
const CLAUDE_MCP_REQUEST = { ...CLAUDE_SHARED_RESOURCE_REQUEST, skills: false };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rly0-synthetic-mcp-")));
  roots.push(root);
  return root;
}
async function executable(file: string, content = "#!/bin/sh\nexit 0\n"): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode: 0o755 });
  return file;
}
function store(names: string[], token = "synthetic-token-1"): McpCredentialStore {
  return {
    has: async (name) => names.includes(name),
    read: async (name) => (names.includes(name) ? token : null),
  };
}

posix("local MCP command check", () => {
  it("maps a Windows .exe path to the local program beside it", async () => {
    const root = await tempRoot();
    const local = await executable(path.join(root, ".local", "bin", "basic-memory"));
    const env = { HOME: root, PATH: "/usr/bin:/bin" };
    for (const written of [
      "C:\\Users\\someone\\.local\\bin\\basic-memory.exe",
      path.join(root, ".local", "bin", "basic-memory.exe"),
    ])
      expect(await checkLocalCommand(written, env, "darwin", "arm64")).toEqual({
        available: true,
        command: local,
        mappedFrom: written,
      });
  });

  it("uses a local virtual environment for a Windows venv, never a bare python", async () => {
    const root = await tempRoot();
    const written = path.join(root, "server", ".venv", "Scripts", "python.exe");
    expect(localCandidates(written, { HOME: root }, "arm64")).toEqual([
      path.join(root, "server", ".venv", "bin", "python3"),
      path.join(root, "server", ".venv", "bin", "python"),
    ]);
    const missing = await checkLocalCommand(written, { HOME: root, PATH: "" }, "darwin");
    expect(missing).toMatchObject({ available: false });
    expect(missing.available ? "" : missing.reason).toContain("Windows");
    const python = await executable(path.join(root, "server", ".venv", "bin", "python3"));
    expect(await checkLocalCommand(written, { HOME: root }, "darwin")).toMatchObject({
      available: true,
      command: python,
    });
  });

  it("maps a global npm package's Windows binary to this system's build", async () => {
    const root = await tempRoot();
    const prefix = path.join(root, "npm-global");
    const binary = await executable(
      path.join(prefix, "lib", "node_modules", "@x", "tool-darwin-arm64", "bin", "tool"),
    );
    const written =
      "/Users/someone/AppData/Roaming/npm/node_modules/@x/tool-win32-x64/bin/tool.exe";
    expect(
      await checkLocalCommand(
        written,
        { HOME: root, npm_config_prefix: prefix },
        "darwin",
        "arm64",
      ),
    ).toEqual({ available: true, command: binary, mappedFrom: written });
  });

  it("reports a Windows program and a command missing from PATH with a reason", async () => {
    const root = await tempRoot();
    const pe = await executable(path.join(root, "tool"), "MZ\u0090\u0000synthetic");
    const windows = await checkLocalCommand(pe, { HOME: root }, "darwin");
    expect(windows).toMatchObject({ available: false });
    expect(windows.available ? "" : windows.reason).toContain("Windows 程序");
    const bare = await checkLocalCommand("codegraph-synthetic-missing", { PATH: root }, "darwin");
    expect(bare.available ? "" : bare.reason).toContain("PATH");
    await executable(path.join(root, "codegraph-synthetic"));
    expect(await checkLocalCommand("codegraph-synthetic", { PATH: root }, "darwin")).toEqual({
      available: true,
      command: "codegraph-synthetic",
    });
  });
});

describe("MCP headers helper", () => {
  it("chooses the header a stored token fills", () => {
    expect(credentialHeaderFor({ url: "https://a.invalid" }, {})).toBe("Authorization");
    expect(credentialHeaderFor({ bearer_token_env_var: "T" }, { T: "x" })).toBeNull();
    expect(credentialHeaderFor({ bearer_token_env_var: "T" }, {})).toBe("Authorization");
    expect(credentialHeaderFor({ env_http_headers: { "X-Goog-Api-Key": "K" } }, {})).toBe(
      "X-Goog-Api-Key",
    );
    expect(credentialHeaderFor({ env_http_headers: { "X-Goog-Api-Key": "K" } }, { K: "v" })).toBe(
      null,
    );
    expect(credentialHeaderFor({ headers: { Authorization: "static" } }, {})).toBeNull();
  });

  it("prints only the header JSON, and nothing when no token is stored", async () => {
    let out = "";
    const sink = new Writable({
      write(chunk, _encoding, done) {
        out += String(chunk);
        done();
      },
    });
    expect(
      await runMcpHeadersHelper(["cloudflare", "Authorization"], store(["cloudflare"]), sink),
    ).toBe(0);
    expect(JSON.parse(out)).toEqual({ Authorization: "Bearer synthetic-token-1" });
    out = "";
    expect(await runMcpHeadersHelper(["stitch", "X-Goog-Api-Key"], store(["stitch"]), sink)).toBe(
      0,
    );
    expect(JSON.parse(out)).toEqual({ "X-Goog-Api-Key": "synthetic-token-1" });
    out = "";
    expect(await runMcpHeadersHelper(["other", "Authorization"], store([]), sink)).toBe(1);
    expect(await runMcpHeadersHelper(["../x", "Authorization"], store(["../x"]), sink)).toBe(2);
    expect(await runMcpHeadersHelper(["a", "Bad Header"], store(["a"]), sink)).toBe(2);
    expect(out).toBe("");
  });
});

posix("shared MCP delivery", () => {
  async function fixture(stored: string[]) {
    const root = await tempRoot();
    const codex = path.join(root, "codex");
    const project = path.join(root, "project");
    await fs.mkdir(codex, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    const good = await executable(path.join(root, "bin", "good-server"));
    await fs.writeFile(
      path.join(codex, "config.toml"),
      [
        `[mcp_servers.good]\ncommand = "${good}"`,
        `[mcp_servers.winonly]\ncommand = '${root}/AppData/Roaming/npm/node_modules/@x/y-win32-x64/bin/y.exe'`,
        `[mcp_servers.venv]\ncommand = '${root}/srv/.venv/Scripts/python.exe'\nargs = ["${root}/srv/main.py"]`,
        `[mcp_servers.missing]\ncommand = "codegraph-synthetic-missing"`,
        `[mcp_servers.cloud]\nurl = "https://cloud.invalid/mcp"`,
        `[mcp_servers.keyed]\nurl = "https://keyed.invalid/mcp"\n[mcp_servers.keyed.env_http_headers]\nX-Goog-Api-Key = "SYNTHETIC_UNSET_KEY"`,
        `[mcp_servers.open]\nurl = "https://open.invalid/mcp"`,
      ].join("\n"),
    );
    const env = {
      HOME: root,
      PATH: path.join(root, "bin"),
      CODEX_HOME: codex,
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      RLY0_MEMORY_DIR: path.join(root, "data", "memory"),
    };
    const entryUrl = pathToFileURL(path.join(root, "app", "host-runtime.mjs")).href;
    const provider = sharedResourcesProvider(env, {
      memoryEntryUrl: entryUrl,
      credentials: store(stored),
    });
    return { root, env, project, provider };
  }

  it("keeps back commands that cannot run here without affecting the other servers", async () => {
    const f = await fixture([]);
    const shared = await f.provider(f.project, CLAUDE_MCP_REQUEST);
    expect(Object.keys(shared.mcpServers)).toEqual(
      expect.arrayContaining(["codex_good", "codex_cloud", "codex_keyed", "codex_open"]),
    );
    for (const name of ["codex_winonly", "codex_venv", "codex_missing"])
      expect(shared.mcpServers[name]).toBeUndefined();
    expect(shared.context).toContain("mcpUnavailableHere");
    expect(shared.context).toMatch(/codex_missing: 本机 PATH 里找不到命令/u);
    expect(shared.context).toContain("mcpMayNeedAuthorization");
    expect(shared.context).toContain("RLY0 Hub MCP");
    expect(shared.mcpServers.codex_cloud).not.toHaveProperty("headersHelper");
  });

  it("attaches a stored token through headersHelper for Claude Code only, never the value", async () => {
    const f = await fixture(["cloud", "keyed"]);
    const shared = await f.provider(f.project, CLAUDE_MCP_REQUEST);
    const cloud = shared.mcpServers.codex_cloud;
    const keyed = shared.mcpServers.codex_keyed;
    expect(cloud?.type === "http" && cloud.headersHelper).toMatch(
      /host-runtime\.mjs' '--rly0-mcp-headers' 'cloud' 'Authorization'$/u,
    );
    expect(keyed?.type === "http" && keyed.headersHelper).toMatch(/'keyed' 'X-Goog-Api-Key'$/u);
    expect(JSON.stringify(shared)).not.toContain("synthetic-token-1");
    const asked = /"mcpMayNeedAuthorization":\[([^\]]*)\]/u.exec(shared.context)?.[1] ?? "";
    expect(asked).not.toMatch(/codex_cloud|codex_keyed/u);
    const other = await f.provider(f.project, { harnessId: "kimi-code", mcp: true });
    const otherCloud = other.mcpServers.codex_cloud;
    expect(otherCloud?.type === "http" && otherCloud.headersHelper).toBeFalsy();
  });

  it("records what the Agent reported and shows it with local state in the Hub list", async () => {
    const f = await fixture(["cloud"]);
    const shared = await f.provider(f.project, CLAUDE_MCP_REQUEST);
    shared.reportMcpStatus?.([
      { name: "codex_cloud", status: "connected" },
      { name: "codex_open", status: "needs-auth" },
      { name: "codex_good", status: "failed", error: "spawn failed token=synthetic-secret-value" },
      { name: "not_delivered", status: "connected" },
    ]);
    await recordAgentMcpStatus(f.env, "claude-code", []);
    const status = (await readAgentMcpStatus(f.env))["claude-code"] ?? {};
    expect(Object.keys(status).sort()).toEqual(["cloud", "good", "open"]);
    expect(status.good?.error ?? "").not.toContain("synthetic-secret-value");

    const list = await new Rly0McpManager({
      environment: f.env,
      credentials: store(["cloud"]),
    }).list();
    const byName = Object.fromEntries(list.servers.map((s) => [s.name, s]));
    expect(byName.good?.local).toEqual({ available: true });
    expect(byName.winonly?.local).toMatchObject({ available: false });
    expect(byName.missing?.local?.reason).toContain("PATH");
    if (process.platform === "darwin") {
      expect(byName.cloud?.credential).toBe("configured");
      expect(byName.open?.credential).toBe("missing");
    }
    expect(byName.cloud?.agents).toEqual([
      expect.objectContaining({ harnessId: "claude-code", status: "connected" }),
    ]);
    expect(byName.open?.agents?.[0]?.status).toBe("needs-auth");

    // A server the Agent already connected is no longer listed as needing authorization.
    const next = await f.provider(f.project, CLAUDE_MCP_REQUEST);
    const line = /"mcpMayNeedAuthorization":\[([^\]]*)\]/u.exec(next.context)?.[1] ?? "";
    expect(line).toContain("codex_open");
    expect(line).not.toContain("codex_cloud");
  });
});
