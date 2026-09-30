import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  Rly0DashboardActivityDay,
  Rly0ThreadEntry,
  Rly0ThreadMoveFailureCode,
  Rly0ThreadStats,
  Rly0ThreadsListResult,
  Rly0ThreadsListTrashResult,
  Rly0ThreadsMoveResult,
} from "@codexhost/shared-contracts";
import {
  RLY0_DASHBOARD_ACTIVITY_DAYS,
  RLY0_THREADS_LIST_MAX,
  rly0ThreadRelPathSchema,
} from "@codexhost/shared-contracts";

import { resolveCodexHome } from "../rly0-mcp/file-io.js";
import { isRolloutFileName, isStrictlyInside, resolveInsideRoot, toRelPath } from "./paths.js";
import { readRolloutHeader } from "./rollout-header.js";

export interface Rly0ThreadsManagerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** Overrides `~/.rly0-hub/threads-trash` — used by tests to avoid touching the real home dir. */
  readonly trashRoot?: string;
}

/** A rollout file found on disk: `stat` data only, no content. */
export interface RolloutFileInfo {
  readonly absolutePath: string;
  readonly relPath: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/** `sessions/YYYY/MM/DD/rollout-*.jsonl` is three levels deep; allow a little slack. */
const MAX_SCAN_DEPTH = 6;
const HEADER_READ_CONCURRENCY = 16;

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** Local calendar date of a timestamp, `YYYY-MM-DD`. */
export function localDayKey(timeMs: number): string {
  const date = new Date(timeMs);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Walks `root` for `rollout-*.jsonl` files without following symlinks (a `Dirent` for a link is
 * neither a file nor a directory here) and without reading any file content.
 */
export async function scanRolloutFiles(root: string): Promise<RolloutFileInfo[]> {
  const base = path.resolve(root);
  const files: RolloutFileInfo[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const pending: Promise<void>[] = [];
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) pending.push(walk(absolutePath, depth + 1));
        continue;
      }
      if (!entry.isFile() || !isRolloutFileName(entry.name)) continue;
      const relPath = toRelPath(base, absolutePath);
      // Anything the wire contract would reject (odd characters, too deep) is left alone.
      if (!rly0ThreadRelPathSchema.safeParse(relPath).success) continue;
      pending.push(
        fs.stat(absolutePath).then(
          (stat) => {
            files.push({
              absolutePath,
              relPath,
              fileName: entry.name,
              sizeBytes: stat.size,
              mtimeMs: stat.mtimeMs,
            });
          },
          () => undefined,
        ),
      );
    }
    await Promise.all(pending);
  };
  await walk(base, 0);
  files.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.relPath.localeCompare(right.relPath),
  );
  return files;
}

export function computeThreadStats(files: readonly RolloutFileInfo[]): Rly0ThreadStats {
  const days = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.sizeBytes;
    days.add(localDayKey(file.mtimeMs));
  }
  const activeDays = days.size;
  return {
    totalThreads: files.length,
    totalBytes,
    activeDays,
    averagePerActiveDay: activeDays === 0 ? 0 : files.length / activeDays,
  };
}

/** Per-day session counts for the `days` local calendar days ending on `now`, oldest first. */
export function computeActivity(
  files: readonly RolloutFileInfo[],
  now: Date = new Date(),
  days: number = RLY0_DASHBOARD_ACTIVITY_DAYS,
): Rly0DashboardActivityDay[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = localDayKey(file.mtimeMs);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const result: Rly0DashboardActivityDay[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = localDayKey(day.getTime());
    result.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return result;
}

async function toEntries(files: readonly RolloutFileInfo[]): Promise<Rly0ThreadEntry[]> {
  const entries: Rly0ThreadEntry[] = new Array<Rly0ThreadEntry>(files.length);
  for (let start = 0; start < files.length; start += HEADER_READ_CONCURRENCY) {
    const chunk = files.slice(start, start + HEADER_READ_CONCURRENCY);
    await Promise.all(
      chunk.map(async (file, offset) => {
        let header: Awaited<ReturnType<typeof readRolloutHeader>> | null = null;
        try {
          header = await readRolloutHeader(file.absolutePath);
        } catch {
          header = null;
        }
        entries[start + offset] = {
          relPath: file.relPath,
          fileName: file.fileName,
          title: header?.firstUserMessage ?? file.fileName,
          titleFromMessage: Boolean(header?.firstUserMessage),
          ...(header?.cwd ? { cwd: header.cwd.slice(0, 4096) } : {}),
          ...(header?.startedAt ? { startedAt: header.startedAt.slice(0, 64) } : {}),
          mtimeMs: file.mtimeMs,
          sizeBytes: file.sizeBytes,
        };
      }),
    );
  }
  return entries;
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    // EXDEV: source and destination live on different filesystems/devices; rename cannot cross
    // them, so fall back to an exclusive copy followed by removing the original.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    await fs.unlink(source);
  }
}

/**
 * Lists Codex rollout files under `${CODEX_HOME:-~/.codex}/sessions/` and moves them to/from the
 * `~/.rly0-hub/threads-trash/` folder, preserving the path relative to the sessions root. Nothing
 * is ever deleted permanently here.
 */
export class Rly0ThreadsManager {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #trashRoot: string;

  constructor(options: Rly0ThreadsManagerOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#trashRoot = path.resolve(
      options.trashRoot ??
        path.join(this.#environment.HOME ?? os.homedir(), ".rly0-hub", "threads-trash"),
    );
  }

  codexHome(): string {
    return resolveCodexHome(this.#environment);
  }

  sessionsRoot(): string {
    return path.join(this.codexHome(), "sessions");
  }

  trashRoot(): string {
    return this.#trashRoot;
  }

  async scanSessions(): Promise<{ rootExists: boolean; files: RolloutFileInfo[] }> {
    const root = this.sessionsRoot();
    const rootExists = await isDirectory(root);
    return { rootExists, files: rootExists ? await scanRolloutFiles(root) : [] };
  }

  async list(limit: number = RLY0_THREADS_LIST_MAX): Promise<Rly0ThreadsListResult> {
    const cap = Math.max(1, Math.min(limit, RLY0_THREADS_LIST_MAX));
    const { rootExists, files } = await this.scanSessions();
    return {
      sessionsRoot: this.sessionsRoot(),
      rootExists,
      stats: computeThreadStats(files),
      threads: await toEntries(files.slice(0, cap)),
      truncated: files.length > cap,
    };
  }

  async listTrash(): Promise<Rly0ThreadsListTrashResult> {
    const files = (await isDirectory(this.#trashRoot))
      ? await scanRolloutFiles(this.#trashRoot)
      : [];
    return {
      trashRoot: this.#trashRoot,
      totalCount: files.length,
      threads: await toEntries(files.slice(0, RLY0_THREADS_LIST_MAX)),
      truncated: files.length > RLY0_THREADS_LIST_MAX,
    };
  }

  /** Moves session files into the trash folder. Rejects the whole call on any unsafe path. */
  trash(relPaths: readonly string[]): Promise<Rly0ThreadsMoveResult> {
    return this.#moveAll(relPaths, this.sessionsRoot(), this.#trashRoot);
  }

  /** Moves trashed session files back to their original place under the sessions folder. */
  restore(relPaths: readonly string[]): Promise<Rly0ThreadsMoveResult> {
    return this.#moveAll(relPaths, this.#trashRoot, this.sessionsRoot());
  }

  async #moveAll(
    relPaths: readonly string[],
    fromRoot: string,
    toRoot: string,
  ): Promise<Rly0ThreadsMoveResult> {
    // Validate every path up front so a single traversal attempt aborts the whole request before
    // any file has been touched.
    const plan = relPaths.map((relPath) => ({
      relPath,
      source: resolveInsideRoot(fromRoot, relPath),
      destination: resolveInsideRoot(toRoot, relPath),
    }));
    let movedCount = 0;
    const failed: { relPath: string; code: Rly0ThreadMoveFailureCode }[] = [];
    for (const { relPath, source, destination } of plan) {
      const code = await this.#moveOne(fromRoot, source, destination);
      if (code) failed.push({ relPath, code });
      else movedCount += 1;
    }
    return { movedCount, failed };
  }

  async #moveOne(
    fromRoot: string,
    source: string,
    destination: string,
  ): Promise<Rly0ThreadMoveFailureCode | null> {
    let stat;
    try {
      stat = await fs.lstat(source);
    } catch {
      return "THREAD_NOT_FOUND";
    }
    // Never follow a symlink out of the root, and never act on anything but a regular file.
    if (!stat.isFile()) return "THREAD_NOT_FOUND";
    try {
      const [realRoot, realSource] = await Promise.all([
        fs.realpath(fromRoot),
        fs.realpath(source),
      ]);
      if (!isStrictlyInside(realRoot, realSource)) throw new Error("THREAD_INVALID_PATH");
    } catch (error) {
      if (error instanceof Error && error.message === "THREAD_INVALID_PATH") throw error;
      return "THREAD_NOT_FOUND";
    }
    if (await exists(destination)) return "THREAD_ALREADY_EXISTS";
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await moveFile(source, destination);
    } catch {
      return "THREAD_MOVE_FAILED";
    }
    return null;
  }
}

const KNOWN_THREADS_ERROR_MESSAGES = new Set(["THREAD_INVALID_PATH"]);

/** Maps a rejected `Rly0ThreadsManager` call to a JSON-RPC error; unknown failures never leak detail. */
export function rly0ThreadsRpcError(error: unknown): { code: number; message: string } {
  if (error instanceof Error && KNOWN_THREADS_ERROR_MESSAGES.has(error.message)) {
    return { code: -32000, message: error.message };
  }
  return { code: -32000, message: "THREAD_OPERATION_FAILED" };
}
