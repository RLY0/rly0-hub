import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

/** Why native control is not mounted: another platform; control turned off for development,
 * tests or by the explicit `RLY0_CODEX_UPDATE_CONTROL=0`; or a production Hub whose HOME or data
 * directory is not the login user's default. */
export type CodexUpdateUnsupportedReason = "platform" | "control-disabled" | "environment";
export function codexNativeUpdateControlBlocker(
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
  realHome = os.userInfo().homedir,
): CodexUpdateUnsupportedReason | null {
  if (platform !== "darwin") return "platform";
  if (
    environment.RLY0_CODEX_UPDATE_CONTROL === "0" ||
    environment.RLY0_HUB_MACOS_DEV_HOME === "1" ||
    environment.VITEST ||
    environment.NODE_ENV === "test"
  )
    return "control-disabled";
  // HOME does not isolate cfprefsd or the macOS login session's applications.
  if (
    path.resolve(environment.HOME ?? realHome) !== path.resolve(realHome) ||
    resolveRly0DataDir(environment) !== path.join(realHome, ".rly0-hub")
  )
    return "environment";
  return null;
}
export function codexNativeUpdateControlAllowed(
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
  realHome = os.userInfo().homedir,
): boolean {
  return codexNativeUpdateControlBlocker(environment, platform, realHome) === null;
}

/** Start time of a process as reported by `ps -o lstart=`; null when unavailable. */
export type ProcessStartReader = (pid: number) => Promise<string | null>;
export function readProcessStart(pid: number): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      // Locale-free, so Hubs started with different locales read the same start time.
      { timeout: 5_000, maxBuffer: 16 * 1024, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => {
        const value = stdout.trim();
        resolve(error || !value ? null : value);
      },
    );
  });
}
export interface CodexUpdateControlProbe {
  pid?: number;
  processStart?: ProcessStartReader;
  /** `process.kill(pid, 0)` semantics: throws ESRCH/EPERM when no signalable process exists. */
  signal?: (pid: number) => void;
}
/** Owner ids this process holds. A record with this PID but another id was written by an
 * earlier process whose PID the current one reused. */
const held = new Set<string>();
async function ownerAlive(
  owner: { id?: unknown; pid: number; startedAt?: unknown },
  self: number,
  processStart: ProcessStartReader,
  signal: (pid: number) => void,
): Promise<boolean> {
  if (owner.pid === self) return typeof owner.id === "string" && held.has(owner.id);
  try {
    signal(owner.pid);
  } catch (probe) {
    const code = (probe as NodeJS.ErrnoException).code;
    // EPERM: the PID now belongs to another user's process (e.g. root), never to a Hub of ours.
    if (code === "ESRCH" || code === "EPERM") return false;
    throw probe;
  }
  if (typeof owner.startedAt !== "string") return true;
  const started = await processStart(owner.pid);
  // An unreadable start time is not proof of reuse; a different one is.
  return started === null || started === owner.startedAt;
}

/** Exclusive native control for Hubs sharing a directory. A live owner is never evicted. */
export async function acquireCodexUpdateControl(
  directory: string,
  probe: CodexUpdateControlProbe = {},
): Promise<() => Promise<void>> {
  const { promises: fs } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const self = probe.pid ?? process.pid;
  const processStart = probe.processStart ?? readProcessStart;
  const signal = probe.signal ?? ((pid: number) => process.kill(pid, 0));
  const file = path.join(directory, "codex-update-owner.json");
  const id = randomUUID();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${id}`;
  const startedAt = await processStart(self);
  await fs.writeFile(
    temporary,
    JSON.stringify({ id, pid: self, ...(startedAt ? { startedAt } : {}) }),
    { mode: 0o600 },
  );
  try {
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize stale-owner reclamation as well as ordinary acquisition.
      const reclaim = `${file}.reclaim`;
      const handle = await fs.open(reclaim, "wx", 0o600);
      try {
        const owner = JSON.parse(await fs.readFile(file, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
          throw new Error("CODEX_UPDATE_OWNER_INVALID");
        if (await ownerAlive(owner, self, processStart, signal))
          throw new Error("CODEX_UPDATE_OWNER_BUSY");
        await fs.unlink(file);
        await fs.link(temporary, file);
      } finally {
        await handle.close();
        await fs.rm(reclaim, { force: true });
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  held.add(id);
  return async () => {
    const owner = await fs.readFile(file, "utf8").catch(() => null);
    if (owner && JSON.parse(owner).id === id) await fs.unlink(file);
    held.delete(id);
  };
}
