import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rly0SkillsManager } from "../src/rly0-skills/index.js";
import { discoverSkills, skillManifestFile } from "../src/rly0-skills/discovery.js";
import { Rly0McpManager } from "../src/rly0-mcp/index.js";
import { syncExternalMcp } from "../src/rly0-mcp/discovery.js";
import { readMcpOwnership } from "../src/rly0-mcp/ownership.js";
import { createHubManagementRoutes } from "../src/rly0-hub-service/management-routes.js";
import type { Rly0CoreBridge } from "../src/rly0-core/index.js";
import type { Rly0CodexControl } from "../src/rly0-hub-service/codex-control.js";
import { setSharedResourceSettings } from "../src/shared-harness-resources.js";
import {
  nativeResourceSyncError,
  syncNativeResources,
  syncNativeResourcesIfChanged,
} from "../src/rly0-bridge/native-resources.js";
import { rly0SkillsListResultSchema, rly0McpListResultSchema } from "@codexhost/shared-contracts";

describe("partial resource discovery failures (synthetic, isolated HOME)", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const native = () => syncNativeResources(env, { memory: false, skills: true, mcp: true });
  const skills = () =>
    new Rly0SkillsManager({ environment: env, backupRoot: path.join(root, "backups") });
  const mcp = () => new Rly0McpManager({ environment: env });
  async function skill(source: string, name: string) {
    const dir = path.join(root, source, "skills", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\nsynthetic`);
    return dir;
  }
  async function mcpFile(source: string, name: string) {
    const file = path.join(root, source);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ mcpServers: { [name]: { command: "synthetic-offline" } } }),
    );
    return file;
  }
  function failRoot(directory: string, code: string) {
    const original = fs.readdir;
    return vi.spyOn(fs, "readdir").mockImplementation(async (file, options) => {
      if (String(file) === directory)
        throw Object.assign(new Error("synthetic root failure"), { code });
      return original(file, options);
    });
  }
  function failFile(file: string, code: string) {
    const original = fs.readFile;
    return vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      if (String(target) === file)
        throw Object.assign(new Error("synthetic file failure"), { code });
      return original(target, options);
    });
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-discovery-failure-synthetic-"));
    env = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
      CODEXHOST_DATA_DIR: path.join(root, "hub"),
      RLY0_MEMORY_DIR: path.join(root, "memory"),
      RLY0_SKIP_LEGACY_IMPORT: "1",
    };
    await fs.mkdir(path.join(root, ".codex"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["UNKNOWN", "EPERM", "EACCES"])(
    "continues listing and syncing healthy roots after %s",
    async (code) => {
      await skill(".claude", "unreadable");
      await skill(".grok", "healthy");
      const failed = path.join(root, ".claude", "skills");
      const fault = failRoot(failed, code);
      const found = await discoverSkills(env);
      expect(found.skills.map((v) => v.name)).toEqual(["healthy"]);
      expect(found.skipped).toContain(failed);
      const listed = await skills().list();
      expect(listed.installed.map((v) => v.name)).toEqual(["healthy"]);
      expect(listed.native?.error).toBe("GLOBAL_CONFIG_SKILL_ROOT_UNAVAILABLE");
      expect(rly0SkillsListResultSchema.safeParse(listed).success).toBe(true);
      const synced = await native();
      expect(synced.skipped).toContain(failed);
      expect(
        await fs.readFile(path.join(root, ".codex", "skills", "healthy", "SKILL.md"), "utf8"),
      ).toContain("synthetic");
      expect(nativeResourceSyncError(env)).toBe("GLOBAL_CONFIG_SKILL_ROOT_UNAVAILABLE");
      fault.mockRestore();
      await syncNativeResourcesIfChanged(env, { memory: false, skills: true, mcp: true });
      expect(nativeResourceSyncError(env)).toBeNull();
      expect((await skills().list()).native).toBeUndefined();
    },
  );

  it("retains owned copies and ownership when their source root is unreadable", async () => {
    const original = await skill(".claude", "keep");
    await native();
    const manifest = await fs.readFile(skillManifestFile(env), "utf8");
    await skill(".grok", "new-healthy");
    failRoot(path.dirname(original), "EACCES");
    const synced = await native();
    const copy = path.join(root, ".codex", "skills", "keep");
    expect(synced.removed).not.toContain(copy);
    expect(await fs.readFile(path.join(copy, "SKILL.md"), "utf8")).toContain("synthetic");
    const owned = JSON.parse(await fs.readFile(skillManifestFile(env), "utf8")) as {
      name: string;
      source: string;
    }[];
    for (const entry of JSON.parse(manifest) as { name: string; source: string }[])
      expect(owned).toContainEqual(entry);
    expect(await fs.stat(path.join(root, ".codex", "skills", "new-healthy"))).toBeDefined();
  });

  it("does not replace copies with a same-name alternative while the owning root is unavailable", async () => {
    const original = await skill(".claude", "keep");
    await native();
    const alternative = await skill(".grok", "keep");
    await fs.writeFile(
      path.join(alternative, "SKILL.md"),
      "---\nname: replacement\n---\nsynthetic replacement",
    );
    failRoot(path.dirname(original), "UNKNOWN");
    await native();
    expect(
      await fs.readFile(path.join(root, ".codex", "skills", "keep", "SKILL.md"), "utf8"),
    ).not.toContain("replacement");
  });

  it("does not report normally absent skill roots as errors", async () => {
    await skill(".codex", "healthy");
    expect((await skills().list()).native).toBeUndefined();
    expect((await native()).skipped).toEqual([]);
  });

  it.each(["UNKNOWN", "EPERM", "EACCES"])(
    "keeps healthy MCPs and old copies when an external config returns %s",
    async (code) => {
      const failed = await mcpFile(".claude.json", "keep");
      await syncExternalMcp(env, true);
      const owner = (await readMcpOwnership(env)).keep;
      await mcpFile(".cursor/mcp.json", "healthy");
      failFile(failed, code);
      const listed = await mcp().list();
      expect(listed.servers.map((v) => v.name)).toEqual(
        expect.arrayContaining(["keep", "healthy"]),
      );
      expect(listed.native?.error).toBe("GLOBAL_CONFIG_MCP_SOURCE_UNAVAILABLE");
      expect(rly0McpListResultSchema.safeParse(listed).success).toBe(true);
      await native();
      expect((await readMcpOwnership(env)).keep).toEqual(owner);
      const text = await fs.readFile(path.join(root, ".codex", "config.toml"), "utf8");
      expect(text).toContain("mcp_servers.keep");
      expect(text).toContain("mcp_servers.healthy");
      expect(nativeResourceSyncError(env)).toBe("GLOBAL_CONFIG_MCP_SOURCE_UNAVAILABLE");
    },
  );

  it("does not let an unreadable external MCP fingerprint stop healthy skill/MCP sync", async () => {
    const failed = await mcpFile(".claude.json", "unreadable");
    await mcpFile(".cursor/mcp.json", "healthy");
    await skill(".grok", "healthy-skill");
    const original = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (file, options) => {
      if (String(file) === failed)
        throw Object.assign(new Error("synthetic lstat failure"), { code: "EPERM" });
      return original(file, options);
    });
    await syncNativeResourcesIfChanged(env, { memory: false, skills: true, mcp: true });
    expect((await mcp().list()).servers.some((v) => v.name === "healthy")).toBe(true);
    expect(await fs.stat(path.join(root, ".codex", "skills", "healthy-skill"))).toBeDefined();
    expect(nativeResourceSyncError(env)).toBe("GLOBAL_CONFIG_MCP_SOURCE_UNAVAILABLE");
  });

  it("reports malformed MCP source files while preserving their existing mirrors", async () => {
    const failed = await mcpFile(".claude.json", "keep");
    await syncExternalMcp(env, true);
    await fs.writeFile(failed, "synthetic invalid JSON");
    await native();
    expect((await mcp().list()).native?.error).toBe("GLOBAL_CONFIG_MCP_SOURCE_UNAVAILABLE");
    expect(await fs.readFile(path.join(root, ".codex", "config.toml"), "utf8")).toContain(
      "mcp_servers.keep",
    );
  });

  it("returns partial lists and warning codes through the Hub routes", async () => {
    await skill(".claude", "unreadable");
    await skill(".grok", "healthy-skill");
    const failed = await mcpFile(".claude.json", "unreadable");
    await mcpFile(".cursor/mcp.json", "healthy-mcp");
    await setSharedResourceSettings(env, { memory: false, skills: true, mcp: true });
    failRoot(path.join(root, ".claude", "skills"), "UNKNOWN");
    failFile(failed, "EPERM");
    const routes = createHubManagementRoutes({
      environment: env,
      installRoot: root,
      core: {} as Rly0CoreBridge,
      codex: {} as Rly0CodexControl,
    });
    const skillList = rly0SkillsListResultSchema.parse(await routes["skills.list"]({}));
    expect(skillList.installed.map((v) => v.name)).toEqual(["healthy-skill"]);
    expect(skillList.native?.error).toBe("GLOBAL_CONFIG_SKILL_ROOT_UNAVAILABLE");
    const mcpList = rly0McpListResultSchema.parse(await routes["mcp.list"]({}));
    expect(mcpList.servers.map((v) => v.name)).toEqual(["healthy-mcp"]);
    expect(mcpList.native?.error).toBe("GLOBAL_CONFIG_MCP_SOURCE_UNAVAILABLE");
  });
});
