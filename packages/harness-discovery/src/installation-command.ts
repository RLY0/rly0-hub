import { execFile, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { commandInvocation } from "./invocation.js";
import { withNodeRuntimeOnPath } from "./node-runtime.js";

function commandError(platform: NodeJS.Platform, code?: string, stderr = ""): Error {
  if (code === "EACCES" || /\bEACCES\b/.test(stderr)) return new Error("COMMAND_PERMISSION_DENIED");
  if (code === "EPERM" || /\bEPERM\b/.test(stderr))
    return new Error(platform === "win32" ? "COMMAND_FILE_IN_USE" : "COMMAND_PERMISSION_DENIED");
  return new Error("Harness command failed; check the native installation and retry");
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
    spawn?: typeof spawn;
    exec?: typeof execFile;
    kill?: typeof process.kill;
    killTree?: (pid: number) => Promise<void>;
  } = {},
): Promise<string> {
  const env = withNodeRuntimeOnPath(environment);
  const invocation = /\.[cm]?js$/i.test(command)
    ? commandInvocation(process.execPath, [command, ...args], env, platform)
    : commandInvocation(command, args, env, platform);
  return new Promise((resolve, reject) => {
    if (control.signal?.aborted) return reject(new Error("INTERRUPTED"));
    let child: ChildProcess;
    try {
      child = (control.spawn ?? spawn)(invocation.command, invocation.arguments, {
        env,
        cwd: env.HOME ?? env.USERPROFILE ?? homedir(),
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        // execFile does not forward detached to spawn. Own a new POSIX process group so that
        // even reparented npm/script descendants can be terminated without scanning other apps.
        detached: platform !== "win32",
        stdio: "pipe",
      });
    } catch (error) {
      reject(commandError(platform, (error as NodeJS.ErrnoException).code));
      return;
    }
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let completed = false;
    let stopping = false;
    let hasClosed = false;
    let startError: NodeJS.ErrnoException | undefined;
    const closed = Promise.withResolvers<undefined>();
    const cleanup = () => {
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", abort);
    };
    const waitForClose = async () => {
      if (hasClosed) return;
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closed.promise,
          new Promise<never>((_, fail) => {
            deadline = setTimeout(() => fail(new Error("COMMAND_TREE_STOP_FAILED")), 5_000);
          }),
        ]);
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    };
    const terminate = (reason: string) => {
      if (completed || stopping) return;
      stopping = true;
      cleanup();
      void (async () => {
        if (child.pid) {
          if (control.killTree) await control.killTree(child.pid);
          else if (platform === "win32") {
            try {
              await new Promise<void>((done, fail) => {
                (control.exec ?? execFile)(
                  "taskkill.exe",
                  ["/PID", String(child.pid), "/T", "/F"],
                  { env, windowsHide: true, timeout: 5_000 },
                  (error) => (error ? fail(error) : done()),
                );
              });
            } catch {
              // taskkill may lose the race with normal exit; closed pipes confirm completion.
              await waitForClose();
            }
          } else {
            const kill = control.kill ?? process.kill;
            try {
              kill(-child.pid, "SIGKILL");
            } catch (error) {
              // Always attempt the direct child if group signalling fails. Unknown group
              // failures still block rollback even if the direct child subsequently closes.
              try {
                kill(child.pid, "SIGKILL");
              } catch (direct) {
                if ((direct as NodeJS.ErrnoException).code !== "ESRCH") throw direct;
              }
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
          await waitForClose();
        }
        reject(new Error(reason));
      })().catch(() => reject(new Error("COMMAND_TREE_STOP_FAILED")));
    };
    const abort = () => terminate("INTERRUPTED");
    const timer = setTimeout(() => terminate("Harness command timed out"), timeout);
    child.once("error", (error: NodeJS.ErrnoException) => {
      startError = error;
    });
    child.once("close", (code) => {
      hasClosed = true;
      closed.resolve(undefined);
      if (stopping) return;
      completed = true;
      cleanup();
      if (startError || code !== 0) reject(commandError(platform, startError?.code, stderr));
      else resolve((stdout || stderr).trim());
    });
    for (const [stream, output] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ] as const) {
      stream?.setEncoding("utf8");
      stream?.on("data", (text: string) => {
        if (stopping) return;
        bytes += Buffer.byteLength(text);
        if (bytes > 1024 * 1024) {
          terminate("Harness command output exceeded limit");
          return;
        }
        if (output === "stdout") stdout += text;
        else stderr += text;
      });
    }
    child.stdin?.end();
    control.signal?.addEventListener("abort", abort, { once: true });
    if (control.signal?.aborted) abort();
  });
}
