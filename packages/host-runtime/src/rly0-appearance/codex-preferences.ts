import { promises as fs } from "node:fs";
import path from "node:path";

import {
  RLY0_CODEX_PREFERENCES_FILE,
  rly0CodexPreferencesSchema,
  type Rly0CodexPreferenceValues,
  type Rly0CodexPreferences,
} from "@codexhost/shared-contracts";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

/**
 * Codex-side preferences the Hub window sets (设置 → 通用 → Codex 里). The Hub service writes the
 * file; the Host only reads it for the renderer, which applies the values to its local settings.
 */
export function codexPreferencesFile(environment: NodeJS.ProcessEnv): string {
  return path.join(resolveRly0DataDir(environment), RLY0_CODEX_PREFERENCES_FILE);
}

/** The saved preferences, or null when none were set or the file is unreadable. */
export async function readCodexPreferences(
  environment: NodeJS.ProcessEnv,
): Promise<Rly0CodexPreferences | null> {
  try {
    const raw = await fs.readFile(codexPreferencesFile(environment), "utf8");
    const parsed = rly0CodexPreferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Merges `values` into the saved preferences and stamps them, so Codex applies them once. */
export async function writeCodexPreferences(
  environment: NodeJS.ProcessEnv,
  values: Rly0CodexPreferenceValues,
  now: () => number = Date.now,
): Promise<Rly0CodexPreferences> {
  const current = (await readCodexPreferences(environment)) ?? { updatedAt: 0 };
  const next = rly0CodexPreferencesSchema.parse({
    ...current,
    ...values,
    updatedAt: Math.max(now(), current.updatedAt + 1),
  });
  const file = codexPreferencesFile(environment);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
  return next;
}
