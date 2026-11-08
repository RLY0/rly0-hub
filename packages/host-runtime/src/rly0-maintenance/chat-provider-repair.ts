import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  chatRepairBackupDir,
  currentProvider,
  rolloutExists,
  stateDatabase,
  withCodexDatabase,
  type ChatHealthPaths,
} from "./chat-health.js";

/**
 * 修复聊天记录 for the Codex chats Codex itself will not continue: Codex app-server 0.166+
 * compares a chat's stored provider (`threads.model_provider` in its state database) with the
 * current one and refuses the resume when they differ (an empty or unconfigured stored provider is
 * refused too), whatever the request names. With Codex closed and nothing else holding the
 * database, the stored provider of those chats becomes the current one; nothing else in the row and
 * nothing in the conversation files changes. Codex's database is copied first, and the old values
 * are kept next to the copy so the change can be undone exactly.
 */

const RECORD = "provider-changes.json";
const STAMP = /^\d{8}T\d{6,12}Z$/u;

export interface ChatProviderChange {
  readonly id: string;
  readonly from: string;
}

interface ProviderRecord {
  readonly schemaVersion: 1;
  readonly at: string;
  readonly database: string;
  readonly to: string;
  readonly changes: readonly ChatProviderChange[];
  readonly undoneAt?: string;
}

/** A provider change that can still be undone (the newest one, when not undone already). */
export interface ChatProviderUndo {
  readonly stamp: string;
  readonly count: number;
}

function readRecord(file: string): ProviderRecord | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<ProviderRecord>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.database !== "string" ||
      typeof value.to !== "string" ||
      !value.to ||
      !Array.isArray(value.changes) ||
      !value.changes.every(
        (change) => change && typeof change.id === "string" && typeof change.from === "string",
      )
    )
      return null;
    return value as ProviderRecord;
  } catch {
    return null;
  }
}

async function writeRecord(file: string, record: ProviderRecord): Promise<void> {
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Whether another process has one of these files open. Rejects when that cannot be told, which
 * counts as "in use".
 */
export type DatabaseInUse = (files: readonly string[]) => Promise<boolean>;

/** macOS: `lsof` lists the processes; status 1 with no output means none. */
function lsofInUse(files: readonly string[]): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile("/usr/sbin/lsof", ["-t", "--", ...files], { timeout: 10_000 }, (error, stdout) => {
      const others = String(stdout ?? "")
        .split(/\s+/u)
        .map(Number)
        .some((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
      if (others) resolve(true);
      else if (!error || (error as { code?: unknown }).code === 1) resolve(false);
      else reject(error);
    });
  });
}

/** libuv's exclusive sharing mode on Windows: the open fails (EBUSY) while anyone has the file. */
const UV_FS_O_EXLOCK = 0x10000000;

function exclusiveOpenInUse(files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | UV_FS_O_EXLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return Promise.resolve(true);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    closeSync(fd);
  }
  return Promise.resolve(false);
}

const platformInUse: DatabaseInUse = (files) =>
  process.platform === "darwin"
    ? lsofInUse(files)
    : process.platform === "win32"
      ? exclusiveOpenInUse(files)
      : Promise.resolve(false);

export interface ChatProviderRepairOptions {
  /** Whether another process has Codex's database open (tests); lsof / exclusive open otherwise. */
  readonly inUse?: DatabaseInUse;
  /** How long to wait for it to be let go (default 15 s). */
  readonly waitMs?: number;
  /** SQLite busy timeout of this module's connections (default 5 s). */
  readonly busyTimeoutMs?: number;
}

function databaseInUse(database: string, options: ChatProviderRepairOptions): Promise<boolean> {
  const files = [database, `${database}-wal`].filter((file) => existsSync(file));
  if (files.length === 0) return Promise.resolve(false);
  return (options.inUse ?? platformInUse)(files).catch(() => true);
}

/** Waits until nothing else has the database open; CODEX_DATABASE_IN_USE when it stays open. */
async function waitUntilFree(database: string, options: ChatProviderRepairOptions): Promise<void> {
  const deadline = Date.now() + (options.waitMs ?? 15_000);
  while (await databaseInUse(database, options)) {
    if (Date.now() >= deadline) throw new Error("CODEX_DATABASE_IN_USE");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** How many of these chats are on `provider` now. */
async function countOn(
  database: string,
  ids: readonly string[],
  provider: string,
  options: ChatProviderRepairOptions,
): Promise<number> {
  const db = await openDatabase(database, options);
  try {
    const query = db.prepare(
      "select count(*) as n from threads where id = ? and model_provider = ?",
    );
    let n = 0;
    for (const id of ids) n += Number((query.get(id, provider) as { n: unknown }).n);
    return n;
  } finally {
    db.close();
  }
}

async function openDatabase(file: string, options: ChatProviderRepairOptions) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5_000))}`);
  return db;
}

/** Copies Codex's state database with its WAL / shared-memory files into `target`. */
function backUpDatabase(database: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${database}${suffix}`;
    if (existsSync(file)) copyFileSync(file, path.join(target, path.basename(file)));
  }
}

/** The chats to move: not on `to`, and whose conversation file is still there. */
async function pendingChanges(
  database: string,
  to: string,
  options: ChatProviderRepairOptions,
): Promise<ChatProviderChange[]> {
  const db = await openDatabase(database, options);
  try {
    const rows = db
      .prepare("select id, model_provider, rollout_path from threads where model_provider <> ?")
      .all(to) as unknown as { id: unknown; model_provider: unknown; rollout_path: unknown }[];
    return rows.flatMap((row) =>
      typeof row.id === "string" &&
      row.id &&
      typeof row.model_provider === "string" &&
      typeof row.rollout_path === "string" &&
      rolloutExists(row.rollout_path)
        ? [{ id: row.id, from: row.model_provider }]
        : [],
    );
  } finally {
    db.close();
  }
}

/** Sets each chat still on `from` to `to`, in one transaction. Returns how many changed. */
async function rewriteProviders(
  database: string,
  rows: readonly { readonly id: string; readonly from: string; readonly to: string }[],
  options: ChatProviderRepairOptions,
): Promise<number> {
  const db = await openDatabase(database, options);
  try {
    const update = db.prepare(
      "update threads set model_provider = ? where id = ? and model_provider = ?",
    );
    let open = false;
    try {
      db.exec("begin immediate");
      open = true;
      let changed = 0;
      for (const row of rows) changed += Number(update.run(row.to, row.id, row.from).changes);
      db.exec("commit");
      open = false;
      return changed;
    } catch (error) {
      if (open) {
        try {
          db.exec("rollback");
        } catch {
          // Closing the connection rolls back what is left.
        }
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * Sets the stored provider of every Codex chat on another provider (a configured one, one no
 * longer configured, or none) to the current one; chats whose conversation file is gone are left
 * alone. Codex must be closed. Returns how many chats changed.
 */
export async function repairChatProviders(
  paths: ChatHealthPaths,
  stamp: string,
  options: ChatProviderRepairOptions = {},
): Promise<number> {
  if (!STAMP.test(stamp)) throw new Error("CHAT_REPAIR_STAMP_INVALID");
  const to = currentProvider(paths.codexHome);
  const database = paths.codexStateDir ? stateDatabase(paths.codexStateDir) : null;
  if (!to || !database) return 0;
  return withCodexDatabase(async () => {
    // Codex's app-server keeps its own copy of these rows: nothing is written while anything else
    // has the database open.
    await waitUntilFree(database, options);
    const changes = await pendingChanges(database, to, options);
    if (changes.length === 0) return 0;
    // No connection of ours is open while copying (see withCodexDatabase).
    const backup = chatRepairBackupDir(paths, stamp);
    backUpDatabase(database, path.join(backup, "codex-state"));
    // Opened by something else while it was copied: nothing is written.
    if (await databaseInUse(database, options)) throw new Error("CODEX_DATABASE_IN_USE");
    const recordFile = path.join(backup, RECORD);
    await writeRecord(recordFile, {
      schemaVersion: 1,
      at: new Date().toISOString(),
      database,
      to,
      changes,
    });
    try {
      return await rewriteProviders(
        database,
        changes.map((change) => ({ id: change.id, from: change.from, to })),
        options,
      );
    } catch (error) {
      // The record stays only when part of the change landed anyway (a commit can fail after
      // writing); a record with nothing to undo would hide an earlier change's undo.
      const landed = await countOn(
        database,
        changes.map((change) => change.id),
        to,
        options,
      ).catch(() => 1);
      if (landed === 0) rmSync(recordFile, { force: true });
      throw error;
    }
  });
}

/** The database a record's changes can be undone in: the one it changed, while Codex still uses it. */
function undoableDatabase(paths: ChatHealthPaths, record: ProviderRecord | null): string | null {
  if (!record || record.undoneAt) return null;
  const database = paths.codexStateDir ? stateDatabase(paths.codexStateDir) : null;
  return database && path.resolve(database) === path.resolve(record.database) ? database : null;
}

/** The newest provider change, when it can still be undone. */
export function lastChatProviderRepair(paths: ChatHealthPaths): ChatProviderUndo | null {
  const root = path.dirname(chatRepairBackupDir(paths, "x"));
  let stamps: string[];
  try {
    stamps = readdirSync(root).filter((name) => STAMP.test(name));
  } catch {
    return null;
  }
  for (const stamp of stamps.sort().reverse()) {
    const record = readRecord(path.join(root, stamp, RECORD));
    if (!record) continue;
    return undoableDatabase(paths, record) ? { stamp, count: record.changes.length } : null;
  }
  return null;
}

/**
 * Puts the providers a repair changed back, for the chats still on the provider it set. Codex
 * must be closed. Returns how many chats changed back.
 */
export async function undoChatProviderRepair(
  paths: ChatHealthPaths,
  stamp: string,
  options: ChatProviderRepairOptions = {},
): Promise<number> {
  if (!STAMP.test(stamp)) throw new Error("CHAT_REPAIR_STAMP_INVALID");
  const file = path.join(chatRepairBackupDir(paths, stamp), RECORD);
  const record = readRecord(file);
  const database = undoableDatabase(paths, record);
  if (!record || !database) return 0;
  return withCodexDatabase(async () => {
    await waitUntilFree(database, options);
    const restored = await rewriteProviders(
      database,
      record.changes.map((change) => ({ id: change.id, from: record.to, to: change.from })),
      options,
    );
    // The providers are back even if this mark cannot be written; undoing again changes nothing.
    await writeRecord(file, { ...record, undoneAt: new Date().toISOString() }).catch(
      () => undefined,
    );
    return restored;
  });
}
