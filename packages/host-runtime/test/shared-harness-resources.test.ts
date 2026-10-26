import { syncNativeResourcesIfChanged } from "../src/rly0-bridge/native-resources.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  sharedResourcesProvider,
  setSharedResourcesEnabled,
  sharedResourceSettings,
} from "../src/shared-harness-resources.js";
import { installedHarnessPluginOptions } from "../src/installed-harness-plugins.js";

const roots: string[] = [];
const environments: NodeJS.ProcessEnv[] = [];
afterEach(async () => {
  for (const env of environments.splice(0))
    await syncNativeResourcesIfChanged(env, await sharedResourceSettings(env));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-synthetic-resources-"));
  roots.push(root);
  const codex = path.join(root, "codex");
  const project = path.join(root, "project");
  await fs.mkdir(path.join(codex, "memories"), { recursive: true });
  await fs.mkdir(project);
  const env = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: codex,
    CODEXHOST_DATA_DIR: path.join(root, "data"),
    RLY0_MEMORY_DIR: path.join(root, "memory"),
  };
  environments.push(env);
  return { root, codex, project, env, provider: sharedResourcesProvider(env) };
}
function payload(context: string) {
  const line = context.split("\n").find((value) => value.startsWith("{"));
  if (!line) throw new Error("Missing shared context payload");
  return JSON.parse(line);
}

describe("synthetic local shared resources", () => {
  it("skips secret-bearing skill names and descriptions while retaining a safe skill", async () => {
    const f = await fixture();
    await setSharedResourcesEnabled(f.env, true);
    for (const [directory, frontMatter] of [
      ["bad-description", 'name: example\ndescription: "API_KEY=synthetic-secret-123"'],
      ["bad-name", 'name: "API_KEY=synthetic-name-123"\ndescription: example'],
      ["safe", "name: synthetic-safe\ndescription: Project reference"],
    ] as const) {
      const folder = path.join(f.codex, "skills", directory);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(
        path.join(folder, "SKILL.md"),
        `---\n${frontMatter}\n---\nSynthetic content`,
      );
    }
    const result = await f.provider(f.project);
    expect(result.context).not.toMatch(/synthetic-secret|synthetic-name/);
    expect(payload(result.context).skills.map((s: { name: string }) => s.name)).toEqual([
      "synthetic-safe",
    ]);
    expect(payload(result.context).notices).toContain(
      "Potentially sensitive skill metadata skipped",
    );
  });
  it("omits credential assignments and common token formats before serializing model context", async () => {
    const f = await fixture();
    await setSharedResourcesEnabled(f.env, true);
    await fs.mkdir(path.join(f.project, ".rly0"));
    await fs.writeFile(
      path.join(f.project, ".rly0/shared-memory.md"),
      [
        "keep-synthetic-project-context",
        "API_KEY=synthetic-secret-123",
        '"access_token": "synthetic-access-123"',
        "OPENAI_API_KEY = synthetic-openai-key",
        "Unexpected token ghp_SYNTHETIC1234567890",
        "Authorization: Basic synthetic-basic",
      ].join("\n"),
    );
    const result = await f.provider(f.project);
    expect(result.context).not.toMatch(
      /synthetic-secret|synthetic-access|synthetic-openai|ghp_SYNTHETIC|synthetic-basic/,
    );
    expect(payload(result.context).memory[0].content).toContain("keep-synthetic-project-context");
    expect(payload(result.context).notices).toContain(
      "Potential credentials removed from reference memory",
    );
  });
  it("shares MCP and skills by default, can be turned off, and is unavailable to remote Hosts", async () => {
    const f = await fixture();
    const shared = await f.provider(f.project);
    expect(shared.context).toContain("reference data");
    expect(payload(shared.context).memory).toEqual([]);
    expect(
      installedHarnessPluginOptions(f.env, true).pluginContext?.sharedResources,
    ).toBeUndefined();
    await setSharedResourcesEnabled(f.env, false);
    expect(await f.provider(f.project)).toEqual({ mcpServers: {}, context: "" });
    await setSharedResourcesEnabled(f.env, true);
    expect((await f.provider(f.project)).context).toContain("reference data");
  });
  it("isolates malformed or unsupported MCP entries and keeps credentials out of model context", async () => {
    const f = await fixture();
    await setSharedResourcesEnabled(f.env, true);
    await fs.writeFile(
      path.join(f.codex, "config.toml"),
      `
[mcp_servers.bad]
url = "synthetic invalid URL"
[mcp_servers.policy]
command = "synthetic"
disabled_tools = ["write"]
[mcp_servers.good]
url = "https://synthetic.invalid/mcp"
bearer_token_env_var = "SYNTHETIC_AUTH"
`,
    );
    const result = await sharedResourcesProvider({ ...f.env, SYNTHETIC_AUTH: "synthetic-secret" })(
      f.project,
    );
    expect(Object.keys(result.mcpServers)).toEqual(["codex_good"]);
    expect(result.mcpServers.codex_good).toMatchObject({
      headers: { Authorization: "Bearer synthetic-secret" },
    });
    expect(result.context).not.toContain("synthetic-secret");
    expect(payload(result.context).notices).toHaveLength(2);
  });
  it("includes only the exact project scope and general preferences, with valid redacted JSON", async () => {
    const f = await fixture();
    await setSharedResourcesEnabled(f.env, true);
    const canonical = await fs.realpath(f.project);
    await fs.mkdir(path.join(f.project, ".rly0"));
    await fs.writeFile(
      path.join(f.project, ".rly0/shared-memory.md"),
      "synthetic Bearer token-value and Basic abc123==",
    );
    await fs.writeFile(
      path.join(f.codex, "memories/memory_summary.md"),
      "## User Profile\nprivate-profile\n## User preferences\nsynthetic-preference\n## Other\nprivate-other",
    );
    await fs.writeFile(
      path.join(f.codex, "memories/MEMORY.md"),
      `# Task Group: current\napplies_to: cwd=${canonical} with source in another location\nsynthetic-current\n# Task Group: unrelated\napplies_to: cwd=${canonical}-other\nprivate-unrelated\n`,
    );
    const result = await f.provider(f.project);
    const data = payload(result.context);
    expect(data.memory).toHaveLength(3);
    expect(result.context).toContain("synthetic-current");
    expect(result.context).toContain("synthetic-preference");
    expect(result.context).not.toMatch(
      /private-profile|private-other|private-unrelated|token-value|abc123/,
    );
    expect(data.memory[0].content).toContain("[credential removed]");
    expect(data.truncated).toBe(false);
  });
  it("reports scope truncation rather than claiming the full index was shared", async () => {
    const f = await fixture();
    await setSharedResourcesEnabled(f.env, true);
    const canonical = await fs.realpath(f.project);
    await fs.writeFile(
      path.join(f.codex, "memories/MEMORY.md"),
      [1, 2, 3]
        .map((i) => `# Task Group: ${i}\napplies_to: cwd=${canonical}; synthetic\nentry-${i}\n`)
        .join(""),
    );
    const data = payload((await f.provider(f.project)).context);
    expect(data.memory).toHaveLength(2);
    expect(data.truncated).toBe(true);
  });
  it("rejects out-of-scope skill links and oversized MCP input", async () => {
    const f = await fixture();
    await setSharedResourcesEnabled(f.env, true);
    await fs.mkdir(path.join(f.codex, "skills/linked"), { recursive: true });
    await fs.writeFile(path.join(f.root, "SKILL.md"), "---\nname: private-outside\n---\n");
    // Directory junctions are available on Windows without changing developer mode.
    await fs.rmdir(path.join(f.codex, "skills/linked"));
    await fs.symlink(
      f.root,
      path.join(f.codex, "skills/linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.writeFile(path.join(f.codex, "config.toml"), "x".repeat(512 * 1024 + 1));
    const result = await f.provider(f.project);
    expect(payload(result.context).skills).toEqual([]);
    expect(result.mcpServers).toEqual({});
    expect(result.context).not.toContain("private-outside");
  });
});
