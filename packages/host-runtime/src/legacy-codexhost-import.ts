import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RLY0_HOME_DATA_DIRECTORY_NAME } from "@codexhost/shared-contracts";

/** Upstream CodexHost's data directory name (`~/.codexhost`). Only ever read, never written. */
export const LEGACY_CODEXHOST_DIRECTORY_NAME = ".codexhost";
const MARKER_FILE = ".legacy-codexhost-import.json";
/** Mapping-store subdirectories worth carrying over; `store.lock` is deliberately excluded. */
const MAPPING_SUBDIRECTORIES = ["threads", "backups", "delegations", "quarantine"] as const;
/** Top-level data folders whose files are merged in without overwriting anything. */
const MERGE_DIRECTORIES = ["antigravity-history"] as const;

export interface LegacyImportResult {
  readonly imported: boolean;
  readonly reason: string;
  readonly threads?: number;
}

function jsonFileCount(directory: string): number {
  try {
    return readdirSync(directory).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * One-time, copy-only import of an existing upstream CodexHost install's thread mappings into
 * RLY/0 Hub's own data directory, so Claude / other harness chats started under CodexHost keep
 * showing up. Runs only when using the default data directory, the legacy store has threads and
 * ours has none. The legacy directory is never modified or deleted; existing files are never
 * overwritten. A marker file prevents re-importing after the user deliberately clears threads.
 */
export function importLegacyCodexHostData(
  environment: NodeJS.ProcessEnv,
  options: { readonly home?: string } = {},
): LegacyImportResult {
  if (environment.CODEXHOST_DATA_DIR) return { imported: false, reason: "custom-data-dir" };
  if (environment.RLY0_SKIP_LEGACY_IMPORT === "1") return { imported: false, reason: "disabled" };
  const home = options.home ?? os.homedir();
  const legacyRoot = path.join(home, LEGACY_CODEXHOST_DIRECTORY_NAME);
  const targetRoot = path.join(home, RLY0_HOME_DATA_DIRECTORY_NAME);
  if (path.resolve(legacyRoot) === path.resolve(targetRoot)) {
    return { imported: false, reason: "same-directory" };
  }
  const marker = path.join(targetRoot, "mapping-store", MARKER_FILE);
  if (existsSync(marker)) return { imported: false, reason: "already-imported" };
  const legacyThreads = jsonFileCount(path.join(legacyRoot, "mapping-store", "threads"));
  if (legacyThreads === 0) return { imported: false, reason: "no-legacy-threads" };
  if (jsonFileCount(path.join(targetRoot, "mapping-store", "threads")) > 0) {
    return { imported: false, reason: "target-has-threads" };
  }

  try {
    for (const name of MAPPING_SUBDIRECTORIES) {
      const source = path.join(legacyRoot, "mapping-store", name);
      if (!existsSync(source)) continue;
      cpSync(source, path.join(targetRoot, "mapping-store", name), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }
    for (const name of MERGE_DIRECTORIES) {
      const source = path.join(legacyRoot, name);
      if (!existsSync(source)) continue;
      cpSync(source, path.join(targetRoot, name), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(
      marker,
      `${JSON.stringify({ importedAt: new Date().toISOString(), threads: legacyThreads })}\n`,
    );
    return { imported: true, reason: "imported", threads: legacyThreads };
  } catch {
    // Best effort: a failed import must never block startup. Nothing in the legacy dir was touched.
    return { imported: false, reason: "copy-failed" };
  }
}
