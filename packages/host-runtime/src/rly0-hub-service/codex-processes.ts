import { execFile } from "node:child_process";
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
