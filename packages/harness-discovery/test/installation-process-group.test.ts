import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runInstallationCommand } from "../src/installation.js";

// Only these harmless commands may reach the real OS. npm and installed CLIs never run.
it.runIf(process.platform !== "win32").each(["timeout", "abort"] as const)(
  "kills a reparented sleep in its owned POSIX group on %s and preserves an unrelated sibling",
  async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-cli-group-"));
    const env = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, "codex"),
      CODEXHOST_DATA_DIR: root,
      RLY0_MEMORY_DIR: path.join(root, "memory"),
      RLY0_SKIP_LEGACY_IMPORT: "1",
    };
    const children: ChildProcess[] = [];
    const closed: Promise<void>[] = [];
    const launch: typeof spawn = ((command: string, args: string[], options: object) => {
      if (!["/bin/sh", "/bin/sleep"].includes(command))
        throw new Error("Non-fixture process launch");
      const child = spawn(command, args, options);
      children.push(child);
      closed.push(new Promise((resolve) => child.once("close", () => resolve())));
      return child;
    }) as typeof spawn;
    const kill: typeof process.kill = (pid, signal) => {
      if (!children.some((child) => child.pid && -child.pid === pid))
        throw new Error("Non-owned process group");
      return process.kill(pid, signal);
    };
    const sibling = launch("/bin/sleep", ["103"], { detached: true, env, stdio: "ignore" });
    try {
      const pidFile = path.join(root, "reparented.pid");
      const controller = new AbortController();
      const running = runInstallationCommand(
        "/bin/sh",
        ["-c", '(/bin/sleep 103 & echo $! > "$1"); /bin/sleep 103', "synthetic", pidFile],
        env,
        750,
        process.platform,
        { spawn: launch, kill, signal: controller.signal },
      );
      const checked = expect(running).rejects.toThrow(
        mode === "abort" ? "INTERRUPTED" : "timed out",
      );
      let pid = 0;
      await vi.waitFor(async () => {
        pid = Number((await readFile(pidFile, "utf8")).trim());
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      });
      if (mode === "abort") controller.abort();
      await checked;
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      // A terminated orphan can remain a zombie until init reaps it; a zombie cannot keep installing.
      const status = () => {
        try {
          return execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
            env,
            encoding: "utf8",
            timeout: 1000,
          }).trim();
        } catch {
          return "";
        }
      };
      await vi.waitFor(() => expect(status() === "" || status().startsWith("Z")).toBe(true));
      expect(sibling.exitCode).toBeNull();
      expect(sibling.signalCode).toBeNull();
      if (!sibling.pid) throw new Error("Synthetic sibling did not start");
      expect(process.kill(sibling.pid, 0)).toBe(true);
    } finally {
      for (const child of children) {
        if (!child.pid) continue;
        try {
          kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await Promise.all(closed);
      await rm(root, { recursive: true, force: true });
    }
  },
);
