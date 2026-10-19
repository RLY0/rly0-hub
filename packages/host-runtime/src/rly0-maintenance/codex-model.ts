import { promises as fs } from "node:fs";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

/**
 * "Codex 模型检查" on the maintenance page. A bridge or relay can be up and answering while still
 * refusing every task because of the model name in `config.toml` (e.g. an older Codex Web GPT and
 * `gpt-6.1-sol`: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT
 * account."). Codex records that refusal on the turn in its own session log, so this reads the
 * newest turns there (no request is sent and no login token is read) and, on request, switches
 * the default model to one from Codex's own model list, keeping a backup of `config.toml`.
 */

const REJECTED =
  /model[^"]{0,40}not supported|unsupported model|model_not_found|model[^"]{0,40}does not exist/iu;
const QUOTED_MODEL =
  /['"`‘“]([A-Za-z0-9][A-Za-z0-9._:/-]{0,79})['"`’”]\s*model|model\s*['"`‘“]([A-Za-z0-9][A-Za-z0-9._:/-]{0,79})['"`’”]/iu;
const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/u;
/** Newest session files looked at; a rejected turn shows up within the first one or two. */
const RECENT_FILES = 6;
const TAIL_BYTES = 512 * 1024;

export interface CodexModelRejection {
  /** The model the service refused, when the message names it. */
  readonly model: string | null;
  readonly at: string;
  /** The refusal, shortened; it comes from the model service, never contains credentials. */
  readonly message: string;
}

export interface CodexModelChoice {
  readonly slug: string;
  readonly name: string;
}

export interface CodexModelCheckResult {
  /** `model` in config.toml (top level, or the active profile's). */
  readonly configModel: string | null;
  /** The active profile sets its own model; switching here would not change it. */
  readonly profileModel: boolean;
  /** The newest finished turn was refused because of its model; null when it went through. */
  readonly rejection: CodexModelRejection | null;
  /** From Codex's own model list (`models_cache.json`), minus the refused one. */
  readonly choices: readonly CodexModelChoice[];
}

export interface CodexModelSetResult {
  readonly ok: boolean;
  readonly backupPath?: string;
  readonly reason?: "PROFILE_MODEL" | "UNKNOWN_MODEL" | "CONFIG_INVALID";
}

type Table = Record<string, unknown>;
const table = (value: unknown): Table | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Table) : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

async function listDescending(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).sort().reverse();
  } catch {
    return [];
  }
}

/** sessions/YYYY/MM/DD/rollout-*.jsonl, newest first. */
async function newestSessionFiles(sessions: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  for (const year of await listDescending(sessions)) {
    for (const month of await listDescending(path.join(sessions, year))) {
      for (const day of await listDescending(path.join(sessions, year, month))) {
        const directory = path.join(sessions, year, month, day);
        const names = (await listDescending(directory)).filter((n) => n.endsWith(".jsonl"));
        const stamped = await Promise.all(
          names.map(async (name) => {
            const file = path.join(directory, name);
            const stat = await fs.stat(file).catch(() => null);
            return { file, mtime: stat ? stat.mtimeMs : 0 };
          }),
        );
        stamped.sort((a, b) => b.mtime - a.mtime);
        for (const entry of stamped) {
          files.push(entry.file);
          if (files.length >= limit) return files;
        }
      }
    }
  }
  return files;
}

async function readTail(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

interface FinishedTurn {
  readonly at: string;
  readonly error: string | null;
}

function lastFinishedTurn(tail: string): FinishedTurn | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes('"task_complete"')) continue;
    let value: Table | null;
    try {
      value = table(JSON.parse(line));
    } catch {
      continue; // The first line of a tail is usually cut in half.
    }
    const payload = table(value?.payload);
    if (payload?.type !== "task_complete") continue;
    const at = text(value?.timestamp);
    if (!at || Number.isNaN(Date.parse(at))) continue;
    return { at, error: text(table(payload.error)?.message) };
  }
  return null;
}

export function rejectedModel(message: string): CodexModelRejection["model"] | undefined {
  if (!REJECTED.test(message)) return undefined;
  const match = QUOTED_MODEL.exec(message);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

export async function findModelRejection(codexHome: string): Promise<CodexModelRejection | null> {
  let latest: FinishedTurn | null = null;
  for (const file of await newestSessionFiles(path.join(codexHome, "sessions"), RECENT_FILES)) {
    const turn = lastFinishedTurn(await readTail(file).catch(() => ""));
    if (turn && (!latest || Date.parse(turn.at) > Date.parse(latest.at))) latest = turn;
  }
  if (!latest?.error) return null;
  const model = rejectedModel(latest.error);
  if (model === undefined) return null;
  // The service's own JSON wrapper is noise for the user.
  let message = latest.error;
  try {
    message = text(table(JSON.parse(latest.error))?.detail) ?? message;
  } catch {
    // Plain text already.
  }
  return { model, at: latest.at, message: message.slice(0, 300) };
}

export async function readModelChoices(codexHome: string): Promise<CodexModelChoice[]> {
  try {
    const cache = table(
      JSON.parse(await fs.readFile(path.join(codexHome, "models_cache.json"), "utf8")),
    );
    const models = Array.isArray(cache?.models) ? cache.models : [];
    const choices: CodexModelChoice[] = [];
    for (const raw of models) {
      const model = table(raw);
      const slug = text(model?.slug);
      if (!slug || !MODEL_SLUG.test(slug) || model?.visibility === "hide") continue;
      choices.push({ slug, name: text(model?.display_name) ?? slug });
    }
    return choices;
  } catch {
    return [];
  }
}

function configModel(config: Table): { model: string | null; profileModel: boolean } {
  const profileName = text(config.profile);
  const profile = profileName ? table(table(config.profiles)?.[profileName]) : null;
  const fromProfile = text(profile?.model);
  return fromProfile
    ? { model: fromProfile, profileModel: true }
    : { model: text(config.model), profileModel: false };
}

export async function checkCodexModel(codexHome: string): Promise<CodexModelCheckResult> {
  let config: Table = {};
  try {
    config = table(parseToml(await fs.readFile(path.join(codexHome, "config.toml"), "utf8"))) ?? {};
  } catch {
    // Missing or broken config.toml has its own diagnostics row.
  }
  const [rejection, choices] = await Promise.all([
    findModelRejection(codexHome),
    readModelChoices(codexHome),
  ]);
  const { model, profileModel } = configModel(config);
  return {
    configModel: model,
    profileModel,
    rejection,
    choices: choices.filter((c) => c.slug !== rejection?.model),
  };
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "Z");
}

/**
 * Sets the top-level `model = "…"` in config.toml (the default for new tasks) to one from Codex's
 * own list. Only that one line changes; the file is copied to `config.toml.bak-rly0-model-<ts>`
 * first. A model set by the active profile is left alone.
 */
export async function setCodexModel(
  codexHome: string,
  slug: string,
  now: () => Date = () => new Date(),
): Promise<CodexModelSetResult> {
  if (!(await readModelChoices(codexHome)).some((c) => c.slug === slug)) {
    return { ok: false, reason: "UNKNOWN_MODEL" };
  }
  const file = path.join(codexHome, "config.toml");
  let original = "";
  try {
    original = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let parsed: Table;
  try {
    parsed = table(parseToml(original)) ?? {};
  } catch {
    return { ok: false, reason: "CONFIG_INVALID" };
  }
  if (configModel(parsed).profileModel) return { ok: false, reason: "PROFILE_MODEL" };

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/u);
  const firstTable = lines.findIndex((line) => /^\s*\[/u.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const entry = `model = ${JSON.stringify(slug)}`;
  const at = lines.slice(0, end).findIndex((line) => /^\s*model\s*=/u.test(line));
  if (at === -1) lines.splice(0, 0, entry);
  else lines[at] = entry;
  const next = lines.join(newline);
  try {
    if (table(parseToml(next))?.model !== slug) return { ok: false, reason: "CONFIG_INVALID" };
  } catch {
    return { ok: false, reason: "CONFIG_INVALID" };
  }

  const backupPath = `${file}.bak-rly0-model-${timestamp(now())}`;
  if (original) await fs.writeFile(backupPath, original, { encoding: "utf8", flag: "wx" });
  const temp = `${file}.tmp-rly0-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, next, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
  return original ? { ok: true, backupPath } : { ok: true };
}
