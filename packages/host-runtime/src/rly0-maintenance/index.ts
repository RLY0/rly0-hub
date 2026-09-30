import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  Rly0CoreStatusResult,
  Rly0MaintenanceAdviceCode,
  Rly0MaintenanceCacheEntry,
  Rly0MaintenanceCacheInfoResult,
  Rly0MaintenanceClearCacheResult,
  Rly0MaintenanceDiagnosticsResult,
  Rly0MaintenanceExportDiagnosticsResult,
  Rly0MaintenanceProcessActionResult,
} from "@codexhost/shared-contracts";

import { Rly0DashboardManager } from "../rly0-dashboard/index.js";
import {
  RLY0_MAINTENANCE_CACHE_ENTRY_NAMES,
  resolveRly0CacheEntryDir,
  resolveRly0DiagnosticsDir,
} from "./paths.js";
import { sanitizeDiagnosticsValue } from "./sanitize.js";
import type { Rly0CodexProcessControl } from "./process-control.js";

export type { Rly0CodexProcessControl } from "./process-control.js";

/** Minimal shape `Rly0MaintenanceManager` needs from `Rly0CoreBridge`; keeps tests cheap. */
export interface Rly0MaintenanceCoreStatusSource {
  status(): Promise<Rly0CoreStatusResult>;
}

export interface Rly0MaintenanceManagerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly dashboard?: Rly0DashboardManager;
  readonly core?: Rly0MaintenanceCoreStatusSource;
  readonly processControl?: Rly0CodexProcessControl;
  readonly now?: () => Date;
}

interface DirStats {
  readonly exists: boolean;
  readonly sizeBytes: number;
  readonly fileCount: number;
}

async function statDir(directory: string): Promise<DirStats> {
  let sizeBytes = 0;
  let fileCount = 0;
  let exists = false;
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    exists = true;
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(entryPath);
        sizeBytes += stat.size;
        fileCount += 1;
      }
    }
  }
  try {
    await walk(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { exists: false, sizeBytes: 0, fileCount: 0 };
  }
  return { exists, sizeBytes, fileCount };
}

function timestampForFilename(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "Z");
}

/**
 * Backs the "维护工具" (maintenance) settings page: read-only diagnostics built from the same
 * health check as the dashboard plus the optional closed-source core's status, a sanitized local
 * diagnostics export (never uploaded), housekeeping for this program's own `~/.rly0-hub` cache
 * directories only (never `~/.codex`), and best-effort injectable Codex process control.
 */
export class Rly0MaintenanceManager {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #dashboard: Rly0DashboardManager;
  readonly #core: Rly0MaintenanceCoreStatusSource | undefined;
  readonly #processControl: Rly0CodexProcessControl | undefined;
  readonly #now: () => Date;

  constructor(options: Rly0MaintenanceManagerOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#dashboard =
      options.dashboard ?? new Rly0DashboardManager({ environment: this.#environment });
    this.#core = options.core;
    this.#processControl = options.processControl;
    this.#now = options.now ?? (() => new Date());
  }

  async diagnostics(): Promise<Rly0MaintenanceDiagnosticsResult> {
    const health = await this.#dashboard.health();
    const core: Rly0CoreStatusResult = this.#core
      ? await this.#core.status()
      : { available: false };
    const advice: Rly0MaintenanceAdviceCode[] = [];
    if (!health.codexHomeExists) advice.push("CODEX_HOME_MISSING");
    if (!health.authJsonExists) advice.push("AUTH_JSON_MISSING");
    if (!health.configTomlExists) advice.push("CONFIG_TOML_MISSING");
    else if (health.configTomlParses === false) advice.push("CONFIG_TOML_INVALID");
    if (!health.sessionsDirExists) advice.push("SESSIONS_DIR_MISSING");
    if (!core.available) advice.push("CORE_UNAVAILABLE");
    return {
      generatedAt: this.#now().toISOString(),
      ...health,
      core,
      advice,
    };
  }

  async cacheInfo(): Promise<Rly0MaintenanceCacheInfoResult> {
    const entries: Rly0MaintenanceCacheEntry[] = [];
    let totalBytes = 0;
    for (const name of RLY0_MAINTENANCE_CACHE_ENTRY_NAMES) {
      const stats = await statDir(resolveRly0CacheEntryDir(this.#environment, name));
      totalBytes += stats.sizeBytes;
      entries.push({ name, ...stats });
    }
    return { entries, totalBytes };
  }

  /** Only ever removes the fixed, known-safe cache subdirectories under `~/.rly0-hub`. */
  async clearCache(): Promise<Rly0MaintenanceClearCacheResult> {
    const info = await this.cacheInfo();
    let clearedBytes = 0;
    const clearedEntries: string[] = [];
    for (const entry of info.entries) {
      if (!entry.exists || entry.sizeBytes === 0) continue;
      await fs.rm(resolveRly0CacheEntryDir(this.#environment, entry.name), {
        recursive: true,
        force: true,
      });
      clearedBytes += entry.sizeBytes;
      clearedEntries.push(entry.name);
    }
    return { clearedBytes, clearedEntries };
  }

  /**
   * Writes a sanitized JSON diagnostics bundle to `~/.rly0-hub/diagnostics/rly0-diag-<ts>.json`.
   * Never sent anywhere; the file only ever leaves the machine if the user copies it themselves.
   */
  async exportDiagnostics(): Promise<Rly0MaintenanceExportDiagnosticsResult> {
    const [diagnostics, cache] = await Promise.all([this.diagnostics(), this.cacheInfo()]);
    const payload = {
      exportedAt: this.#now().toISOString(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      diagnostics,
      cache,
    };
    const sanitized = sanitizeDiagnosticsValue(payload, os.homedir());
    const directory = resolveRly0DiagnosticsDir(this.#environment);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, `rly0-diag-${timestampForFilename(this.#now())}.json`);
    const content = `${JSON.stringify(sanitized, null, 2)}\n`;
    await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
    const stat = await fs.stat(filePath);
    return { filePath, sizeBytes: stat.size };
  }

  async forceQuitCodex(): Promise<Rly0MaintenanceProcessActionResult> {
    if (!this.#processControl) return { supported: false };
    return { supported: true, ok: await this.#processControl.forceQuit() };
  }

  async restartCodex(): Promise<Rly0MaintenanceProcessActionResult> {
    if (!this.#processControl) return { supported: false };
    return { supported: true, ok: await this.#processControl.restart() };
  }
}

/** Maps a rejected `Rly0MaintenanceManager` call to a JSON-RPC error without leaking detail. */
export function rly0MaintenanceRpcError(): { code: number; message: string } {
  return { code: -32000, message: "MAINTENANCE_OPERATION_FAILED" };
}
