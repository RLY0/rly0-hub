import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { redactMemoryText } from "./redaction.js";

/**
 * Shared memory "rly0-memory": one store for every Agent. Records are appended to
 * `records.jsonl` under a cross-process lock file; `forget` rewrites the file without the record
 * so its text really leaves the disk. Every change is listed in `audit.jsonl` without its text.
 */
export type MemoryScope = "project" | "global";
export interface MemoryRecord {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly agent: string;
  readonly thread?: string;
  readonly scope: MemoryScope;
  /** Normalized repository root for project records. */
  readonly project?: string;
  readonly time: number;
  /** "import" for records copied from Codex memories. */
  readonly source?: string;
}
export interface RememberInput {
  text: string;
  tags?: readonly string[];
  agent: string;
  thread?: string;
  scope: MemoryScope;
  /** Any folder inside the project; the repository root is used. */
  cwd?: string;
  source?: string;
}
export interface MemoryQuery {
  query?: string;
  /** Folder whose project records are included (with global ones). */
  cwd?: string;
  /**
   * "visible" (default with `cwd`): that project's and global records. "all" (default without
   * `cwd`) also lists other projects' records, for the Hub's views.
   */
  scope?: MemoryScope | "visible" | "all";
  limit?: number;
}

export const MEMORY_LIMITS = Object.freeze({
  textChars: 4000,
  tags: 8,
  tagChars: 32,
  records: 5000,
  fileBytes: 16 * 1024 * 1024,
  auditBytes: 1024 * 1024,
  results: 50,
});

export class MemoryError extends Error {
  constructor(
    readonly code:
      | "MEMORY_TEXT_EMPTY"
      | "MEMORY_TEXT_TOO_LONG"
      | "MEMORY_TAG_INVALID"
      | "MEMORY_FULL"
      | "MEMORY_LOCKED"
      | "MEMORY_PROJECT_REQUIRED",
  ) {
    super(code);
  }
}

const TAG = /^[\p{L}\p{N}_.:-]{1,32}$/u;
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 8_000;

export function normalizeProjectKey(folder: string): string {
  const normalized = path.resolve(folder).replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** The repository root containing `folder` (nearest `.git`), or the folder itself. */
export function projectRoot(folder: string, exists: (file: string) => boolean = existsSync): string {
  let current = path.resolve(folder);
  for (let depth = 0; depth < 48; depth += 1) {
    if (exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(folder);
}

function terms(query: string): string[] {
  const lowered = query.toLowerCase().trim();
  if (!lowered) return [];
  const words = lowered.split(/[\s,.;:!?，。；：！？、()（）"'`]+/u).filter((w) => w.length > 0);
  return [...new Set(words)];
}
function score(record: MemoryRecord, query: string, words: string[]): number {
  const haystack = `${record.text}\n${record.tags.join(" ")}`.toLowerCase();
  let total = haystack.includes(query.toLowerCase().trim()) ? 3 : 0;
  for (const word of words) if (haystack.includes(word)) total += 1;
  return total;
}

/** A reader holding the file open on Windows makes rename fail briefly with EPERM / EBUSY. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export class MemoryStore {
  readonly #directory: string;
  readonly #records: string;
  readonly #audit: string;
  readonly #lock: string;
  #cache: { size: number; mtimeMs: number; records: MemoryRecord[] } | null = null;

  constructor(directory: string) {
    this.#directory = path.resolve(directory);
    this.#records = path.join(this.#directory, "records.jsonl");
    this.#audit = path.join(this.#directory, "audit.jsonl");
    this.#lock = path.join(this.#directory, ".lock");
  }

  get directory(): string {
    return this.#directory;
  }

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const raw = input.text.trim();
    if (!raw) throw new MemoryError("MEMORY_TEXT_EMPTY");
    if (raw.length > MEMORY_LIMITS.textChars) throw new MemoryError("MEMORY_TEXT_TOO_LONG");
    const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
    if (tags.length > MEMORY_LIMITS.tags || tags.some((tag) => !TAG.test(tag)))
      throw new MemoryError("MEMORY_TAG_INVALID");
    if (input.scope === "project" && !input.cwd) throw new MemoryError("MEMORY_PROJECT_REQUIRED");
    const { text, redacted } = redactMemoryText(raw);
    const record: MemoryRecord = {
      id: randomUUID(),
      text,
      tags,
      agent: input.agent.slice(0, 64) || "unknown",
      ...(input.thread ? { thread: input.thread.slice(0, 128) } : {}),
      scope: input.scope,
      ...(input.scope === "project" && input.cwd
        ? { project: normalizeProjectKey(projectRoot(input.cwd)) }
        : {}),
      time: Date.now(),
      ...(input.source ? { source: input.source.slice(0, 32) } : {}),
    };
    await this.#locked(async () => {
      const existing = await this.#read();
      if (existing.length >= MEMORY_LIMITS.records) throw new MemoryError("MEMORY_FULL");
      const line = `${JSON.stringify(record)}\n`;
      const size = await fs.stat(this.#records).then((s) => s.size, () => 0);
      if (size + Buffer.byteLength(line) > MEMORY_LIMITS.fileBytes)
        throw new MemoryError("MEMORY_FULL");
      await fs.appendFile(this.#records, line, { encoding: "utf8", mode: 0o600 });
      await this.#note("remember", record, redacted);
    });
    return record;
  }

  /** Records visible from `cwd`: its project's and global ones, best match first. */
  async query(input: MemoryQuery = {}): Promise<MemoryRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, MEMORY_LIMITS.results * 10));
    const project = input.cwd ? normalizeProjectKey(projectRoot(input.cwd)) : undefined;
    const scope = input.scope ?? (project ? "visible" : "all");
    const visible = (await this.#read()).filter((record) => {
      if (scope === "global") return record.scope === "global";
      if (scope === "project") return record.scope === "project" && record.project === project;
      if (scope === "visible") return record.scope === "global" || record.project === project;
      return true;
    });
    const query = input.query?.trim() ?? "";
    const words = terms(query);
    const ranked = query
      ? visible
          .map((record) => ({ record, score: score(record, query, words) }))
          .filter((entry) => entry.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              Number(b.record.project === project) - Number(a.record.project === project) ||
              b.record.time - a.record.time,
          )
          .map((entry) => entry.record)
      : [...visible].sort((a, b) => b.time - a.time);
    return ranked.slice(0, limit).map((record) => ({ ...record, text: redactMemoryText(record.text).text }));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return (await this.#read()).find((record) => record.id === id) ?? null;
  }

  /** Removes the record's text from disk (the file is rewritten without it). */
  async forget(id: string, agent: string): Promise<boolean> {
    return this.#locked(async () => {
      const records = await this.#read();
      const target = records.find((record) => record.id === id);
      if (!target) return false;
      const kept = records.filter((record) => record.id !== id);
      const temporary = `${this.#records}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, kept.map((r) => `${JSON.stringify(r)}\n`).join(""), {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await renameWithRetry(temporary, this.#records);
      } finally {
        await fs.unlink(temporary).catch(() => undefined);
      }
      this.#cache = null;
      await this.#note("forget", { ...target, agent }, false);
      return true;
    });
  }

  async all(): Promise<MemoryRecord[]> {
    return [...(await this.#read())].sort((a, b) => b.time - a.time);
  }

  async auditTail(limit = 100): Promise<unknown[]> {
    const text = await fs.readFile(this.#audit, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
  }

  async #read(): Promise<MemoryRecord[]> {
    const stat = await fs.stat(this.#records).catch(() => null);
    if (!stat) return [];
    if (this.#cache && this.#cache.size === stat.size && this.#cache.mtimeMs === stat.mtimeMs)
      return this.#cache.records;
    if (stat.size > MEMORY_LIMITS.fileBytes * 2) throw new MemoryError("MEMORY_FULL");
    const text = await fs.readFile(this.#records, "utf8");
    const records: MemoryRecord[] = [];
    // A writer may be mid-append: an incomplete last line is skipped, not an error.
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Partial<MemoryRecord>;
        if (
          typeof value.id === "string" &&
          typeof value.text === "string" &&
          typeof value.agent === "string" &&
          typeof value.time === "number" &&
          (value.scope === "project" || value.scope === "global")
        )
          records.push({ ...value, tags: Array.isArray(value.tags) ? value.tags : [] } as MemoryRecord);
      } catch {
        /* partial line */
      }
    }
    this.#cache = { size: stat.size, mtimeMs: stat.mtimeMs, records };
    return records;
  }

  async #note(op: string, record: MemoryRecord, redacted: boolean): Promise<void> {
    const entry = {
      time: Date.now(),
      op,
      id: record.id,
      agent: record.agent,
      scope: record.scope,
      ...(record.project ? { project: record.project } : {}),
      ...(redacted ? { redacted: true } : {}),
    };
    const size = await fs.stat(this.#audit).then((s) => s.size, () => 0);
    if (size > MEMORY_LIMITS.auditBytes)
      await fs.rename(this.#audit, `${this.#audit}.1`).catch(() => undefined);
    await fs.appendFile(this.#audit, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async #locked<T>(work: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    let handle: fs.FileHandle | undefined;
    while (!handle) {
      try {
        handle = await fs.open(this.#lock, "wx", 0o600);
      } catch (error) {
        // Windows reports EPERM while another process is deleting the lock file.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
        const stat = await fs.stat(this.#lock).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(this.#lock).catch(() => undefined);
          continue;
        }
        if (Date.now() > deadline) throw new MemoryError("MEMORY_LOCKED");
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 25));
      }
    }
    try {
      await handle.writeFile(`${process.pid} ${Date.now()}`);
      return await work();
    } finally {
      await handle.close().catch(() => undefined);
      await fs.unlink(this.#lock).catch(() => undefined);
    }
  }
}
