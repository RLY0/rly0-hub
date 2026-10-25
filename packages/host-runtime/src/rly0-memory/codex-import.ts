import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MEMORY_LIMITS, type MemoryStore } from "./store.js";

/**
 * First run: copy the durable parts of Codex's own memories into the shared memory, read-only on
 * `~/.codex/memories`. `MEMORY.md` task groups with `applies_to: cwd=...` become project records
 * of that folder (their preferences / reusable knowledge / failures sections); the profile,
 * preferences and tips of `memory_summary.md` become global records. Runs once per store
 * (`codex-import.json`); Codex keeps its own files.
 */
const MARKER = "codex-import.json";
const MAX_IMPORTED = 300;
const KEPT_GROUP_SECTIONS = /^(?:User preferences|Reusable knowledge|Failures and how to do differently)/u;
const KEPT_SUMMARY_SECTIONS = /^(?:User Profile|User preferences|General Tips)/u;

export interface CodexImportResult {
  readonly imported: number;
  readonly skipped: "already-imported" | "no-memories" | null;
}

function sections(markdown: string): { title: string; body: string }[] {
  return markdown
    .split(/^## /mu)
    .slice(1)
    .map((part) => {
      const newline = part.indexOf("\n");
      return {
        title: (newline < 0 ? part : part.slice(0, newline)).trim(),
        body: newline < 0 ? "" : part.slice(newline + 1).trim(),
      };
    });
}
function clip(text: string): string {
  return text.length > MEMORY_LIMITS.textChars ? `${text.slice(0, MEMORY_LIMITS.textChars - 1)}…` : text;
}
async function readBounded(file: string, max: number): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > max) return null;
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function importCodexMemories(
  store: MemoryStore,
  environment: NodeJS.ProcessEnv,
): Promise<CodexImportResult> {
  const marker = path.join(store.directory, MARKER);
  if (await fs.stat(marker).then(() => true, () => false))
    return { imported: 0, skipped: "already-imported" };
  const codex = path.resolve(
    environment.CODEX_HOME ??
      path.join(environment.USERPROFILE ?? environment.HOME ?? os.homedir(), ".codex"),
  );
  const root = path.join(codex, "memories");
  const memory = await readBounded(path.join(root, "MEMORY.md"), 4 * 1024 * 1024);
  const summary = await readBounded(path.join(root, "memory_summary.md"), 512 * 1024);
  const pending: { text: string; scope: "project" | "global"; cwd?: string }[] = [];
  for (const group of (memory ?? "").split(/(?=^# Task Group:)/mu)) {
    const title = /^# Task Group:\s*(.+)$/mu.exec(group)?.[1]?.trim();
    if (!title) continue;
    const scope = /^applies_to:\s*(.*)$/mu.exec(group)?.[1] ?? "";
    const cwd = /cwd=([A-Za-z]:\\[^;\s]*|\/[^;\s]*)/u.exec(scope)?.[1];
    for (const section of sections(group)) {
      if (!KEPT_GROUP_SECTIONS.test(section.title) || !section.body) continue;
      pending.push({
        text: clip(`${title} — ${section.title}\n${section.body}`),
        ...(cwd ? { scope: "project" as const, cwd } : { scope: "global" as const }),
      });
    }
  }
  for (const section of sections(summary ?? "")) {
    if (!KEPT_SUMMARY_SECTIONS.test(section.title) || !section.body) continue;
    pending.push({ text: clip(`${section.title}\n${section.body}`), scope: "global" });
  }
  let imported = 0;
  for (const entry of pending.slice(0, MAX_IMPORTED)) {
    try {
      await store.remember({
        text: entry.text,
        tags: ["codex-import"],
        agent: "codex",
        scope: entry.scope,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        source: "import",
      });
      imported += 1;
    } catch {
      /* A full store or an unusable entry does not stop the rest. */
    }
  }
  await fs.mkdir(store.directory, { recursive: true });
  await fs.writeFile(
    marker,
    JSON.stringify({ importedAt: new Date().toISOString(), imported, found: pending.length }),
  );
  return { imported, skipped: memory || summary ? null : "no-memories" };
}
