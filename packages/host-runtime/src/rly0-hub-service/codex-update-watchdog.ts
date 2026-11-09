import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

export interface CodexUpdateLease {
  id: string;
  pid: number;
  at: number;
}
export async function watchCodexUpdateLease(options: {
  id: string;
  read(): Promise<CodexUpdateLease | null>;
  alive(pid: number): boolean;
  disarm(): Promise<void>;
  wait(): Promise<void>;
  ready?(): void;
  now?: () => number;
}): Promise<void> {
  // Handshake before the parent writes true. This worker survives a parent SIGKILL.
  let ready = false;
  for (;;) {
    let lease: CodexUpdateLease | null;
    try {
      lease = await options.read();
    } catch {
      await options.disarm();
      return;
    }
    if (!lease || lease.id !== options.id) return; // Explicit disarm / newer owner.
    const age = (options.now ?? Date.now)() - lease.at;
    if (
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0 ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 60_000 ||
      !options.alive(lease.pid)
    ) {
      await options.disarm();
      return;
    }
    if (!ready) {
      options.ready?.();
      ready = true;
    }
    await options.wait();
  }
}
async function main() {
  // HOME alone does not isolate cfprefsd. Native commands are forbidden under test.
  if (process.env.VITEST || process.env.NODE_ENV === "test")
    throw new Error("CODEX_UPDATER_TEST_ISOLATION");
  const [file, id] = process.argv.slice(2);
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
        return { id: lease.id, pid: lease.pid, at: lease.at };
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
    disarm: async () => {
      await new Promise<void>((resolve, reject) =>
        execFile(
          "/usr/bin/defaults",
          ["write", "com.openai.codex", "SUAutomaticallyUpdate", "-bool", "false"],
          { timeout: 15_000 },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 2000)),
    ready: () => {
      process.send?.({ ready: true });
      process.disconnect?.();
    },
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
