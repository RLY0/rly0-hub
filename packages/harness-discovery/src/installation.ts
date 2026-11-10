import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { commandInvocation } from "./invocation.js";
import { withNodeRuntimeOnPath } from "./node-runtime.js";

export interface InstallationState {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  message?: string;
  messageCode?: string;
  /** Adapter-owned display text; Host validates locales and the English fallback. */
  notice?: Record<string, string>;
  latestVersionKind?: "unknown" | "tracking-branch";
}

/** Fixed adapter-owned commands only. No shell, prompt input, or raw output in errors. */
export function runInstallationCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeout = 30_000,
  platform: NodeJS.Platform = process.platform,
  control: {
    signal?: AbortSignal;
    exec?: typeof execFile;
    killTree?: (pid: number) => Promise<void>;
  } = {},
): Promise<string> {
  const env = withNodeRuntimeOnPath(environment);
  const invocation = /\.[cm]?js$/i.test(command)
    ? commandInvocation(process.execPath, [command, ...args], env, platform)
    : commandInvocation(command, args, env, platform);
  return new Promise((resolve, reject) => {
    if (control.signal?.aborted) {
      reject(new Error("INTERRUPTED"));
      return;
    }
    const exec = control.exec ?? execFile;
    let stopping: Promise<void> | undefined;
    let completed = false;
    let timer: NodeJS.Timeout | undefined;
    let closed: Promise<void> | undefined;
    let hasClosed = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      control.signal?.removeEventListener("abort", abort);
    };
    const terminate = (reason: string) => {
      if (completed || stopping) return;
      stopping = (async () => {
        if (child.pid) {
          if (control.killTree) await control.killTree(child.pid);
          else if (platform === "win32") {
            await new Promise<void>((done, fail) => {
              exec(
                "taskkill.exe",
                ["/PID", String(child.pid), "/T", "/F"],
                { windowsHide: true, timeout: 5_000 },
                (error) => (error ? fail(error) : done()),
              );
            });
          } else {
            const output = await new Promise<string>((done, fail) => {
              exec(
                "/bin/ps",
                ["-axo", "pid=,ppid="],
                { encoding: "utf8", timeout: 5_000 },
                (error, stdout) => (error ? fail(error) : done(stdout)),
              );
            });
            const rows = output.split("\n").map((line) => line.trim().split(/\s+/).map(Number));
            const tree = [child.pid];
            for (let i = 0; i < tree.length; i++)
              for (const [pid, parent] of rows)
                if (pid && parent === tree[i] && !tree.includes(pid)) tree.push(pid);
            for (const pid of tree.reverse()) {
              try {
                process.kill(pid, "SIGKILL");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              }
            }
          }
          if (closed && !hasClosed) {
            await new Promise<void>((done, fail) => {
              const deadline = setTimeout(() => fail(new Error("COMMAND_TREE_STOP_FAILED")), 5_000);
              void closed?.then(() => {
                clearTimeout(deadline);
                done();
              });
            });
          }
        }
      })();
      cleanup();
      // Never allow a caller to start rollback until the process tree has exited.
      void stopping.then(
        () => reject(new Error(reason)),
        () => reject(new Error("COMMAND_TREE_STOP_FAILED")),
      );
    };
    const abort = () => terminate("INTERRUPTED");
    const child = exec(
      invocation.command,
      invocation.arguments,
      {
        env,
        cwd: env.HOME ?? env.USERPROFILE ?? homedir(),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
      (error, stdout, stderr) => {
        if (stopping) return;
        if (error?.killed) {
          terminate("Harness command timed out");
          return;
        }
        completed = true;
        cleanup();
        if (error)
          reject(
            new Error(
              error.code === "EACCES" ||
                error.code === "EPERM" ||
                /\b(?:EACCES|EPERM)\b/.test(stderr)
                ? "COMMAND_PERMISSION_DENIED"
                : error.killed
                  ? "Harness command timed out"
                  : "Harness command failed; check the native installation and retry",
            ),
          );
        else resolve((stdout || stderr).trim());
      },
    );
    if (child.pid && typeof child.once === "function")
      closed = new Promise((done) => {
        child.once("close", () => {
          hasClosed = true;
          done();
        });
      });
    child.stdin?.end();
    if (!completed) {
      timer = setTimeout(() => terminate("Harness command timed out"), timeout);
      control.signal?.addEventListener("abort", abort, { once: true });
      if (control.signal?.aborted) abort();
    }
  });
}

export function installationVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^v?\d+(?:\.\d+){1,3}(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value.trim())
  )
    throw new Error("Harness returned an invalid version");
  return value.trim().replace(/^v/, "");
}

export function versionFromOutput(output: string): string {
  return installationVersion(output.match(/\b\d+(?:\.\d+){1,3}(?:-[\w.-]+)?(?:\+[\w.-]+)?\b/)?.[0]);
}

/** Preserve release/prerelease ordering; build metadata does not select an update. */
export function newerInstallationVersion(current: string, latest: string): boolean {
  const a = installationVersion(current).replace(/\+.*/, "");
  const b = installationVersion(latest).replace(/\+.*/, "");
  const coreA = a.replace(/-.*/, "").split(".").map(BigInt);
  const coreB = b.replace(/-.*/, "").split(".").map(BigInt);
  for (let i = 0; i < Math.max(coreA.length, coreB.length); i++) {
    if ((coreA[i] ?? 0n) !== (coreB[i] ?? 0n)) return (coreB[i] ?? 0n) > (coreA[i] ?? 0n);
  }
  const preA = a.includes("-") ? a.slice(a.indexOf("-") + 1).split(".") : [];
  const preB = b.includes("-") ? b.slice(b.indexOf("-") + 1).split(".") : [];
  if (!preA.length || !preB.length) return !!preA.length && !preB.length;
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) {
      if (BigInt(x) === BigInt(y)) continue;
      return BigInt(y) > BigInt(x);
    }
    if (numericX !== numericY) return numericX;
    return y > x;
  }
  return false;
}

/** Concurrent clicks share one update; checks cannot race its readback. */
export function createInstallationManager(options: {
  check(): Promise<InstallationState>;
  update(state: InstallationState): Promise<void>;
}) {
  let checking: Promise<InstallationState> | undefined;
  let updating: Promise<InstallationState> | undefined;
  const check = () =>
    (checking ??= options.check().finally(() => {
      checking = undefined;
    }));
  return (action: "check" | "update"): Promise<InstallationState> => {
    if (updating) return updating;
    if (action === "check") return check();
    updating = (async () => {
      const before = await check();
      if (!before.updateAvailable) return before;
      if (!before.canUpdate)
        throw new Error(before.message ?? "This installation cannot be updated automatically");
      await options.update(before);
      const after = await check();
      if (after.currentVersion === before.currentVersion)
        throw new Error("The Harness version did not change; check the native updater and retry");
      return after;
    })().finally(() => {
      updating = undefined;
    });
    return updating;
  };
}

export async function fetchInstallationText(url: string): Promise<string> {
  const request = async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Could not check the latest Harness version");
    return response.text();
  };
  try {
    return await request();
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    )
      throw error;
    return request();
  }
}
