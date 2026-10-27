import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Rly0SkillsManager } from "../src/rly0-skills/index.js";
import { Rly0McpManager } from "../src/rly0-mcp/index.js";
import { syncExternalMcp } from "../src/rly0-mcp/discovery.js";
import { backupAddedAt, resourceAddedAt } from "../src/resource-added-at.js";

function first<T>(entries: readonly T[]): T {
  const entry = entries[0];
  if (entry === undefined) throw new Error("Expected a synthetic fixture entry");
  return entry;
}

describe("resource addedAt (synthetic, isolated HOME)", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const managers = () => ({
    skills: new Rly0SkillsManager({ environment: env, backupRoot: path.join(root, "backups") }),
    mcp: new Rly0McpManager({ environment: env }),
  });
  async function skill(source = ".codex", name = "synthetic-skill") {
    const directory = path.join(root, source, "skills", name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: synthetic\n---\n");
    return directory;
  }
  const config = () => path.join(root, ".codex", "config.toml");
  const metadata = () => path.join(root, "hub", "resource-added-at", "skill");
  const externalFile = () => path.join(root, ".claude.json");
  async function external() {
    await fs.writeFile(
      externalFile(),
      JSON.stringify({ mcpServers: { synthetic: { command: "node" } } }),
    );
    await fs.utimes(externalFile(), 1700000000, 1700000000);
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-added-at-synthetic-"));
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

  it.each([0, NaN, -1])(
    "falls back to mtime when birthtime is unavailable (%s)",
    async (birthtimeMs) => {
      const directory = await skill();
      const stat = await fs.stat(directory);
      Object.assign(stat, { birthtimeMs, mtimeMs: 1234.75 });
      vi.spyOn(fs, "stat").mockResolvedValueOnce(stat);
      expect(await resourceAddedAt(env, "skill", "synthetic-skill", directory)).toBe(1234);
    },
  );

  it("atomically records a single value under concurrent discovery", async () => {
    const directory = await skill();
    const values = await Promise.all(
      Array.from({ length: 12 }, () => resourceAddedAt(env, "skill", "synthetic-skill", directory)),
    );
    expect(values[0]).toEqual(expect.any(Number));
    expect(new Set(values).size).toBe(1);
    expect(await fs.readdir(metadata())).toHaveLength(1);
  });

  it("refreshes the time after a same-path reinstall with a newer directory birthtime", async () => {
    const directory = await skill();
    const original = await resourceAddedAt(env, "skill", "synthetic-skill", directory);
    if (original === undefined) throw new Error("Missing synthetic timestamp");
    const stat = await fs.stat(directory);
    Object.assign(stat, { birthtimeMs: original + 5000 });
    vi.spyOn(fs, "stat").mockResolvedValueOnce(stat);
    expect(await resourceAddedAt(env, "skill", "synthetic-skill", directory)).toBe(original + 5000);
    expect(await resourceAddedAt(env, "skill", "synthetic-skill", directory)).toBe(original + 5000);
    expect(await fs.readdir(metadata())).toHaveLength(1);
  });

  it("does not infer reinstall from mtime when a directory has no birthtime", async () => {
    const directory = await skill();
    const original = await resourceAddedAt(env, "skill", "synthetic-skill", directory);
    if (original === undefined) throw new Error("Missing synthetic timestamp");
    const stat = await fs.stat(directory);
    Object.assign(stat, { birthtimeMs: 0, mtimeMs: original + 5000 });
    vi.spyOn(fs, "stat").mockResolvedValueOnce(stat);
    expect(await resourceAddedAt(env, "skill", "synthetic-skill", directory)).toBe(original);
  });

  it("omits invalid persisted metadata without overwriting it", async () => {
    const directory = await skill();
    await resourceAddedAt(env, "skill", "synthetic-skill", directory);
    const file = path.join(metadata(), first(await fs.readdir(metadata())));
    for (const value of ["invalid-json", "-1", "1.5", '"1234"']) {
      await fs.writeFile(file, value);
      expect(await resourceAddedAt(env, "skill", "synthetic-skill", directory)).toBeUndefined();
      expect(await fs.readFile(file, "utf8")).toBe(value);
    }
  });

  it("handles missing sources and invalid backup dates without inventing a time", async () => {
    expect(
      await resourceAddedAt(env, "skill", "missing", path.join(root, "missing")),
    ).toBeUndefined();
    expect(backupAddedAt("invalid")).toEqual({});
    expect(backupAddedAt("1960-01-01T00:00:00.000Z")).toEqual({});
  });

  it("initializes skills from directory birthtime and persists across edits and manager restarts", async () => {
    const directory = await skill();
    const stat = await fs.stat(directory);
    const before = await managers().skills.list();
    expect(before.installed[0]?.addedAt).toBe(
      Math.floor(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs),
    );
    await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: updated synthetic\n---\n");
    await fs.utimes(directory, 1700000000, 1700000000);
    expect((await managers().skills.list()).installed[0]?.addedAt).toBe(
      before.installed[0]?.addedAt,
    );
    expect(await fs.readdir(metadata())).toHaveLength(1);
  });

  it("tracks same-name skills separately by source path", async () => {
    await skill(".claude");
    const original = first((await managers().skills.list()).installed);
    await fs.rename(path.join(root, ".claude", "skills"), path.join(root, "saved-skills"));
    const next = await skill(".agents");
    const stat = await fs.stat(next);
    const second = first((await managers().skills.list()).installed);
    expect(second.sourcePath).not.toBe(original.sourcePath);
    expect(second.addedAt).toBe(Math.floor(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs));
    expect(await fs.readdir(metadata())).toHaveLength(2);
  });

  it.each([".codex", ".claude"])(
    "uses deactivation time for %s backups and keeps installed time after restore",
    async (source) => {
      await skill(source);
      const manager = managers().skills;
      const installed = first((await manager.list()).installed);
      const { backupId } = await manager.deactivate(installed.name);
      const backup = first((await manager.list()).backups);
      expect(backup.backupId).toBe(backupId);
      expect(backup.addedAt).toBe(Date.parse(backup.backedUpAt ?? ""));
      await manager.restore(backupId);
      expect((await managers().skills.list()).installed[0]?.addedAt).toBe(installed.addedAt);
    },
  );

  it("gives legacy directory backups their timestamp rather than directory creation time", async () => {
    const directory = path.join(root, "backups", "synthetic-20200102T030405006Z");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: synthetic\n---\n");
    expect((await managers().skills.list()).backups[0]?.addedAt).toBe(
      Date.parse("2020-01-02T03:04:05.006Z"),
    );
  });

  it("initializes Codex MCP entries from config mtime, preserving old values when a server is added", async () => {
    await fs.writeFile(config(), '[mcp_servers.old]\ncommand = "node"\n');
    await fs.utimes(config(), 1600000000, 1600000000);
    const before = await fs.readFile(config(), "utf8");
    expect((await managers().mcp.list()).servers[0]?.addedAt).toBe(1600000000000);
    expect(await fs.readFile(config(), "utf8")).toBe(before);
    await fs.appendFile(config(), '\n[mcp_servers.new]\ncommand = "node"\n');
    await fs.utimes(config(), 1700000000, 1700000000);
    const result = await managers().mcp.list();
    expect(result.servers.find((v) => v.name === "old")?.addedAt).toBe(1600000000000);
    expect(result.servers.find((v) => v.name === "new")?.addedAt).toBe(1700000000000);
  });

  it.each([false, true])(
    "uses external file mtime with Codex config present=%s",
    async (present) => {
      if (present) await fs.writeFile(config(), 'model = "synthetic"\n');
      await external();
      expect((await managers().mcp.list()).servers[0]?.addedAt).toBe(1700000000000);
      await fs.utimes(externalFile(), 1800000000, 1800000000);
      expect((await managers().mcp.list()).servers[0]?.addedAt).toBe(1700000000000);
    },
  );

  it("preserves external timestamps when the server is mirrored into Codex", async () => {
    await external();
    const original = await managers().mcp.list();
    expect(original.servers[0]?.addedAt).toBe(1700000000000);
    await syncExternalMcp(env, true);
    const mirrored = await managers().mcp.list();
    expect(mirrored.servers).toHaveLength(1);
    expect(mirrored.servers[0]?.external).toBe(true);
    expect(mirrored.servers[0]?.addedAt).toBe(1700000000000);
  });

  it("keeps lists usable without an optional timestamp when Hub metadata cannot be written", async () => {
    await skill();
    await external();
    await fs.writeFile(path.join(root, "hub"), "synthetic non-directory");
    expect((await managers().skills.list()).installed[0]).not.toHaveProperty("addedAt");
    const result = await managers().mcp.list();
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).not.toHaveProperty("addedAt");
    expect(result.parseError).toBeUndefined();
  });
});
