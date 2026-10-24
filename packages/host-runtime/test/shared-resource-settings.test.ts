import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANTIGRAVITY_SHARED_RESOURCE_REQUEST } from "@codexhost/adapter-antigravity";
import { CLAUDE_SHARED_RESOURCE_REQUEST } from "@codexhost/adapter-claude-code";
import { GROK_SHARED_CONTEXT_REQUEST, GROK_SHARED_MCP_REQUEST } from "@codexhost/adapter-grok";

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
  it("shares MCP and skills by default but keeps memory opt-in", async () => {
    const f = await fixture();
    expect(DEFAULT_SHARED_RESOURCE_SETTINGS).toEqual({ mcp: true, skills: true, memory: false });
    expect(await sharedResourceSettings(f.env)).toEqual({ mcp: true, skills: true, memory: false });
    const shared = await f.provider(f.project, CLAUDE_SHARED_RESOURCE_REQUEST);
    expect(Object.keys(shared.mcpServers).sort()).toEqual(["codex_docs", "codex_local"]);
    expect(shared.context).toContain('"name":"review"');
    expect(shared.context).not.toContain("project-memory-line");
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
      memory: 0,
    });
    const status = await sharedResourceStatus({
      environment: f.env,
      harnessId: "grok",
      cwd: f.project,
    });
    expect(status).toEqual({
      applicable: true,
      settings: { mcp: true, skills: true, memory: false },
      support: { mcp: true, skills: true, memory: true },
      blocked: null,
      delivered: { mcpServers: ["docs", "local"], skills: 1, memory: 0 },
    });
    expect(
      await sharedResourceStatus({ environment: f.env, harnessId: "pi", cwd: f.project }),
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
    const asked = (...requests: { mcp?: boolean; skills?: boolean; memory?: boolean }[]) => ({
      mcp: requests.some((request) => request.mcp === true),
      skills: requests.some((request) => request.skills === true),
      memory: requests.some((request) => request.memory === true),
    });
    expect(support["claude-code"]).toEqual(asked(CLAUDE_SHARED_RESOURCE_REQUEST));
    expect(support.grok).toEqual(asked(GROK_SHARED_MCP_REQUEST, GROK_SHARED_CONTEXT_REQUEST));
    expect(support.antigravity).toEqual(asked(ANTIGRAVITY_SHARED_RESOURCE_REQUEST));
    for (const id of ["opencode", "pi", "hermes", "cursor-cli", "kiro-cli"]) {
      expect(support[id]).toEqual({ mcp: false, skills: false, memory: false });
    }
  });
});
