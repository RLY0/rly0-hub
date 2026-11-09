import type { CodexUpdateDriver } from "./codex-update-manager.js";

type ReopenDriver = Pick<
  CodexUpdateDriver,
  "isRunning" | "installationStopped" | "launcherRunning" | "reopen"
>;

/** Waits for an exiting Launcher before the first start (a start it receives is dropped). */
export const LAUNCHER_EXIT_WAIT_MS = 30_000;
/** At least the Launcher's own 30-second start timeout (Gatekeeper may verify a new bundle). */
export const REOPEN_CONFIRM_MS = 30_000;
export const REOPEN_ATTEMPTS = 2;
export const REOPEN_POLL_MS = 3_000;
export const REOPEN_RETRY_MS = 60_000;
/** After this long without a confirmed reopen the Hub stops retrying and keeps the error. */
export const REOPEN_GIVE_UP_MS = 30 * 60_000;

export type ReopenPassResult = "running" | "not-stopped" | "failed";
export type WaitFor = (condition: () => Promise<boolean>, timeoutMs: number) => Promise<boolean>;

/** A Launcher state that cannot be read counts as running: never risk a second launch. */
async function launcherBusy(driver: ReopenDriver): Promise<boolean> {
  if (!driver.launcherRunning) return false;
  try {
    return await driver.launcherRunning();
  } catch {
    return true;
  }
}

/**
 * One bounded reopen pass for a Codex the Hub closed. Only a running Codex is success; an issued
 * start is not. A further start is issued only after the previous Launcher has exited.
 */
export async function reopenCodexPass(
  driver: ReopenDriver,
  waitFor: WaitFor,
): Promise<ReopenPassResult> {
  if (await driver.isRunning()) return "running";
  if (!(await driver.installationStopped())) return "not-stopped";
  await waitFor(async () => !(await launcherBusy(driver)), LAUNCHER_EXIT_WAIT_MS);
  for (let attempt = 0; attempt < REOPEN_ATTEMPTS; attempt += 1) {
    if (!(await driver.reopen())) return "failed";
    if (await waitFor(() => driver.isRunning(), REOPEN_CONFIRM_MS)) return "running";
    const settled = await waitFor(
      async () => (await driver.isRunning()) || !(await launcherBusy(driver)),
      LAUNCHER_EXIT_WAIT_MS,
    );
    if (await driver.isRunning()) return "running";
    if (!settled) return "failed"; // That Launcher is still starting; retry after a pause.
  }
  return "failed";
}

/**
 * Hub shutdown: at most one start, no confirmation wait. The caller keeps its session record (the
 * next Hub start recovers from it) unless Codex is already running.
 */
export async function reopenCodexOnStop(driver: ReopenDriver): Promise<"running" | "left"> {
  if (await driver.isRunning()) return "running";
  if (!(await driver.installationStopped()) || (await launcherBusy(driver))) return "left";
  await driver.reopen();
  return "left";
}
