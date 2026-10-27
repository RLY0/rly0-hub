import { externalMcpLocations, syncExternalMcp } from "../rly0-mcp/discovery.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { discoverSkills, skillRoots, within } from "../rly0-skills/discovery.js";
import { syncNativeSkills } from "./native-skills.js";
import os from "node:os";
import path from "node:path";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { openRly0MemoryStore } from "../rly0-memory/launch.js";
import { standingPreferences } from "../rly0-memory/preferences.js";

const BEGIN = "<!-- BEGIN RLY0 MANAGED STANDING PREFERENCES -->";
const END = "<!-- END RLY0 MANAGED STANDING PREFERENCES -->";
const queues = new Map<string, Promise<unknown>>();

/** The SQLite OS transaction is the ownership gate; wx files are recovery metadata only. */
async function serialized<T>(env: NodeJS.ProcessEnv, work: () => Promise<T>): Promise<T> {
  const key = resolveRly0DataDir(env),
    prior = queues.get(key) ?? Promise.resolve();
  const pending = prior
    .catch(() => undefined)
    .then(async () => {
      const lock = path.join(key, "bridge", ".native-resources.lock");
      await fs.mkdir(path.dirname(lock), { recursive: true });
      const deadline = Date.now() + 3000;
      const owner = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: randomUUID() });
      // SQLite's OS lock releases on process death. It also serializes stale-file reclamation,
      // so two recovering processes cannot unlink a newly acquired owner's wx file.
      const gate = new DatabaseSync(`${lock}.sqlite`);
      let transaction = false;
      let handle: fs.FileHandle | undefined;
      try {
        while (!transaction) {
          try {
            gate.exec("BEGIN IMMEDIATE");
            transaction = true;
          } catch (error) {
            if ((error as { errcode?: number }).errcode !== 5) throw error;
            if (Date.now() > deadline) throw new Error("GLOBAL_CONFIG_NATIVE_LOCKED");
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
        }
        while (!handle) {
          try {
            handle = await fs.open(lock, "wx", 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            // All native writers hold this transaction until their wx file is removed.
            // Once acquired, any remaining metadata is stale, even if its PID was reused or
            // cannot be probed (EPERM). A live transaction is never stolen based on time.
            await fs.unlink(lock).catch((unlinkError: NodeJS.ErrnoException) => {
              if (unlinkError.code !== "ENOENT") throw unlinkError;
            });
          }
        }
        try {
          await handle.writeFile(owner);
          return await work();
        } finally {
          await handle.close();
          if ((await fs.readFile(lock, "utf8").catch(() => "")) === owner) await fs.unlink(lock);
        }
      } finally {
        if (transaction) gate.exec("ROLLBACK");
        gate.close();
      }
    });
  queues.set(key, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(key) === pending) queues.delete(key);
  }
}

export interface NativeResourceSync {
  instructions: string[];
  synced: string[];
  skipped: string[];
  removed: string[];
}

const home = (env: NodeJS.ProcessEnv) => env.USERPROFILE ?? env.HOME ?? os.homedir();
const codexHome = (env: NodeJS.ProcessEnv) =>
  path.resolve(env.CODEX_HOME ?? path.join(home(env), ".codex"));
const exists = async (file: string) =>
  fs.lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
/** Global files receive only global preferences. Project originals arrive in scoped MCP/context. */
async function instructions(env: NodeJS.ProcessEnv, enabled: boolean): Promise<string[]> {
  const root = codexHome(env);
  const override = path.join(root, "AGENTS.override.md");
  const primary = (await exists(override)) ? override : path.join(root, "AGENTS.md");
  const rawPrefs = enabled ? (await standingPreferences(openRly0MemoryStore(env))).content : "";
  const prefs = rawPrefs
    .replaceAll(BEGIN, "&lt;!-- BEGIN RLY0 MANAGED STANDING PREFERENCES --&gt;")
    .replaceAll(END, "&lt;!-- END RLY0 MANAGED STANDING PREFERENCES --&gt;");
  const changed: string[] = [];
  for (const file of new Set([primary, path.join(root, "AGENTS.md"), override])) {
    // Old managed backups contain forgotten preference originals; no new full backups are made.
    for (const name of await fs.readdir(root).catch(() => [])) {
      if (
        !name.startsWith(`${path.basename(file)}.rly0-bak-`) ||
        !/\.rly0-bak-\d+T\d+Z$/u.test(name)
      )
        continue;
      const backup = path.join(root, name);
      const info = await fs.lstat(backup);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 512 * 1024)
        continue;
      const text = await fs.readFile(backup, "utf8");
      if (text.includes(BEGIN) && text.includes(END)) await fs.unlink(backup);
    }
    if (!(await exists(file)) && (file !== primary || !prefs)) continue;
    const stat = await fs.lstat(file).catch(() => null);
    if (
      stat &&
      (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 512 * 1024)
    )
      throw new Error("GLOBAL_CONFIG_UNSAFE_INSTRUCTIONS");
    const current = stat ? await fs.readFile(file, "utf8") : "";
    const begin = current.indexOf(BEGIN),
      end = current.indexOf(END);
    if (
      begin < 0 !== end < 0 ||
      (begin >= 0 &&
        (end < begin ||
          current.indexOf(BEGIN, begin + 1) >= 0 ||
          current.indexOf(END, end + 1) >= 0))
    )
      throw new Error("GLOBAL_CONFIG_MARKER_BROKEN");
    const block = file === primary && prefs ? `${BEGIN}\n${prefs}\n${END}` : "";
    // No trimming of the person's bytes outside the managed range.
    const start = begin > 0 && current[begin - 1] === "\n" ? begin - 1 : begin;
    const next =
      begin >= 0
        ? current.slice(0, start) +
          (block ? `${begin > 0 ? "\n" : ""}${block}` : "") +
          current.slice(end + END.length)
        : block
          ? `${stat ? `${current}\n` : ""}${block}`
          : current;
    if (current !== next) {
      if (!next && current.startsWith(BEGIN)) await fs.unlink(file);
      else {
        await fs.mkdir(root, { recursive: true });
        const temp = `${file}.rly0-tmp-${randomUUID()}`;
        try {
          await fs.writeFile(temp, next, { flag: "wx", mode: stat?.mode ?? 0o600 });
          await fs.rename(temp, file);
        } finally {
          await fs.unlink(temp).catch(() => undefined);
        }
      }
      changed.push(file);
    }
  }
  return changed;
}

/** Serialized per data directory, with the caller's isolated environment passed throughout. */
export async function syncNativeResources(
  env: NodeJS.ProcessEnv,
  settings: { memory: boolean; skills: boolean; mcp?: boolean },
): Promise<NativeResourceSync> {
  const key = resolveRly0DataDir(env);
  const completed = await serialized(env, async () => {
    const result: NativeResourceSync = {
      instructions: await instructions(env, settings.memory),
      synced: [],
      skipped: [],
      removed: [],
    };
    if (settings.mcp !== undefined) await syncExternalMcp(env, settings.mcp);
    const recoveryBlocked = await syncNativeSkills(
      path.join(codexHome(env), "skills"),
      [
        path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home(env), ".claude"), "skills"),
        path.join(home(env), ".agents", "skills"),
      ],
      path.join(key, "bridge", "native-skills.json"),
      settings.skills,
      result,
      env,
    );
    result.skipped = [...new Set(result.skipped)];
    if (recoveryBlocked) {
      const checkKey = nativeCheckKey(env);
      const state = nativeChecks.get(checkKey) ?? {};
      state.error = "GLOBAL_CONFIG_SKILL_RECOVERY_BLOCKED";
      nativeChecks.set(checkKey, state);
      throw new Error(state.error);
    }
    return result;
  });
  const state = nativeChecks.get(nativeCheckKey(env));
  if (state) delete state.error;
  return completed;
}

export async function syncNativePreferences(env: NodeJS.ProcessEnv, enabled: boolean) {
  return serialized(env, () => instructions(env, enabled));
}

const nativeChecks = new Map<
  string,
  { fingerprint?: string; pending?: Promise<void>; error?: string }
>();
const nativeCheckKey = (env: NodeJS.ProcessEnv) =>
  JSON.stringify([resolveRly0DataDir(env), codexHome(env), home(env), env.CLAUDE_CONFIG_DIR]);
export function nativeResourceSyncError(env: NodeJS.ProcessEnv): string | null {
  return nativeChecks.get(nativeCheckKey(env))?.error ?? null;
}
/** Metadata-only scan of originals; owned-copy contents are checked when synchronization runs. */
async function sourceFingerprint(
  env: NodeJS.ProcessEnv,
  settings: { memory: boolean; skills: boolean; mcp?: boolean },
) {
  const parts: unknown[] = [settings, codexHome(env), home(env), env.CLAUDE_CONFIG_DIR];
  let count = 0;
  const seen = new Set<string>();
  const allowed = await Promise.all(
    skillRoots(env).map((v) => fs.realpath(v.root).catch(() => path.resolve(v.root))),
  );
  async function visit(file: string, depth: number): Promise<void> {
    if (++count > 8192 || depth > 32) throw new Error("GLOBAL_CONFIG_SKILL_SYNC_LIMIT");
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) {
      parts.push([file, null]);
      return;
    }
    const real = await fs.realpath(file);
    const target = await fs.stat(real);
    parts.push([file, real, target.size, target.mtimeMs, target.ctimeMs, target.ino]);
    if (seen.has(real)) return;
    seen.add(real);
    if (
      target.isDirectory() &&
      (!stat.isSymbolicLink() || allowed.some((root) => within(root, real)))
    )
      for (const name of (await fs.readdir(file)).sort()) {
        if (name === ".git") continue;
        await visit(path.join(file, name), depth + 1).catch((error: NodeJS.ErrnoException) => {
          if (["ENOENT", "ELOOP"].includes(error.code ?? "")) {
            parts.push([file, name, "unavailable"]);
            return;
          }
          throw error;
        });
      }
  }
  if (settings.skills) {
    for (const skill of (await discoverSkills(env, false)).skills) await visit(skill.realPath, 0);
    await visit(path.join(resolveRly0DataDir(env), "bridge", "paused-skills.json"), 0);
  }
  if (settings.mcp) {
    for (const [, file] of externalMcpLocations(env)) await visit(file, 0);
    await visit(path.join(resolveRly0DataDir(env), "bridge", "external-mcp-controls.json"), 0);
    await visit(path.join(codexHome(env), "config.toml"), 0);
  }
  if (settings.memory)
    await visit(path.join(openRly0MemoryStore(env).directory, "records.jsonl"), 0);
  return JSON.stringify(parts);
}
/** The session path schedules this without awaiting it; Hub mutations still synchronize explicitly. */
export function syncNativeResourcesIfChanged(
  env: NodeJS.ProcessEnv,
  settings: { memory: boolean; skills: boolean; mcp?: boolean },
): Promise<void> {
  const key = nativeCheckKey(env);
  const state = nativeChecks.get(key) ?? {};
  nativeChecks.set(key, state);
  if (state.pending) return state.pending;
  const pending = (async () => {
    const fingerprint = await sourceFingerprint(env, settings);
    if (state.fingerprint === fingerprint) return;
    await syncNativeResources(env, settings);
    state.fingerprint = fingerprint;
    delete state.error;
  })().catch((error: unknown) => {
    state.error =
      error instanceof Error && /^GLOBAL_CONFIG_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "GLOBAL_CONFIG_NATIVE_SYNC_FAILED";
    throw error;
  });
  state.pending = pending;
  void pending
    .finally(() => {
      if (state.pending === pending) delete state.pending;
    })
    .catch(() => undefined);
  return pending;
}
