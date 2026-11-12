import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discoverHostClientChannel } from "@codexhost/desktop-control";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import type { OfficialRuntimeScope } from "./official-runtime-scope.js";

const ACK_FILE = "codex-update-native-paused.json";
const LEASE_FRESH_MS = 10_000;

async function record(file: string): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await readFile(file);
    if (bytes.length > 16 * 1024) throw new Error("Invalid Codex update record");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Codex update record");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function requestedLease(directory: string, now: number): Promise<string | null> {
  const lease = await record(path.join(directory, "codex-update-armed.json"));
  const session = await record(path.join(directory, "codex-update-session.json"));
  return lease &&
    session?.closedByHub === true &&
    session.leaseId === lease.id &&
    typeof lease.id === "string" &&
    lease.id.length > 0 &&
    Number.isSafeInteger(lease.pid) &&
    typeof lease.pid === "number" &&
    lease.pid > 0 &&
    typeof lease.at === "number" &&
    now >= lease.at &&
    now - lease.at < LEASE_FRESH_MS
    ? lease.id
    : null;
}

/** Retire only the idle native backend. External work and the independent Host stay alive.
 * A matching, renewed Hub lease fences Web/recovery starts until install ends or Hub dies. */
export function watchDesktopUpdatePause(
  scope: Pick<OfficialRuntimeScope, "pauseForDesktopUpdate" | "resumeAfterDesktopUpdate">,
  environment: NodeJS.ProcessEnv,
  now = Date.now,
) {
  const directory = resolveRly0DataDir(environment);
  const file = path.join(directory, ACK_FILE);
  let acknowledged: string | null = null;
  let tail = Promise.resolve();
  let closed = false;
  const check = () => {
    tail = tail
      .then(async () => {
        if (closed) return;
        const id = await requestedLease(directory, now());
        if (id) {
          if (acknowledged === id || !(await scope.pauseForDesktopUpdate())) return;
          // Installation may have been cancelled while the native process was exiting.
          if ((await requestedLease(directory, now())) !== id) {
            scope.resumeAfterDesktopUpdate();
            return;
          }
          const temporary = `${file}.${process.pid}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify({ leaseId: id, pid: process.pid }), {
              mode: 0o600,
            });
            await rename(temporary, file);
            acknowledged = id;
          } finally {
            await rm(temporary, { force: true });
          }
        } else {
          scope.resumeAfterDesktopUpdate();
          if (acknowledged) await rm(file, { force: true });
          acknowledged = null;
        }
      })
      .catch(() => {
        /* An unreadable fence cannot authorize an update or resume. */
      });
    return tail;
  };
  const timer = setInterval(() => void check(), 250);
  timer.unref();
  return {
    check,
    async close() {
      closed = true;
      clearInterval(timer);
      await tail;
      if (acknowledged) await rm(file, { force: true });
    },
  };
}

/** The normal quit is sent only after this shared Host confirms native process exit.
 * Legacy Desktop-owned Hosts exit with Desktop and need no additional handshake. */
export async function waitForDesktopUpdatePause(environment: NodeJS.ProcessEnv, timeoutMs = 5_000) {
  const directory = resolveRly0DataDir(environment);
  const host = await discoverHostClientChannel(path.join(directory, "client-hosts"));
  if (host?.owner !== "service") return;
  const id = await requestedLease(directory, Date.now());
  if (!id) throw new Error("CODEX_INSTALLATION_UNAVAILABLE");
  const deadline = performance.now() + timeoutMs;
  do {
    const ack = await record(path.join(directory, ACK_FILE));
    if (
      ack?.leaseId === id &&
      ack.pid === host.pid &&
      (await requestedLease(directory, Date.now())) === id
    )
      return;
    await delay(100);
  } while (performance.now() < deadline);
  throw new Error("CODEX_INSTALLATION_UNAVAILABLE");
}
