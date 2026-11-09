import type { CodexCheckPreferences } from "./codex-update-manager.js";

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
