import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Rly0FirstRunBackup } from "../../src/rly0-maintenance/first-run-backup.js";

let root: string;
let codexHome: string;
let dataDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-first-run-backup-"));
  codexHome = path.join(root, "codex");
  dataDir = path.join(root, "hub");
  await fs.mkdir(codexHome, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function backup(now = 1_790_000_000): Rly0FirstRunBackup {
  return new Rly0FirstRunBackup({
    environment: { CODEX_HOME: codexHome, CODEXHOST_DATA_DIR: dataDir },
    now: () => now,
  });
}

describe("Rly0FirstRunBackup", () => {
  it("saves config.toml once, never auth.json, and records files that did not exist", async () => {
    await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    await fs.writeFile(path.join(codexHome, "auth.json"), '{"tokens":"secret"}');
    expect(await backup().status()).toEqual({ available: false, codexHome });

    expect(await backup().ensure()).toBe(true);
    await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "changed"\n');
    // A later run never overwrites the first copy.
    expect(await backup(1_800_000_000).ensure()).toBe(false);

    expect(await backup().status()).toEqual({
      available: true,
      codexHome,
      createdAt: 1_790_000_000,
      files: [
        { name: "config.toml", existed: true },
        { name: "AGENTS.md", existed: false },
      ],
    });
    const saved = await fs.readdir(path.join(dataDir, "backups", "pre-install"));
    expect(saved.sort()).toEqual(["config.toml", "manifest.json"]);
    expect(saved).not.toContain("auth.json");
  });

  it("restores the saved copy, removes files that did not exist, and keeps the current ones", async () => {
    await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    await fs.writeFile(path.join(codexHome, "auth.json"), "login");
    await backup().ensure();
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      'model = "relay"\n[model_providers.rly0]\nbase_url = "http://127.0.0.1:25817/v1"\n',
    );
    await fs.writeFile(path.join(codexHome, "AGENTS.md"), "# added later\n");
    await fs.writeFile(path.join(codexHome, "auth.json"), "newer login");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "relay-injection.json"), "{}");

    const result = await backup(1_795_000_000).restore();
    expect(result).toMatchObject({ ok: true, restored: ["config.toml"], removed: ["AGENTS.md"] });
    expect(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")).toBe(
      'model = "gpt-5"\n',
    );
    await expect(fs.access(path.join(codexHome, "AGENTS.md"))).rejects.toThrow();
    // The login is never touched.
    expect(await fs.readFile(path.join(codexHome, "auth.json"), "utf8")).toBe("newer login");
    await expect(fs.access(path.join(dataDir, "relay-injection.json"))).rejects.toThrow();
    // What was there just before the restore is kept for undoing it by hand.
    const safety = result.safetyBackupDir ?? "";
    expect(safety.startsWith(path.join(dataDir, "backups", "before-restore-"))).toBe(true);
    expect(await fs.readFile(path.join(safety, "config.toml"), "utf8")).toContain("rly0");
    expect(await fs.readFile(path.join(safety, "AGENTS.md"), "utf8")).toBe("# added later\n");
  });

  it("changes nothing without a complete saved copy", async () => {
    await fs.writeFile(path.join(codexHome, "config.toml"), "current\n");
    expect(await backup().restore()).toEqual({
      ok: false,
      error: "NO_BACKUP",
      restored: [],
      removed: [],
    });
    await backup().ensure();
    await fs.rm(path.join(dataDir, "backups", "pre-install", "config.toml"));
    await fs.writeFile(path.join(codexHome, "config.toml"), "changed\n");
    expect(await backup().restore()).toMatchObject({ ok: false, error: "BACKUP_INCOMPLETE" });
    expect(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")).toBe("changed\n");
  });
});
