import type { CodexCheckPreferences } from "./codex-update-manager.js";

export type CodexPreferencesExec = (file: string, args: string[]) => Promise<string>;

/** Shared by the driver and detached watchdog; tests inject every system command. */
export function codexPreferences(exec: CodexPreferencesExec) {
  const domain = "com.openai.codex";
  const read = async (key: string): Promise<string | null> => {
    try {
      return await exec("/usr/bin/defaults", ["read", domain, key]);
    } catch (error) {
      if (defaultsValueMissing((error as { stderr?: unknown }).stderr)) return null;
      throw error;
    }
  };
  const write = async (key: string, value: string | boolean | null): Promise<void> => {
    try {
      await exec(
        "/usr/bin/defaults",
        value === null
          ? ["delete", domain, key]
          : [
              "write",
              domain,
              key,
              typeof value === "boolean"
                ? "-bool"
                : key === "SULastCheckTime"
                  ? "-date"
                  : "-string",
              String(value),
            ],
      );
    } catch (error) {
      if (value !== null || !defaultsValueMissing((error as { stderr?: unknown }).stderr))
        throw error;
    }
  };
  return {
    read,
    write,
    async readBoolean(key: string): Promise<boolean | null> {
      const value = await read(key);
      if (value === null) return null;
      if (value !== "0" && value !== "1") throw new Error("CODEX_PREFERENCES_FAILED");
      return value === "1";
    },
    async readString(key: string): Promise<string | null> {
      const value = await read(key);
      if (
        value !== null &&
        (await exec("/usr/bin/defaults", ["read-type", domain, key])) !== "Type is string"
      )
        throw new Error("CODEX_PREFERENCES_FAILED");
      return value;
    },
  };
}

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
