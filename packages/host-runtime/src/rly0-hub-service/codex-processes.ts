import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

/**
 * "强制关闭 Codex" when the RLY/0 Launcher cannot do it (Codex was opened some other way, or the
 * Launcher already exited). Ends, by executable path only, the processes that belong to Codex:
 *
 * - Codex Desktop from the Microsoft Store package (`\WindowsApps\OpenAI.Codex_*`) or a portable
 *   copy (`CODEXHOST_INSTALL_ROOT\app\`), and the CLI it manages (`%LOCALAPPDATA%\OpenAI\Codex\`);
 * - this program's Codex-side helpers in the install root (Launcher, shim, REPL) and the bundled
 *   Node running inside Codex.
 *
 * Never the Hub itself: `rly0-hub.exe`, its own service process (and its parent), the updater and
 * rly0-core are left alone. Returns how many processes were ended.
 */
export function killCodexProcesses(options: {
  environment: NodeJS.ProcessEnv;
  installRoot: string;
}): Promise<number> {
  if (process.platform === "darwin") return quitMacCodex(defaultMacProcessDependencies());
  if (process.platform !== "win32") return Promise.resolve(0);
  const { environment, installRoot } = options;
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$keep = @([int]$env:RLY0_KEEP_PID, [int]$env:RLY0_KEEP_PARENT)
$local = $env:RLY0_CODEX_LOCAL
$portable = $env:RLY0_CODEX_PORTABLE
$root = $env:RLY0_INSTALL_ROOT
$helpers = @('codexhost.exe','codexhost-start.exe','codexhost-shim.exe','codexhost-node-repl.exe')
$n = 0
foreach ($p in Get-CimInstance Win32_Process) {
  $exe = $p.ExecutablePath
  if (-not $exe -or $keep -contains [int]$p.ProcessId) { continue }
  # Codex Desktop starts the shim, REPL and CLI through \\?\ paths, which StartsWith would miss.
  if ($exe.StartsWith('\\?\')) { $exe = $exe.Substring(4) }
  $name = [IO.Path]::GetFileName($exe).ToLowerInvariant()
  $hit = $exe -like '*\WindowsApps\OpenAI.Codex_*'
  if (-not $hit -and $local) { $hit = $exe.StartsWith($local, [StringComparison]::OrdinalIgnoreCase) }
  if (-not $hit -and $portable) { $hit = $exe.StartsWith($portable, [StringComparison]::OrdinalIgnoreCase) }
  if (-not $hit -and $root -and $exe.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    if ($helpers -contains $name) { $hit = $true }
    elseif ($name -eq 'node.exe' -and $p.CommandLine -notlike '*hub-service*') { $hit = $true }
  }
  if ($hit) { Stop-Process -Id $p.ProcessId -Force; if ($?) { $n++ } }
}
Write-Output $n
`;
  const local = environment.LOCALAPPDATA
    ? `${path.join(environment.LOCALAPPDATA, "OpenAI", "Codex")}\\`
    : "";
  const portable = environment.CODEXHOST_INSTALL_ROOT
    ? `${path.join(environment.CODEXHOST_INSTALL_ROOT, "app")}\\`
    : "";
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...process.env,
          RLY0_KEEP_PID: String(process.pid),
          RLY0_KEEP_PARENT: String(process.ppid),
          RLY0_CODEX_LOCAL: local,
          RLY0_CODEX_PORTABLE: portable,
          RLY0_INSTALL_ROOT: `${path.resolve(installRoot)}\\`,
        },
      },
      (_error, stdout) => {
        const count = Number.parseInt(String(stdout).trim().split(/\s+/u).pop() ?? "", 10);
        resolve(Number.isSafeInteger(count) && count > 0 ? count : 0);
      },
    );
  });
}

/** One row of `ps -axo pid=,args=`. */
export interface MacProcessEntry {
  readonly pid: number;
  readonly args: string;
}

/**
 * macOS: the Codex Desktop main process (`ChatGPT.app` / `Codex.app`, by its own executable only;
 * its Electron helpers end with it) and the codexhost helpers started for it from the npm package
 * (`codexhost launch`, Host Runtime, Desktop controller). The codexhost web console, the Hub and
 * rly0-core are left alone, as are the given `keep` PIDs.
 */
export function selectMacCodexProcesses(
  entries: readonly MacProcessEntry[],
  keep: ReadonlySet<number>,
): { app: number[]; helpers: number[] } {
  const app: number[] = [];
  const helpers: number[] = [];
  // The executable must be the first token: a " /" before the bundle means another program merely
  // received the path as an argument.
  const appPattern =
    /^\/(?:(?! \/)[^\n])*?\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)(?:\s|$)/u;
  const helperPattern =
    /\/@codexhost\/cli-darwin-(?:arm64|x64)\/(?:bin\/codexhost launch(?:\s|$)|app\/(?:host-runtime|desktop-controller)\.mjs(?:\s|$))/u;
  for (const { pid, args } of entries) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || keep.has(pid)) continue;
    if (appPattern.test(args)) app.push(pid);
    else if (helperPattern.test(args)) helpers.push(pid);
  }
  return { app, helpers };
}

export interface MacProcessDependencies {
  list(): Promise<MacProcessEntry[]>;
  /** Asks Codex Desktop to quit normally (AppleScript `quit`), so it saves its state first. */
  requestQuit(): Promise<void>;
  alive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  keep: ReadonlySet<number>;
}

async function waitGone(
  pids: readonly number[],
  dependencies: MacProcessDependencies,
  timeoutMs: number,
): Promise<number[]> {
  let left = pids.filter((pid) => dependencies.alive(pid));
  for (let waited = 0; left.length > 0 && waited < timeoutMs; waited += 250) {
    await dependencies.sleep(250);
    left = left.filter((pid) => dependencies.alive(pid));
  }
  return left;
}

async function endProcesses(
  pids: readonly number[],
  dependencies: MacProcessDependencies,
  graceMs: number,
): Promise<void> {
  let left = await waitGone(pids, dependencies, graceMs);
  for (const pid of left) dependencies.signal(pid, "SIGTERM");
  left = await waitGone(left, dependencies, 5_000);
  for (const pid of left) dependencies.signal(pid, "SIGKILL");
  await waitGone(left, dependencies, 2_000);
}

/**
 * Quits Codex Desktop on macOS the way ⌘Q does, waits for it and its codexhost helpers to exit,
 * and only then ends whatever is still running. Returns how many of the matched processes ended.
 */
export async function quitMacCodex(dependencies: MacProcessDependencies): Promise<number> {
  const { app, helpers } = selectMacCodexProcesses(await dependencies.list(), dependencies.keep);
  if (app.length === 0 && helpers.length === 0) return 0;
  if (app.length > 0) {
    await dependencies.requestQuit().catch(() => undefined);
    await endProcesses(app, dependencies, 15_000);
  }
  // The Launcher and Host Runtime exit by themselves once the Desktop is gone.
  await endProcesses(helpers, dependencies, 5_000);
  return [...app, ...helpers].filter((pid) => !dependencies.alive(pid)).length;
}

function execText(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
  });
}

function defaultMacProcessDependencies(): MacProcessDependencies {
  return {
    async list() {
      const output = await execText("/bin/ps", ["-axo", "pid=,args="]);
      return output.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
        return match ? [{ pid: Number(match[1]), args: match[2] ?? "" }] : [];
      });
    },
    async requestQuit() {
      await execText("/usr/bin/osascript", [
        "-e",
        'if application id "com.openai.codex" is running then tell application id "com.openai.codex" to quit',
      ]);
    },
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    signal(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    },
    sleep: (ms) => delay(ms),
    keep: new Set([process.pid, process.ppid]),
  };
}
