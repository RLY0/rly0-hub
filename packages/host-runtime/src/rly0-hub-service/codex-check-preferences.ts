import type { CodexCheckPreferences } from "./codex-update-manager.js";

/**
 * `defaults read|delete` stderr for an absent key or domain. Older macOS prints "The domain/default
 * pair of (…) does not exist"; macOS 27 prints "Could not find key 'K' in domain 'D'." or
 * "Domain 'D' not found." Any other failure (permission, timeout) stays an error.
 */
export function defaultsValueMissing(stderr: unknown): boolean {
  return /does not exist|Could not find key '|Domain '.*' not found/u.test(String(stderr));
}

/** Restore only Hub's written state; a new Sparkle check date belongs to Sparkle. */
export async function restoreCodexCheckPreferences(
  original: CodexCheckPreferences,
  read: (key: string) => Promise<string | null>,
  write: (key: string, value: string | boolean | null) => Promise<void>,
): Promise<void> {
  if ((await read("SUEnableAutomaticChecks")) === "1")
    await write("SUEnableAutomaticChecks", original.automaticChecks);
  if ((await read("SULastCheckTime")) === null)
    await write("SULastCheckTime", original.lastCheckTime);
}
