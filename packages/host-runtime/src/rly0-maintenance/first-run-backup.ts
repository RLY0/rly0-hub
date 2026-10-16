import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  Rly0MaintenanceBackupFile,
  Rly0MaintenanceBackupStatusResult,
  Rly0MaintenanceRestoreBackupResult,
} from "@codexhost/shared-contracts";

import { resolveCodexHome } from "../rly0-mcp/file-io.js";
import { RLY0_RELAY_INJECTION_STATE_FILE_NAME } from "../rly0-relay/codex-config.js";
import { resolveRly0DataDir } from "./paths.js";

/**
 * The Codex files RLY/0 Hub may change and can put back. `auth.json` is deliberately absent: a
 * login's tokens rotate, so an old copy is usually already invalid and restoring it would sign the
 * person out. Switching accounts or signing in again is the reliable way back for the login.
 */
export const RLY0_BACKED_UP_CODEX_FILES = ["config.toml", "AGENTS.md"] as const;
type BackedUpFile = Rly0MaintenanceBackupFile;

const MANIFEST_FILE = "manifest.json";
const MAX_BACKED_UP_BYTES = 4 * 1024 * 1024;

interface Manifest {
  readonly version: 1;
  readonly createdAt: number;
  readonly files: Record<BackedUpFile, { readonly existed: boolean }>;
}

export interface Rly0FirstRunBackupOptions {
  readonly environment: NodeJS.ProcessEnv;
  /** Unix seconds. */
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/[:.]/gu, "-");
}

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_BACKED_UP_BYTES) throw new Error("BACKUP_FILE_TOO_LARGE");
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(filePath: string, content: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Keeps one copy of the Codex files RLY/0 Hub may change, taken the first time this runs, and puts
 * them back on request. Restoring first saves the current files to a separate folder, so a restore
 * can itself be undone by hand. Saved accounts, relays and keys live in RLY/0 Hub's own data and
 * are not touched.
 */
export class Rly0FirstRunBackup {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => number;

  constructor(options: Rly0FirstRunBackupOptions) {
    this.#environment = options.environment;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  backupDir(): string {
    return path.join(resolveRly0DataDir(this.#environment), "backups", "pre-install");
  }

  #codexFile(name: BackedUpFile): string {
    return path.join(resolveCodexHome(this.#environment), name);
  }

  async #readManifest(): Promise<Manifest | null> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.backupDir(), MANIFEST_FILE), "utf8");
    } catch {
      return null;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (!isRecord(value) || value.version !== 1 || typeof value.createdAt !== "number") {
        return null;
      }
      const files = isRecord(value.files) ? value.files : {};
      const entries = RLY0_BACKED_UP_CODEX_FILES.map((name) => {
        const entry = files[name];
        return [name, { existed: isRecord(entry) && entry.existed === true }] as const;
      });
      return {
        version: 1,
        createdAt: value.createdAt,
        files: Object.fromEntries(entries) as Manifest["files"],
      };
    } catch {
      return null;
    }
  }

  /** Takes the backup once; later calls do nothing. The manifest is written last. */
  async ensure(): Promise<boolean> {
    if (await this.#readManifest()) return false;
    const directory = this.backupDir();
    const files = {} as Record<BackedUpFile, { existed: boolean }>;
    for (const name of RLY0_BACKED_UP_CODEX_FILES) {
      const content = await readOptional(this.#codexFile(name));
      files[name] = { existed: content !== null };
      if (content !== null) await writeAtomic(path.join(directory, name), content);
    }
    const manifest: Manifest = { version: 1, createdAt: this.#now(), files };
    await writeAtomic(
      path.join(directory, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return true;
  }

  async status(): Promise<Rly0MaintenanceBackupStatusResult> {
    const manifest = await this.#readManifest();
    const codexHome = resolveCodexHome(this.#environment);
    if (!manifest) return { available: false, codexHome };
    return {
      available: true,
      codexHome,
      createdAt: manifest.createdAt,
      files: RLY0_BACKED_UP_CODEX_FILES.map((name) => ({
        name,
        existed: manifest.files[name].existed,
      })),
    };
  }

  async restore(): Promise<Rly0MaintenanceRestoreBackupResult> {
    const manifest = await this.#readManifest();
    if (!manifest) return { ok: false, error: "NO_BACKUP", restored: [], removed: [] };
    const directory = this.backupDir();
    // Verify every saved copy is readable before changing anything.
    const saved = new Map<BackedUpFile, Buffer>();
    for (const name of RLY0_BACKED_UP_CODEX_FILES) {
      if (!manifest.files[name].existed) continue;
      const content = await readOptional(path.join(directory, name));
      if (content === null)
        return { ok: false, error: "BACKUP_INCOMPLETE", restored: [], removed: [] };
      saved.set(name, content);
    }

    const safetyDir = path.join(
      resolveRly0DataDir(this.#environment),
      "backups",
      `before-restore-${timestamp(this.#now())}`,
    );
    for (const name of RLY0_BACKED_UP_CODEX_FILES) {
      const current = await readOptional(this.#codexFile(name));
      if (current !== null) await writeAtomic(path.join(safetyDir, name), current);
    }

    const restored: BackedUpFile[] = [];
    const removed: BackedUpFile[] = [];
    for (const name of RLY0_BACKED_UP_CODEX_FILES) {
      const target = this.#codexFile(name);
      const content = saved.get(name);
      if (content !== undefined) {
        await writeAtomic(target, content);
        restored.push(name);
      } else {
        try {
          await fs.rm(target);
          removed.push(name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    // The relay injection record describes a config.toml that no longer exists.
    await fs.rm(
      path.join(resolveRly0DataDir(this.#environment), RLY0_RELAY_INJECTION_STATE_FILE_NAME),
      {
        force: true,
      },
    );
    return { ok: true, restored, removed, safetyBackupDir: safetyDir };
  }
}
