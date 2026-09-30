import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Rly0AutostartRegistry } from "./autostart-registry.js";
import {
  RLY0_AUTOSTART_REGISTRY_KEY,
  RLY0_AUTOSTART_REGISTRY_VALUE_NAME,
} from "./autostart-registry.js";

const execFileAsync = promisify(execFile);

/**
 * Shells out to the Windows-native `reg.exe` rather than adding a native registry-access
 * dependency. Only ever touches the single `"RLY0Hub"` value under the current user's Run key.
 */
export class WindowsRegistryAutostart implements Rly0AutostartRegistry {
  async get(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("reg.exe", [
        "query",
        RLY0_AUTOSTART_REGISTRY_KEY,
        "/v",
        RLY0_AUTOSTART_REGISTRY_VALUE_NAME,
      ]);
      const match = /REG_SZ\s+(.*)$/mu.exec(stdout);
      const value = match?.[1]?.trim();
      return value && value.length > 0 ? value : null;
    } catch {
      // reg.exe exits non-zero when the key/value does not exist.
      return null;
    }
  }

  async set(command: string): Promise<void> {
    await execFileAsync("reg.exe", [
      "add",
      RLY0_AUTOSTART_REGISTRY_KEY,
      "/v",
      RLY0_AUTOSTART_REGISTRY_VALUE_NAME,
      "/t",
      "REG_SZ",
      "/d",
      command,
      "/f",
    ]);
  }

  async remove(): Promise<void> {
    try {
      await execFileAsync("reg.exe", [
        "delete",
        RLY0_AUTOSTART_REGISTRY_KEY,
        "/v",
        RLY0_AUTOSTART_REGISTRY_VALUE_NAME,
        "/f",
      ]);
    } catch {
      // Already absent.
    }
  }
}

/** Best-effort relaunch command for this running process (node executable + its own argv). */
export function resolveRly0LauncherCommand(
  executablePath: string = process.execPath,
  args: readonly string[] = process.argv.slice(1),
): string {
  const quote = (value: string): string => (/\s/u.test(value) ? `"${value}"` : value);
  return [executablePath, ...args].map(quote).join(" ");
}
