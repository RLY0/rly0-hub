import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { RLY0_HOME_DATA_DIRECTORY_NAME } from "@codexhost/shared-contracts";

/**
 * Why a chat cannot be opened or continued, beyond the legacy CodexHost import
 * (`legacy-codexhost-import.ts`):
 * - `record-damaged`: the Hub's record of an agent chat is unreadable and its backup copy is
 *   fine (repairable: the backup is put back);
 * - `record-lost`: unreadable, and so is (or there is no) backup;
 * - `stuck-creating`: the chat was never finished being created;
 * - `session-missing`: the agent's own conversation file is gone (Claude Code keeps it under
 *   `~/.claude/projects`; it may have been cleaned up there), so the history cannot be shown;
 * - `codex-rollout-missing`: Codex's own list points at a conversation file that is gone;
 * - `codex-provider-missing`: a Codex chat made with a model provider no longer configured;
 * - `codex-unlisted-rollout`: a Codex conversation file Codex's list does not know.
 * Only `record-damaged` is written by the Hub; the rest are reported, never touched (the agents'
 * and Codex's own files are theirs).
 */
export type ChatHealthKind =
  | "record-damaged"
  | "record-lost"
  | "stuck-creating"
  | "session-missing"
  | "codex-rollout-missing"
  | "codex-provider-missing"
  | "codex-unlisted-rollout";

export interface ChatHealthItem {
  readonly id: string;
  readonly title: string | null;
  readonly harnessId: string | null;
  readonly updatedAt: string;
  readonly archived?: boolean;
}

export interface ChatHealthGroup {
  readonly kind: ChatHealthKind;
  readonly count: number;
  /** Of `count`, how many are archived (hidden in the sidebar anyway). */
  readonly archived: number;
  readonly repairable: boolean;
  /** Newest first, at most 20. */
  readonly items: readonly ChatHealthItem[];
}

export interface ChatHealthScan {
  /** Agent chats (Claude Code and the others) in the Hub's store. */
  readonly agentChats: number;
  /** Codex's own chats; null when Codex's list could not be read. */
  readonly codexChats: number | null;
  readonly groups: readonly ChatHealthGroup[];
}

export interface ChatHealthPaths {
  readonly store: string;
  readonly dataDir: string;
  readonly codexHome: string;
  readonly claudeConfig: string;
}

const THREAD_FILE = /^[A-Za-z0-9._~-]{1,128}\.json$/u;
const ROLLOUT_ID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/u;
const MAX_ITEMS = 20;
const REPAIRABLE: ReadonlySet<ChatHealthKind> = new Set(["record-damaged"]);
/** Same name as the sandbox runtime's settings file: present means Claude Code may run isolated. */
const ISOLATION_SETTINGS_FILE = "claude-isolation.json";

export function chatHealthPaths(environment: NodeJS.ProcessEnv, home: string): ChatHealthPaths {
  const dataDir = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(home, RLY0_HOME_DATA_DIRECTORY_NAME);
  return {
    dataDir,
    store: path.join(dataDir, "mapping-store"),
    codexHome: environment.CODEX_HOME
      ? path.resolve(environment.CODEX_HOME)
      : path.join(home, ".codex"),
    claudeConfig: environment.CLAUDE_CONFIG_DIR
      ? path.resolve(environment.CLAUDE_CONFIG_DIR)
      : path.join(home, ".claude"),
  };
}

interface StoredThread {
  readonly hostThreadId: string;
  readonly harnessId?: unknown;
  readonly title?: unknown;
  readonly updatedAt?: unknown;
  readonly state?: unknown;
  readonly archived?: unknown;
  readonly cwd?: unknown;
  readonly nativeSessionRef?: { nativeSessionId?: unknown; locator?: unknown };
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function list(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** What the store needs to use a record at all; the store validates the rest itself. */
function readRecord(file: string, id: string): StoredThread | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<StoredThread> | null;
    return value && typeof value === "object" && value.hostThreadId === id
      ? (value as StoredThread)
      : null;
  } catch {
    return null;
  }
}

function itemOf(record: StoredThread | null, id: string): ChatHealthItem {
  const text = (value: unknown, max: number) =>
    typeof value === "string" ? value.slice(0, max) : null;
  return {
    id,
    title: text(record?.title, 200),
    harnessId: text(record?.harnessId, 64),
    updatedAt: text(record?.updatedAt, 64) ?? "",
    ...(record?.archived === true ? { archived: true } : {}),
  };
}

class Groups {
  readonly #items = new Map<ChatHealthKind, ChatHealthItem[]>();
  add(kind: ChatHealthKind, item: ChatHealthItem): void {
    const items = this.#items.get(kind) ?? [];
    items.push(item);
    this.#items.set(kind, items);
  }
  result(): ChatHealthGroup[] {
    return [...this.#items].map(([kind, items]) => {
      items.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
      return {
        kind,
        count: items.length,
        archived: items.filter((item) => item.archived).length,
        repairable: REPAIRABLE.has(kind),
        items: items.slice(0, MAX_ITEMS),
      };
    });
  }
}

function claudeTranscriptExists(claudeConfig: string, cwd: unknown, sessionId: string): boolean {
  const projects = path.join(claudeConfig, "projects");
  const name = `${sessionId}.jsonl`;
  if (
    typeof cwd === "string" &&
    existsSync(path.join(projects, cwd.replace(/[^A-Za-z0-9]/gu, "-"), name))
  )
    return true;
  return list(projects).some((project) => existsSync(path.join(projects, project, name)));
}

/** The Hub's records of agent chats. */
function scanAgentChats(paths: ChatHealthPaths, groups: Groups): number {
  const threads = path.join(paths.store, "threads");
  const names = list(threads).filter((name) => THREAD_FILE.test(name));
  // Claude Code may keep conversations inside an isolated sandbox; those cannot be checked here.
  const isolated = existsSync(path.join(paths.dataDir, ISOLATION_SETTINGS_FILE));
  const claudeHome = existsSync(path.join(paths.claudeConfig, "projects"));
  for (const name of names) {
    const id = name.slice(0, -5);
    const record = readRecord(path.join(threads, name), id);
    if (!record) {
      const backup = readRecord(path.join(paths.store, "backups", name), id);
      groups.add(backup ? "record-damaged" : "record-lost", itemOf(backup, id));
      continue;
    }
    if (record.state === "creating") {
      groups.add("stuck-creating", itemOf(record, id));
      continue;
    }
    const ref = record.nativeSessionRef;
    if (
      record.harnessId === "claude-code" &&
      !isolated &&
      claudeHome &&
      ref &&
      ref.locator === undefined &&
      typeof ref.nativeSessionId === "string" &&
      /^[A-Za-z0-9-]{1,100}$/u.test(ref.nativeSessionId) &&
      !claudeTranscriptExists(paths.claudeConfig, record.cwd, ref.nativeSessionId)
    )
      groups.add("session-missing", itemOf(record, id));
  }
  return names.length;
}

interface CodexThreadRow {
  readonly id: string;
  readonly rollout_path: string;
  readonly model_provider: string;
  readonly title: string;
  readonly archived: number;
  readonly updated_at: number;
}

function stateDatabase(codexHome: string): string | null {
  const found = list(codexHome)
    .map((name) => /^state_(\d+)\.sqlite$/u.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return found[0] ? path.join(codexHome, found[0][0]) : null;
}

/** Codex's thread list, read from a private copy so Codex's own database is never opened. */
async function readCodexThreads(codexHome: string): Promise<CodexThreadRow[] | null> {
  const database = stateDatabase(codexHome);
  if (!database) return null;
  const copy = mkdtempSync(path.join(os.tmpdir(), "rly0-chat-scan-"));
  try {
    const file = path.join(copy, path.basename(database));
    copyFileSync(database, file);
    if (existsSync(`${database}-wal`)) copyFileSync(`${database}-wal`, `${file}-wal`);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      return db
        .prepare(
          "select id, rollout_path, model_provider, title, archived, updated_at from threads",
        )
        .all() as unknown as CodexThreadRow[];
    } finally {
      db.close();
    }
  } catch {
    return null;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function configuredProviders(codexHome: string): Set<string> {
  const text = readText(path.join(codexHome, "config.toml")) ?? "";
  const names = [...text.matchAll(/^\s*\[model_providers\.(?:"([^"]+)"|([^\]\s]+))\]/gmu)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
  // Built in to Codex.
  return new Set(["openai", "ollama", "lmstudio", "oss", ...names]);
}

function rolloutExists(file: string): boolean {
  const plain = file.replace(/^\\\\\?\\/u, "");
  return (
    existsSync(plain) ||
    existsSync(`${plain}.zst`) ||
    (plain.endsWith(".zst") && existsSync(plain.slice(0, -4)))
  );
}

function rolloutIds(directory: string, into: Set<string>, depth = 0): void {
  if (depth > 5) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) rolloutIds(path.join(directory, entry.name), into, depth + 1);
    else if (entry.name.startsWith("rollout-")) {
      const id = ROLLOUT_ID.exec(entry.name)?.[1];
      if (id) into.add(id);
    }
  }
}

async function scanCodexChats(paths: ChatHealthPaths, groups: Groups): Promise<number | null> {
  const rows = await readCodexThreads(paths.codexHome);
  if (!rows) return null;
  const providers = configuredProviders(paths.codexHome);
  const known = new Set<string>();
  for (const row of rows) {
    known.add(row.id);
    const item: ChatHealthItem = {
      id: row.id,
      title: row.title ? row.title.slice(0, 200) : null,
      harnessId: "codex",
      updatedAt: Number.isFinite(row.updated_at)
        ? new Date(row.updated_at * 1000).toISOString()
        : "",
      ...(row.archived ? { archived: true } : {}),
    };
    if (!rolloutExists(row.rollout_path)) groups.add("codex-rollout-missing", item);
    else if (!providers.has(row.model_provider)) groups.add("codex-provider-missing", item);
  }
  const onDisk = new Set<string>();
  rolloutIds(path.join(paths.codexHome, "sessions"), onDisk);
  rolloutIds(path.join(paths.codexHome, "archived_sessions"), onDisk);
  for (const id of onDisk)
    if (!known.has(id))
      groups.add("codex-unlisted-rollout", { id, title: null, harnessId: "codex", updatedAt: "" });
  return rows.length;
}

/** Read-only: every chat the Hub can see, and what is wrong with the ones that are broken. */
export async function scanChatHealth(paths: ChatHealthPaths): Promise<ChatHealthScan> {
  const groups = new Groups();
  const agentChats = scanAgentChats(paths, groups);
  const codexChats = await scanCodexChats(paths, groups);
  return { agentChats, codexChats, groups: groups.result() };
}

export function chatRepairBackupDir(paths: ChatHealthPaths, stamp: string): string {
  return path.join(paths.dataDir, "chat-repair-backups", stamp);
}

/**
 * Before any repair writes: a copy of the Hub's chat records (`threads`, `backups`) as they are.
 * Returns false when the copy failed, and then nothing may be written.
 */
export function backUpChatRecords(paths: ChatHealthPaths, stamp: string): boolean {
  try {
    const target = chatRepairBackupDir(paths, stamp);
    for (const name of ["threads", "backups"]) {
      const source = path.join(paths.store, name);
      if (existsSync(source))
        cpSync(source, path.join(target, name), { recursive: true, errorOnExist: false });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts back the backup copy of each damaged agent-chat record. The damaged file is kept first
 * under `<data>/chat-repair-backups/<stamp>/`; nothing is deleted. Codex must be closed (its
 * thread store reads these files once when it starts).
 */
export function repairDamagedRecords(paths: ChatHealthPaths, stamp: string): number {
  const threads = path.join(paths.store, "threads");
  let repaired = 0;
  for (const name of list(threads).filter((entry) => THREAD_FILE.test(entry))) {
    const id = name.slice(0, -5);
    if (readRecord(path.join(threads, name), id)) continue;
    const backup = path.join(paths.store, "backups", name);
    if (!readRecord(backup, id)) continue;
    const keep = path.join(chatRepairBackupDir(paths, stamp), "damaged");
    mkdirSync(keep, { recursive: true });
    copyFileSync(path.join(threads, name), path.join(keep, name));
    const temp = path.join(threads, `${name}.tmp-repair-${process.pid}`);
    try {
      copyFileSync(backup, temp);
      renameSync(temp, path.join(threads, name));
    } finally {
      rmSync(temp, { force: true });
    }
    repaired += 1;
  }
  return repaired;
}
