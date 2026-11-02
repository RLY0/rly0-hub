import { promises as fs } from "node:fs";
import path from "node:path";

import {
  RLY0_AGENT_DEFAULTS_FILE,
  rly0AgentDefaultsFileSchema,
  type Rly0AgentDefaults,
  type Rly0AgentDefaultsFile,
  type Rly0CodexPreferencesGetParams,
  type Rly0CodexPreferencesGetResult,
} from "@codexhost/shared-contracts";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { readCodexPreferences } from "./codex-preferences.js";

/**
 * New-Thread defaults per external agent (AI 助手 → 新对话默认设置). The Hub service writes this
 * file on its own; `codex-preferences.json` keeps the exact format older builds parse strictly.
 * The Host only reads it for the renderer.
 */
export function agentDefaultsFile(environment: NodeJS.ProcessEnv): string {
  return path.join(resolveRly0DataDir(environment), RLY0_AGENT_DEFAULTS_FILE);
}

/** The saved defaults, or null when none were set or the file is unreadable (treated as unset). */
export async function readAgentDefaults(
  environment: NodeJS.ProcessEnv,
): Promise<Rly0AgentDefaultsFile | null> {
  try {
    const raw = await fs.readFile(agentDefaultsFile(environment), "utf8");
    const parsed = rly0AgentDefaultsFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Replaces the whole map (a cleared agent disappears); touches no other file. */
export async function writeAgentDefaults(
  environment: NodeJS.ProcessEnv,
  agents: Rly0AgentDefaults,
  now: () => number = Date.now,
): Promise<Rly0AgentDefaultsFile> {
  const current = await readAgentDefaults(environment);
  const next = rly0AgentDefaultsFileSchema.parse({
    version: 1,
    updatedAt: Math.max(now(), (current?.updatedAt ?? 0) + 1),
    agents,
  });
  const file = agentDefaultsFile(environment);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
  return next;
}

/**
 * `codexhost/rly0/codexPreferences/get`: the Codex preferences as before, plus the new-Thread
 * defaults as a sibling field only for a renderer that asks for them.
 */
export async function codexPreferencesGetResult(
  environment: NodeJS.ProcessEnv,
  params: Rly0CodexPreferencesGetParams,
): Promise<Rly0CodexPreferencesGetResult> {
  const preferences = await readCodexPreferences(environment);
  if (!params.agentDefaults) return { preferences };
  return { preferences, agentDefaults: await readAgentDefaults(environment) };
}
