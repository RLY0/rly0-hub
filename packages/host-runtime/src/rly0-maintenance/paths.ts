import os from "node:os";
import path from "node:path";

import { RLY0_HOME_DATA_DIRECTORY_NAME } from "@codexhost/shared-contracts";

/** Same override as the rest of RLY/0 Hub's own state (`HarnessLaunchSettingsStore` et al.). */
export function resolveRly0DataDir(environment: NodeJS.ProcessEnv): string {
  return environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), RLY0_HOME_DATA_DIRECTORY_NAME);
}

export function resolveRly0DiagnosticsDir(environment: NodeJS.ProcessEnv): string {
  return path.join(resolveRly0DataDir(environment), "diagnostics");
}

/**
 * The only directories under `~/.rly0-hub` that "clear cache" is allowed to touch: caches and
 * downloaded update installers (`updates`, skipped while an update is in progress). Never
 * `~/.codex`, and never the `diagnostics` directory (that holds exports the user asked for).
 */
export const RLY0_MAINTENANCE_CACHE_ENTRY_NAMES = ["cache", "tmp", "updates"] as const;

export function resolveRly0CacheEntryDir(environment: NodeJS.ProcessEnv, name: string): string {
  return path.join(resolveRly0DataDir(environment), name);
}
