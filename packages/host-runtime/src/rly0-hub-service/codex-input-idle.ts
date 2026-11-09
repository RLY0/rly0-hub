import { execFile } from "node:child_process";

import type { CodexIdleDriver } from "./codex-update-manager.js";

/** Keyboard and mouse must have been untouched this long before Hub quits Codex for an update. */
export const CODEX_UPDATE_INPUT_IDLE_MS = 5 * 60_000;

/**
 * Milliseconds since the last keyboard/mouse input, from IOKit's IOHIDSystem `HIDIdleTime`
 * (nanoseconds). Null when the value cannot be read or parsed.
 */
export function parseHidIdleTime(ioregOutput: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/u.exec(ioregOutput);
  if (!match?.[1]) return null;
  const nanoseconds = Number(match[1]);
  return Number.isSafeInteger(nanoseconds) ? Math.floor(nanoseconds / 1_000_000) : null;
}

export function macInputIdleMs(
  run: (file: string, args: string[]) => Promise<string> = (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }),
): () => Promise<number | null> {
  return async () => {
    try {
      return parseHidIdleTime(await run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]));
    } catch {
      return null;
    }
  };
}

/**
 * The user's definition (2026-11-09) of "not using Codex": no task running in Codex AND no
 * keyboard/mouse input for five minutes. Anything unreadable counts as in use.
 */
export function codexIdleFromBusyAndInput(
  busy: () => Promise<boolean | null>,
  inputIdleMs: () => Promise<number | null>,
  thresholdMs = CODEX_UPDATE_INPUT_IDLE_MS,
): CodexIdleDriver {
  return async () => {
    if ((await busy()) !== false) return false;
    const idle = await inputIdleMs();
    return idle !== null && idle >= thresholdMs;
  };
}
