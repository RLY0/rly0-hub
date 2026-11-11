import {
  codexPreferences,
  restoreCodexCheckPreferences,
  type CodexPreferencesExec,
} from "./codex-check-preferences.js";
import { codexNativeUpdateControlAllowed } from "./codex-update-control.js";
import type { CodexCheckPreferences } from "./codex-update-manager.js";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

export interface CodexUpdateLease {
  id: string;
  pid: number;
  at: number;
  checkPreferences?: CodexCheckPreferences;
}
/** Release recovery never restores an old skip snapshot: unskip completed before the lease. */
export async function disarmCodexUpdateLease(
  lease: CodexUpdateLease | undefined,
  exec: CodexPreferencesExec,
): Promise<void> {
  const { read, write } = codexPreferences(exec);
  await write("SUAutomaticallyUpdate", false);
  if (lease?.checkPreferences)
    await restoreCodexCheckPreferences(lease.checkPreferences, read, write);
  // A hold journal survives a Hub crash. Only its owner/next Hub may compare-and-restore it;
  // a detached old watchdog must never erase a newer user/Hub skip or reapply a released skip.
}
export async function watchCodexUpdateLease(options: {
  id: string;
  read(): Promise<CodexUpdateLease | null>;
  alive(pid: number): boolean;
  disarm(lease?: CodexUpdateLease): Promise<void>;
  wait(): Promise<void>;
  ready?(): void;
  now?: () => number;
}): Promise<void> {
  // Handshake before the parent writes true. This worker survives a parent SIGKILL.
  let ready = false;
  let staleChecks = 0;
  for (;;) {
    let lease: CodexUpdateLease | null;
    try {
      lease = await options.read();
    } catch {
      try {
        await options.disarm();
        return;
      } catch {
        await options.wait();
        continue;
      }
    }
    if (!lease || lease.id !== options.id) return; // Explicit disarm / newer owner.
    const age = (options.now ?? Date.now)() - lease.at;
    // Give a live parent time to renew after wake / wall-clock adjustment.
    staleChecks = age < 0 || age > 300_000 ? staleChecks + 1 : 0;
    if (
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0 ||
      !Number.isFinite(age) ||
      staleChecks >= 15 ||
      !options.alive(lease.pid)
    ) {
      try {
        await options.disarm(lease);
        return;
      } catch {
        await options.wait();
        continue;
      }
    }
    if (!ready) {
      options.ready?.();
      ready = true;
    }
    await options.wait();
  }
}
/** The packaged entry uses this same runner; smoke tests inject every system side effect. */
export async function runCodexUpdateWatchdog(
  file: string,
  id: string,
  driver?: Pick<Parameters<typeof watchCodexUpdateLease>[0], "alive" | "disarm" | "wait" | "ready">,
) {
  // HOME alone does not isolate cfprefsd. Native commands are forbidden under test.
  if (!driver && !codexNativeUpdateControlAllowed(process.env))
    throw new Error("CODEX_UPDATER_TEST_ISOLATION");
  if (!file || !id) throw new Error("CODEX_WATCHDOG_ARGUMENTS");
  await watchCodexUpdateLease({
    id,
    read: async () => {
      try {
        const lease: unknown = JSON.parse(await fs.readFile(file, "utf8"));
        if (
          typeof lease !== "object" ||
          lease === null ||
          !("id" in lease) ||
          typeof lease.id !== "string" ||
          !("pid" in lease) ||
          typeof lease.pid !== "number" ||
          !("at" in lease) ||
          typeof lease.at !== "number"
        )
          throw new Error("CODEX_LEASE_INVALID");
        let checkPreferences: CodexCheckPreferences | undefined;
        if (
          "checkPreferences" in lease &&
          lease.checkPreferences &&
          typeof lease.checkPreferences === "object"
        ) {
          const value = lease.checkPreferences;
          if (
            "automaticChecks" in value &&
            (typeof value.automaticChecks === "boolean" || value.automaticChecks === null) &&
            "lastCheckTime" in value &&
            (typeof value.lastCheckTime === "string" || value.lastCheckTime === null)
          )
            checkPreferences = {
              automaticChecks: value.automaticChecks,
              lastCheckTime: value.lastCheckTime,
            };
        }
        return {
          id: lease.id,
          pid: lease.pid,
          at: lease.at,
          ...(checkPreferences ? { checkPreferences } : {}),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    disarm: async (lease) => {
      const exec: CodexPreferencesExec = (file, args) =>
        new Promise<string>((resolve, reject) =>
          execFile(file, args, { timeout: 15_000 }, (error, stdout, stderr) => {
            if (error) reject(Object.assign(new Error("CODEX_PREFERENCES_FAILED"), { stderr }));
            else resolve(stdout.trim());
          }),
        );
      await disarmCodexUpdateLease(lease, exec);
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 2000)),
    ready: () => {
      process.send?.({ ready: true });
      process.disconnect?.();
    },
    ...driver,
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCodexUpdateWatchdog(process.argv[2] ?? "", process.argv[3] ?? "").catch(() => {
    process.exitCode = 1;
  });
}
