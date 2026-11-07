import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  chatRepairBackupDir,
  currentProvider,
  rolloutExists,
  stateDatabase,
  type ChatHealthPaths,
} from "./chat-health.js";

/**
 * 修复聊天记录 for the Codex chats Codex itself will not continue: Codex app-server 0.166+
 * compares a chat's stored provider (`threads.model_provider` in its state database) with
 * config.toml's `model_provider` and refuses the resume when they differ, whatever the request
 * names. With Codex closed, the stored provider of those chats becomes the current one; nothing
 * else in the row and nothing in the conversation files changes. Codex's database is copied
 * first, and the old values are kept next to the copy so the change can be undone exactly.
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
      !Array.isArray(value.changes) ||
      !value.changes.every(
        (change) =>
          change && typeof change.id === "string" && typeof change.from === "string" && change.from,
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

async function openDatabase(file: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
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

/**
 * Sets the stored provider of every Codex chat on another provider (a configured one, or one no
 * longer configured) to the current one; chats whose conversation file is gone are left alone.
 * Codex must be closed. Returns how many chats changed.
 */
export async function repairChatProviders(paths: ChatHealthPaths, stamp: string): Promise<number> {
  if (!STAMP.test(stamp)) throw new Error("CHAT_REPAIR_STAMP_INVALID");
  const to = currentProvider(paths.codexHome);
  const database = paths.codexStateDir ? stateDatabase(paths.codexStateDir) : null;
  if (!to || !database) return 0;
  const db = await openDatabase(database);
  try {
    const rows = db
      .prepare(
        "select id, model_provider, rollout_path from threads where model_provider <> ? and model_provider <> ''",
      )
      .all(to) as unknown as { id: unknown; model_provider: unknown; rollout_path: unknown }[];
    const changes: ChatProviderChange[] = rows.flatMap((row) =>
      typeof row.id === "string" &&
      row.id &&
      typeof row.model_provider === "string" &&
      typeof row.rollout_path === "string" &&
      rolloutExists(row.rollout_path)
        ? [{ id: row.id, from: row.model_provider }]
        : [],
    );
    if (changes.length === 0) return 0;
    const backup = chatRepairBackupDir(paths, stamp);
    backUpDatabase(database, path.join(backup, "codex-state"));
    const recordFile = path.join(backup, RECORD);
    await writeRecord(recordFile, {
      schemaVersion: 1,
      at: new Date().toISOString(),
      database,
      to,
      changes,
    });
    const update = db.prepare(
      "update threads set model_provider = ? where id = ? and model_provider = ?",
    );
    let changed = 0;
    db.exec("begin immediate");
    try {
      for (const change of changes)
        changed += Number(update.run(to, change.id, change.from).changes);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      // Nothing was written: there is nothing to undo either.
      rmSync(recordFile, { force: true });
      throw error;
    }
    return changed;
  } finally {
    db.close();
  }
}

/** The newest provider change, when it has not been undone yet. */
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
    return record.undoneAt ? null : { stamp, count: record.changes.length };
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
): Promise<number> {
  if (!STAMP.test(stamp)) throw new Error("CHAT_REPAIR_STAMP_INVALID");
  const file = path.join(chatRepairBackupDir(paths, stamp), RECORD);
  const record = readRecord(file);
  if (!record || record.undoneAt) return 0;
  const database = paths.codexStateDir ? stateDatabase(paths.codexStateDir) : null;
  // Another database than the one the repair changed: nothing of it is undone.
  if (!database || path.resolve(database) !== path.resolve(record.database)) return 0;
  const db = await openDatabase(database);
  try {
    const update = db.prepare(
      "update threads set model_provider = ? where id = ? and model_provider = ?",
    );
    let restored = 0;
    db.exec("begin immediate");
    try {
      for (const change of record.changes)
        restored += Number(update.run(change.from, change.id, record.to).changes);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    await writeRecord(file, { ...record, undoneAt: new Date().toISOString() });
    return restored;
  } finally {
    db.close();
  }
}
