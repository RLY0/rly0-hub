import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  decodeHarnessPluginRoute,
  RLY0_HOME_DATA_DIRECTORY_NAME,
} from "@codexhost/shared-contracts";

/** Upstream CodexHost's data directory name (`~/.codexhost`). Only ever read, never written. */
export const LEGACY_CODEXHOST_DIRECTORY_NAME = ".codexhost";
const MARKER_FILE = ".legacy-codexhost-import.json";
/** Where a thread mapping replaced by a newer legacy copy is kept, never deleted. */
const SUPERSEDED_DIRECTORY = "legacy-superseded";
/** Top-level data folders whose files are merged in without overwriting anything. */
const MERGE_DIRECTORIES = ["antigravity-history"] as const;

export interface LegacyImportResult {
  readonly imported: boolean;
  readonly reason: string;
  /** Threads added or brought up to date in this run. */
  readonly threads?: number;
}

/**
 * Why a legacy thread is not usable in the Hub right now:
 * - `missing`: never brought over (started under CodexHost after the last sync);
 * - `outdated`: both have it, but it was continued under CodexHost afterwards;
 * - `deleted`: brought over before and later removed in the Hub. Only restored on request;
 * - `format`: already in the Hub, but its model choice is in upstream's form, so it opens and
 *   cannot be continued.
 */
export type LegacyThreadIssue = "missing" | "outdated" | "deleted" | "format";

export interface LegacyThreadCandidate {
  readonly id: string;
  readonly issue: LegacyThreadIssue;
  readonly title: string | null;
  readonly harnessId: string | null;
  readonly updatedAt: string;
}

export interface LegacySyncPlan {
  /** False when there is nothing to compare with; `reason` says why. */
  readonly available: boolean;
  readonly reason: string;
  readonly legacyThreads: number;
  /** Newest first. */
  readonly candidates: readonly LegacyThreadCandidate[];
}

/** Per legacy thread, the `updatedAt` last merged; a deleted thread only returns if it changed. */
interface SyncMarker {
  readonly version: 2;
  readonly syncedAt: string;
  readonly seen: Record<string, string>;
}

interface LegacyThread {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly updatedAt: string;
  readonly title: string | null;
  readonly harnessId: string | null;
}

interface Roots {
  readonly legacyStore: string;
  readonly store: string;
  readonly targetRoot: string;
  readonly legacyRoot: string;
}

const THREAD_ID = /^[A-Za-z0-9-]{1,128}$/u;

/**
 * Upstream CodexHost writes every agent's model choice as a generic plugin route
 * (`codexhost/plugin-v1@<hex JSON>`); the Hub writes these agents in their own
 * `codexhost/<agent>-native@…` form, and Codex's composer only understands that one. A chat with
 * the generic form opens, but shows "自定义" with a warning, cannot change model ("无法更新模型设置")
 * and cannot send. Must match `EXTERNAL_HARNESS_IDS` in protocol-core (a test checks); plugin
 * agents such as Hermes keep the generic form, which is their canonical one.
 */
export const NATIVE_ROUTE_HARNESS_IDS: readonly string[] = [
  "pi",
  "claude-code",
  "deepseek-harness",
  "opencode",
  "grok",
  "omp",
  "antigravity",
];

/**
 * Re-encodes the same selection (model, thinking, permission mode) in the Hub's form; null when
 * already canonical or unreadable. Provided by the Host runtime (it carries the encoders); the
 * Hub window's service only detects, so its bundle stays small.
 */
export type TransportCanonicalizer = (harnessId: string, transportModelId: string) => string | null;

function routeFields(record: unknown): { harnessId: string; transportModelId: string } | null {
  if (!record || typeof record !== "object") return null;
  const { harnessId, transportModelId } = record as {
    harnessId?: unknown;
    transportModelId?: unknown;
  };
  return typeof harnessId === "string" && typeof transportModelId === "string"
    ? { harnessId, transportModelId }
    : null;
}

function usesUpstreamForm(record: unknown): boolean {
  const fields = routeFields(record);
  if (!fields || !NATIVE_ROUTE_HARNESS_IDS.includes(fields.harnessId)) return false;
  try {
    return decodeHarnessPluginRoute(fields.transportModelId)?.harnessId === fields.harnessId;
  } catch {
    return false;
  }
}

/** The record with its model choice re-encoded for the Hub, or `content` unchanged. */
function canonicalContent(content: string, canonicalize?: TransportCanonicalizer): string {
  if (!canonicalize) return content;
  const value = parse(content);
  const fields = routeFields(value);
  if (!fields) return content;
  let canonical: string | null = null;
  try {
    canonical = canonicalize(fields.harnessId, fields.transportModelId);
  } catch {
    return content;
  }
  if (canonical === null || canonical === fields.transportModelId) return content;
  return `${JSON.stringify({ ...(value as object), transportModelId: canonical }, null, 2)}\n`;
}

/** Threads already in the Hub store whose model choice is still in upstream's generic form. */
function threadsNeedingFormatFix(store: string): { id: string; name: string; value: unknown }[] {
  let names: string[];
  try {
    names = readdirSync(path.join(store, "threads")).filter((name) => {
      return name.endsWith(".json") && THREAD_ID.test(name.slice(0, -5));
    });
  } catch {
    return [];
  }
  const found: { id: string; name: string; value: unknown }[] = [];
  for (const name of names) {
    const text = readText(path.join(store, "threads", name));
    const value = text === null ? null : parse(text);
    if (usesUpstreamForm(value)) found.push({ id: name.slice(0, -5), name, value });
  }
  return found;
}

/**
 * Rewrites threads and their backup copies (the store falls back to the backup when a thread
 * file is damaged, so both must be fixed). Returns how many threads changed.
 */
function fixStoredFormats(store: string, canonicalize?: TransportCanonicalizer): number {
  if (!canonicalize) return 0;
  let fixed = 0;
  for (const directory of ["threads", "backups"]) {
    let names: string[];
    try {
      names = readdirSync(path.join(store, directory)).filter((name) => {
        return name.endsWith(".json") && THREAD_ID.test(name.slice(0, -5));
      });
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(store, directory, name);
      const text = readText(file);
      if (text === null) continue;
      const next = canonicalContent(text, canonicalize);
      if (next === text) continue;
      replaceFile(file, next);
      if (directory === "threads") fixed += 1;
    }
  }
  return fixed;
}

function parse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function threadStamp(value: unknown, id: string): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { hostThreadId?: unknown; updatedAt?: unknown };
  if (record.hostThreadId !== id || typeof record.updatedAt !== "string") return null;
  return Number.isNaN(Date.parse(record.updatedAt)) ? null : record.updatedAt;
}

function readMarker(file: string): SyncMarker | null {
  const text = readText(file);
  const value = (text === null ? null : parse(text)) as Partial<SyncMarker> | null;
  if (!value || value.version !== 2 || !value.seen || typeof value.seen !== "object") return null;
  return value as SyncMarker;
}

/** Same atomic pattern as the mapping store: write next to the target, then rename over it. */
function replaceFile(target: string, content: string): void {
  const temp = `${target}.tmp-legacy-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

function copyMissing(source: string, target: string): void {
  if (!existsSync(source)) return;
  cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
}

function resolveRoots(
  environment: NodeJS.ProcessEnv,
  home: string,
): { roots: Roots } | { skip: string } {
  if (environment.CODEXHOST_DATA_DIR) return { skip: "custom-data-dir" };
  if (environment.RLY0_SKIP_LEGACY_IMPORT === "1") return { skip: "disabled" };
  const legacyRoot = path.join(home, LEGACY_CODEXHOST_DIRECTORY_NAME);
  const targetRoot = path.join(home, RLY0_HOME_DATA_DIRECTORY_NAME);
  if (path.resolve(legacyRoot) === path.resolve(targetRoot)) return { skip: "same-directory" };
  return {
    roots: {
      legacyRoot,
      targetRoot,
      legacyStore: path.join(legacyRoot, "mapping-store"),
      store: path.join(targetRoot, "mapping-store"),
    },
  };
}

function readLegacyThreads(legacyStore: string): LegacyThread[] {
  let names: string[];
  try {
    names = readdirSync(path.join(legacyStore, "threads")).filter((name) => {
      return name.endsWith(".json") && THREAD_ID.test(name.slice(0, -5));
    });
  } catch {
    return [];
  }
  const threads: LegacyThread[] = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    const content = readText(path.join(legacyStore, "threads", name));
    if (content === null) continue;
    const value = parse(content);
    const updatedAt = threadStamp(value, id);
    if (updatedAt === null) continue;
    const record = value as { title?: unknown; harnessId?: unknown };
    threads.push({
      id,
      name,
      content,
      updatedAt,
      title: typeof record.title === "string" ? record.title.slice(0, 200) : null,
      harnessId: typeof record.harnessId === "string" ? record.harnessId.slice(0, 64) : null,
    });
  }
  return threads;
}

function classify(
  thread: LegacyThread,
  store: string,
  seen: Record<string, string>,
): LegacyThreadIssue | null {
  const targetText = readText(path.join(store, "threads", thread.name));
  if (targetText === null) {
    // Merged before at this exact version and gone now: the user removed it in the Hub.
    return seen[thread.id] === thread.updatedAt ? "deleted" : "missing";
  }
  const ours = threadStamp(parse(targetText), thread.id);
  if (ours !== null && Date.parse(ours) >= Date.parse(thread.updatedAt)) return null;
  return "outdated";
}

/**
 * Read-only: which chats with Claude Code and the other agents started under upstream CodexHost
 * (`~/.codexhost`) RLY/0 Hub (`~/.rly0-hub`) cannot open, or would open in an older state.
 */
export function planLegacyCodexHostSync(
  environment: NodeJS.ProcessEnv,
  options: { readonly home?: string } = {},
): LegacySyncPlan {
  const resolved = resolveRoots(environment, options.home ?? os.homedir());
  if ("skip" in resolved) {
    return { available: false, reason: resolved.skip, legacyThreads: 0, candidates: [] };
  }
  const { legacyStore, store } = resolved.roots;
  const threads = readLegacyThreads(legacyStore);
  const seen = readMarker(path.join(store, MARKER_FILE))?.seen ?? {};
  const candidates: LegacyThreadCandidate[] = [];
  for (const thread of threads) {
    const issue = classify(thread, store, seen);
    if (issue === null) continue;
    candidates.push({
      id: thread.id,
      issue,
      title: thread.title,
      harnessId: thread.harnessId,
      updatedAt: thread.updatedAt,
    });
  }
  const listed = new Set(candidates.map((c) => c.id));
  for (const thread of threadsNeedingFormatFix(store)) {
    if (listed.has(thread.id)) continue; // Its legacy copy is being brought over and fixed anyway.
    const record = thread.value as { title?: unknown; harnessId?: unknown; updatedAt?: unknown };
    candidates.push({
      id: thread.id,
      issue: "format",
      title: typeof record.title === "string" ? record.title.slice(0, 200) : null,
      harnessId: typeof record.harnessId === "string" ? record.harnessId.slice(0, 64) : null,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    });
  }
  if (threads.length === 0 && candidates.length === 0) {
    return { available: false, reason: "no-legacy-threads", legacyThreads: 0, candidates: [] };
  }
  candidates.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return { available: true, reason: "ok", legacyThreads: threads.length, candidates };
}

/**
 * Keeps chats with Claude Code and the other agents that were started under upstream CodexHost
 * (`~/.codexhost`) visible and resumable in RLY/0 Hub (`~/.rly0-hub`). Both can be installed and
 * either can open Codex, so this runs every time the thread store opens, before it is locked, and
 * from the maintenance page's "修复聊天记录" while Codex is closed:
 *
 * - a legacy thread we do not have is copied in;
 * - a thread both have takes the legacy copy only when it is newer (it was continued there); the
 *   replaced file is kept under `mapping-store/legacy-superseded`;
 * - a legacy thread already merged at the same `updatedAt` is skipped, so a thread deleted in the
 *   Hub stays deleted unless it was continued under CodexHost afterwards, or `includeDeleted` is
 *   set (the user asked for it on the maintenance page).
 *
 * The legacy directory is only read. Failures never block startup.
 */
export function importLegacyCodexHostData(
  environment: NodeJS.ProcessEnv,
  options: {
    readonly home?: string;
    readonly now?: () => Date;
    readonly includeDeleted?: boolean;
    /** Without it, chats in upstream's model-route form are brought over but not rewritten. */
    readonly canonicalize?: TransportCanonicalizer;
  } = {},
): LegacyImportResult {
  const resolved = resolveRoots(environment, options.home ?? os.homedir());
  if ("skip" in resolved) return { imported: false, reason: resolved.skip };
  const { legacyRoot, targetRoot, legacyStore, store } = resolved.roots;
  const threads = readLegacyThreads(legacyStore);
  if (threads.length === 0) {
    // Imported earlier and the old CodexHost removed since: still repair what was brought over.
    let fixed = 0;
    try {
      fixed = fixStoredFormats(store, options.canonicalize);
    } catch {
      return { imported: false, reason: "copy-failed" };
    }
    return fixed > 0
      ? { imported: true, reason: "imported", threads: fixed }
      : { imported: false, reason: "no-legacy-threads" };
  }

  const markerPath = path.join(store, MARKER_FILE);
  const seen: Record<string, string> = { ...(readMarker(markerPath)?.seen ?? {}) };
  const now = (options.now ?? (() => new Date()))();
  let merged = 0;
  try {
    mkdirSync(path.join(store, "threads"), { recursive: true });
    for (const thread of threads) {
      const issue = classify(thread, store, seen);
      if (issue === null || (issue === "deleted" && !options.includeDeleted)) {
        seen[thread.id] = thread.updatedAt;
        continue;
      }
      const target = path.join(store, "threads", thread.name);
      if (issue === "outdated") {
        const keep = path.join(store, SUPERSEDED_DIRECTORY);
        mkdirSync(keep, { recursive: true });
        cpSync(target, path.join(keep, `${thread.id}.${now.getTime()}.json`), { force: false });
      }
      replaceFile(target, canonicalContent(thread.content, options.canonicalize));
      copyMissing(
        path.join(legacyStore, "backups", thread.name),
        path.join(store, "backups", thread.name),
      );
      seen[thread.id] = thread.updatedAt;
      merged += 1;
    }
    // Also covers backup copies just brought over and chats imported by older Hub versions.
    merged += fixStoredFormats(store, options.canonicalize);
    copyMissing(path.join(legacyStore, "delegations"), path.join(store, "delegations"));
    for (const name of MERGE_DIRECTORIES) {
      copyMissing(path.join(legacyRoot, name), path.join(targetRoot, name));
    }
    const marker: SyncMarker = { version: 2, syncedAt: now.toISOString(), seen };
    replaceFile(markerPath, `${JSON.stringify(marker)}\n`);
    return merged > 0
      ? { imported: true, reason: "imported", threads: merged }
      : { imported: false, reason: "up-to-date" };
  } catch {
    // Best effort: what was merged stays merged; the next start tries the rest again.
    return { imported: merged > 0, reason: "copy-failed", threads: merged };
  }
}
