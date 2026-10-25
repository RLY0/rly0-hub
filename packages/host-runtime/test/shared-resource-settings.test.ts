import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ANTIGRAVITY_SHARED_RESOURCE_REQUEST } from "@codexhost/adapter-antigravity";
import { CLAUDE_SHARED_RESOURCE_REQUEST } from "@codexhost/adapter-claude-code";
import { GROK_SHARED_CONTEXT_REQUEST, GROK_SHARED_MCP_REQUEST } from "@codexhost/adapter-grok";
import { CURSOR_SHARED_CONTEXT_REQUEST, CURSOR_SHARED_MCP_REQUEST } from "@codexhost/adapter-cursor-cli";
import { HERMES_SHARED_CONTEXT_REQUEST, HERMES_SHARED_SKILL_REQUEST } from "@codexhost/adapter-hermes";
import { KIMI_SHARED_CONTEXT_REQUEST, KIMI_SHARED_MCP_REQUEST } from "@codexhost/adapter-kimi-code";
import { KIRO_SHARED_CONTEXT_REQUEST, KIRO_SHARED_MCP_REQUEST } from "@codexhost/adapter-kiro-cli";
import { OPENCODE_SHARED_RESOURCE_REQUEST } from "@codexhost/adapter-opencode";
import { PI_SHARED_RESOURCE_REQUEST } from "@codexhost/adapter-pi";

import { RLY0_HUB_AGENTS } from "../src/rly0-hub-service/agents.js";
import {
  DEFAULT_SHARED_RESOURCE_SETTINGS,
  lastSharedResourceDelivery,
  setSharedResourceSettings,
  sharedResourceSettings,
  sharedResourcesProvider,
} from "../src/shared-harness-resources.js";
import { sharedResourceStatus } from "../src/shared-resource-status.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-synthetic-sharing-"));
  roots.push(root);
  const codex = path.join(root, "codex");
  const project = path.join(root, "project");
  await fs.mkdir(path.join(codex, "memories"), { recursive: true });
  await fs.mkdir(path.join(codex, "skills", "review"), { recursive: true });
  await fs.mkdir(path.join(project, ".rly0"), { recursive: true });
  await fs.writeFile(
    path.join(codex, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review changes\n---\n",
  );
  await fs.writeFile(
    path.join(codex, "config.toml"),
    '[mcp_servers.docs]\nurl = "https://docs.invalid/mcp"\nbearer_token_env_var = "SYNTHETIC_AUTH"\n' +
      '[mcp_servers.local]\ncommand = "node"\nargs = ["server.js"]\nenv = { API_TOKEN = "synthetic-env-token" }\n',
  );
  await fs.writeFile(
    path.join(project, ".rly0", "shared-memory.md"),
    "project-memory-line\npassword = synthetic-password",
  );
  const env = {
    CODEX_HOME: codex,
    CODEXHOST_DATA_DIR: path.join(root, "data"),
    SYNTHETIC_AUTH: "synthetic-header-token",
  };
  return { codex, project, env, provider: sharedResourcesProvider(env) };
}

describe("Codex resource sharing settings", () => {
  it("shares MCP, skills and memory by default on a new install", async () => {
    const f = await fixture();
    expect(DEFAULT_SHARED_RESOURCE_SETTINGS).toEqual({ mcp: true, skills: true, memory: true });
    expect(await sharedResourceSettings(f.env)).toEqual({ mcp: true, skills: true, memory: true });
    const shared = await f.provider(f.project, CLAUDE_SHARED_RESOURCE_REQUEST);
    expect(Object.keys(shared.mcpServers).sort()).toEqual(["codex_docs", "codex_local"]);
    expect(shared.context).toContain('"name":"review"');
    expect(shared.context).toContain("project-memory-line");
  });

  it("keeps a 0.11.12 choice: its file had memory off unless the person turned it on", async () => {
    const f = await fixture();
    const file = path.join(f.env.CODEXHOST_DATA_DIR, "shared-resources.json");
    await fs.mkdir(f.env.CODEXHOST_DATA_DIR, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 2, mcp: false, skills: true, memory: false }));
    expect(await sharedResourceSettings(f.env)).toEqual({ mcp: false, skills: true, memory: false });
    await fs.writeFile(file, JSON.stringify({ version: 2, mcp: true }));
    expect(await sharedResourceSettings(f.env)).toEqual({ mcp: true, skills: true, memory: false });
    await fs.writeFile(file, JSON.stringify({ version: 2, mcp: true, skills: true, memory: true }));
    expect(await sharedResourceSettings(f.env)).toEqual({ mcp: true, skills: true, memory: true });
    await setSharedResourceSettings(f.env, { skills: false });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      version: 3,
      mcp: true,
      skills: false,
      memory: true,
    });
  });

  it("attaches rly0-memory to MCP agents with a one-line instruction instead of Codex files", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.codex, "memories", "MEMORY.md"),
      `# Task Group: here
applies_to: cwd=${await fs.realpath(f.project)}
## Reusable knowledge
codex-group-line
`,
    );
    const entry = pathToFileURL(path.join(f.codex, "dist", "installed-harness-plugins.js")).href;
    const provider = sharedResourcesProvider(f.env, { memoryEntryUrl: entry });
    const shared = await provider(f.project, CLAUDE_SHARED_RESOURCE_REQUEST);
    expect(shared.mcpServers.rly0_memory).toMatchObject({
      type: "stdio",
      command: process.execPath,
      args: [path.join(f.codex, "dist", "rly0-memory", "server-main.js")],
      env: {
        RLY0_MEMORY_DIR: path.join(f.env.CODEXHOST_DATA_DIR, "memory"),
        RLY0_MEMORY_AGENT: "claude-code",
      },
    });
    expect(shared.context).toContain("rly0-memory is memory shared by every AI agent");
    expect(shared.context).not.toContain("codex-group-line");
    // Antigravity cannot mount MCP: it reads a digest, which now holds the imported Codex memory.
    const turn = await provider(f.project, ANTIGRAVITY_SHARED_RESOURCE_REQUEST);
    expect(turn.mcpServers).toEqual({});
    expect(turn.context).toContain("read-only digest");
    expect(turn.context).toContain("codex-group-line");
    await setSharedResourceSettings(f.env, { memory: false });
    expect((await provider(f.project, CLAUDE_SHARED_RESOURCE_REQUEST)).mcpServers).not.toHaveProperty(
      "rly0_memory",
    );
  });

  it("returns skill folders instead of an index to agents that register skills natively", async () => {
    const f = await fixture();
    const shared = await f.provider(f.project, { harnessId: "pi", skills: true, skillFiles: true });
    expect(shared.skills).toEqual([
      { name: "review", directory: path.join(f.codex, "skills", "review") },
    ]);
    expect(shared.context).toBe("");
  });

  it("respects an explicit off from the former single switch", async () => {
    const f = await fixture();
    await fs.mkdir(f.env.CODEXHOST_DATA_DIR, { recursive: true });
    await fs.writeFile(
      path.join(f.env.CODEXHOST_DATA_DIR, "shared-resources.json"),
      JSON.stringify({ enabled: false }),
    );
    expect(await sharedResourceSettings(f.env)).toEqual({
      mcp: false,
      skills: false,
      memory: false,
    });
    expect(await f.provider(f.project, CLAUDE_SHARED_RESOURCE_REQUEST)).toEqual({
      mcpServers: {},
      context: "",
    });
  });

  it("returns only the kinds both the person and the Agent allow", async () => {
    const f = await fixture();
    await setSharedResourceSettings(f.env, { memory: true, skills: false });
    // Grok's session open: MCP only, no model context at all.
    const open = await f.provider(f.project, GROK_SHARED_MCP_REQUEST);
    expect(Object.keys(open.mcpServers)).toHaveLength(2);
    expect(open.context).toBe("");
    // Antigravity: never MCP, here memory only (skills are off).
    const turn = await f.provider(f.project, ANTIGRAVITY_SHARED_RESOURCE_REQUEST);
    expect(turn.mcpServers).toEqual({});
    expect(turn.context).toContain("project-memory-line");
    expect(turn.context).not.toContain('"name":"review"');
    expect(turn.context).not.toContain("mcpConfigured");
  });

  it("keeps MCP credentials in process configuration and out of every model context", async () => {
    const f = await fixture();
    await setSharedResourceSettings(f.env, { memory: true });
    const shared = await f.provider(f.project, CLAUDE_SHARED_RESOURCE_REQUEST);
    expect(shared.mcpServers.codex_docs).toMatchObject({
      headers: { Authorization: "Bearer synthetic-header-token" },
    });
    expect(shared.mcpServers.codex_local).toMatchObject({
      env: { API_TOKEN: "synthetic-env-token" },
    });
    expect(shared.context).toContain('"mcpConfigured":["codex_docs","codex_local"]');
    expect(shared.context).not.toMatch(/synthetic-header-token|synthetic-env-token/u);
    expect(shared.context).not.toContain("synthetic-password");
    expect(shared.context).toContain("project-memory-line");
  });

  it("records what each Agent received, merging Grok's open and prompt requests", async () => {
    const f = await fixture();
    await f.provider(f.project, GROK_SHARED_MCP_REQUEST);
    await f.provider(f.project, GROK_SHARED_CONTEXT_REQUEST);
    expect(lastSharedResourceDelivery("grok", f.project)).toMatchObject({
      mcpServers: ["docs", "local"],
      skills: 1,
      memory: 1,
    });
    const status = await sharedResourceStatus({
      environment: f.env,
      harnessId: "grok",
      cwd: f.project,
    });
    expect(status).toEqual({
      applicable: true,
      settings: { mcp: true, skills: true, memory: true },
      support: { mcp: true, skills: true, memory: true },
      blocked: null,
      delivered: { mcpServers: ["docs", "local"], skills: 1, memory: 1 },
    });
    expect(
      await sharedResourceStatus({ environment: f.env, harnessId: "zcode", cwd: f.project }),
    ).toMatchObject({ applicable: true, support: { mcp: false, skills: false, memory: false } });
    expect(
      await sharedResourceStatus({ environment: f.env, harnessId: "codex", cwd: f.project }),
    ).toMatchObject({ applicable: false });
  });

  it("lists in the Hub exactly what each adapter asks for", () => {
    const support = Object.fromEntries(
      RLY0_HUB_AGENTS.map(({ id, sharing }) => [
        id,
        { mcp: sharing.mcp, skills: sharing.skills, memory: sharing.memory },
      ]),
    );
    type Request = { mcp?: boolean; skills?: boolean; memory?: boolean; memoryMcp?: boolean };
    const asked = (...requests: Request[]) => ({
      mcp: requests.some((request) => request.mcp === true),
      skills: requests.some((request) => request.skills === true),
      memory: requests.some((request) => request.memory === true || request.memoryMcp === true),
    });
    const acp = { harnessId: "x", mcp: true, skills: true, memory: true, memoryMcp: true };
    expect(support["claude-code"]).toEqual(asked(CLAUDE_SHARED_RESOURCE_REQUEST));
    expect(support.grok).toEqual(asked(GROK_SHARED_MCP_REQUEST, GROK_SHARED_CONTEXT_REQUEST));
    expect(support.antigravity).toEqual(asked(ANTIGRAVITY_SHARED_RESOURCE_REQUEST));
    expect(support.opencode).toEqual(asked(OPENCODE_SHARED_RESOURCE_REQUEST));
    expect(support.pi).toEqual(asked(PI_SHARED_RESOURCE_REQUEST));
    expect(support.hermes).toEqual(asked(HERMES_SHARED_SKILL_REQUEST, HERMES_SHARED_CONTEXT_REQUEST));
    expect(support["cursor-cli"]).toEqual(asked(CURSOR_SHARED_MCP_REQUEST, CURSOR_SHARED_CONTEXT_REQUEST));
    expect(support["kiro-cli"]).toEqual(asked(KIRO_SHARED_MCP_REQUEST, KIRO_SHARED_CONTEXT_REQUEST));
    expect(support["kimi-code"]).toEqual(asked(KIMI_SHARED_MCP_REQUEST, KIMI_SHARED_CONTEXT_REQUEST));
    // CodeBuddy / WorkBuddy ask inline (acp-client.ts) with the same ACP shape.
    expect(support.codebuddy).toEqual(asked(acp));
    expect(support.workbuddy).toEqual(asked(acp));
    for (const id of ["deepseek-harness", "zcode", "omp", "qoder", "qoder-cn"]) {
      expect(support[id]).toEqual({ mcp: false, skills: false, memory: false });
      expect(RLY0_HUB_AGENTS.find((entry) => entry.id === id)?.sharing.note).toBeTruthy();
    }
    for (const entry of RLY0_HUB_AGENTS)
      if (Object.values(entry.sharing.modes).includes("global"))
        expect(entry.sharing.note).toContain("单独开启");
  });
});
