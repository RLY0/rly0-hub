import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

export interface CliOwnerProbe {
  start(pid: number): string | null;
  signal(pid: number): void;
}

/** OS start identity, rather than PID alone (which can be reused after a crash). */
export function createCliOwnerProbe(
  options: {
    exec?: (
      command: string,
      args: readonly string[],
      options: ExecFileSyncOptionsWithStringEncoding,
    ) => string;
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): CliOwnerProbe {
  let selfStartedAt: string | null = null;
  return {
    signal: (pid) => {
      process.kill(pid, 0);
    },
    start: (pid) => {
      if (pid === process.pid && selfStartedAt) return selfStartedAt;
      try {
        const windows = (options.platform ?? process.platform) === "win32";
        const text = (options.exec ?? execFileSync)(
          windows ? "powershell.exe" : "/bin/ps",
          windows
            ? [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
              ]
            : ["-o", "lstart=", "-p", String(pid)],
          {
            encoding: "utf8",
            timeout: 3_000,
            windowsHide: true,
            env: { ...(options.environment ?? process.env), LC_ALL: "C", TZ: "UTC" },
            stdio: ["ignore", "pipe", "ignore"],
          },
        ).trim();
        if (pid === process.pid) selfStartedAt = text || null;
        return text || null;
      } catch {
        return null;
      }
    },
  };
}
export const cliOwnerProbe = createCliOwnerProbe();

// Cache only a confirmed matching owner, never a PID's mismatching start identity. A reused PID
// with a new owner/file must be probed afresh. signal(0) still detects dead owners immediately.
const verifiedOwners = new Map<string, number>();

export const heldCliOwners = new Set<string>();

/** Files are linked into place only after complete writes, so malformed files are abandoned. */
export function liveCliOwners(directory: string, probe: CliOwnerProbe = cliOwnerProbe): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const live: string[] = [];
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const file = path.join(directory, name);
    let alive = false;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const owner = (parsed && typeof parsed === "object" ? parsed : {}) as {
        pid?: unknown;
        startedAt?: unknown;
        id?: unknown;
      };
      if (
        Number.isSafeInteger(owner.pid) &&
        Number(owner.pid) > 0 &&
        typeof owner.startedAt === "string" &&
        typeof owner.id === "string"
      ) {
        const pid = Number(owner.pid);
        if (pid === process.pid) alive = heldCliOwners.has(owner.id);
        else {
          try {
            probe.signal(pid);
            const key = `${file}:${pid}:${owner.id}:${owner.startedAt}`;
            const now = Date.now();
            const start = (verifiedOwners.get(key) ?? 0) > now ? owner.startedAt : probe.start(pid);
            // Unknown identity is not evidence that a known live owner died.
            alive = start === null || start === owner.startedAt;
            if (start === owner.startedAt) {
              if (verifiedOwners.size > 256)
                for (const [key, expiry] of verifiedOwners)
                  if (expiry <= now) verifiedOwners.delete(key);
              // Reading a cache hit must not extend its original validation lifetime.
              if ((verifiedOwners.get(key) ?? 0) <= now) verifiedOwners.set(key, now + 1_000);
            }
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ESRCH" && code !== "EPERM") throw error;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
    if (alive) live.push(name);
    else {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return live;
}
