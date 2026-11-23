import { execFile } from "node:child_process";
import { runPowerShell, type PowerShellRunner } from "./codex-store-hold.js";

/**
 * Windows: bring Codex itself to the verified build the Microsoft Store offers ("放行即更新",
 * user decision). Only the Codex package is updated; the Store's Windows-wide "app updates"
 * switch (codex-store-hold.ts) keeps its own meaning, so a person who keeps it off (`user-off`)
 * still gets the one verified Codex build and nothing else.
 *
 * Route 1, the Store's own install queue through WinRT (the same AppInstallManager the hold
 * uses): `SearchForUpdatesAsync(productId, "", "", "", AppUpdateOptions)` with
 * `AutomaticallyDownloadAndInstallUpdateIfFound` (Windows 10 1809+), falling back to
 * `UpdateAppByPackageFamilyNameAsync(pfn)`. Documented capability: runFullTrust, which an
 * unpackaged PowerShell has; no administrator rights are documented for a per-user update (the
 * AutoUpdateSetting write from the same bridge worked unelevated on Windows 11 Home, trial
 * 2026-11-13). The returned AppInstallItem is queued in Windows' InstallService, which keeps
 * downloading after the PowerShell process exits; the manager confirms the result only by the
 * installed version, never by the script's word.
 *
 * Route 2, winget's msstore source. winget is an app execution alias in
 * %LOCALAPPDATA%\Microsoft\WindowsApps, which a service PATH may lack; the caller finds it the
 * way agent-installer.ts does.
 */
export const CODEX_STORE_PRODUCT_ID = "9PLM9XGG6VKS";
export const CODEX_PACKAGE_NAME = "OpenAI.Codex";
export const CODEX_STORE_PAGE_URL = `ms-windows-store://pdp/?productid=${CODEX_STORE_PRODUCT_ID}`;
export const WINGET_UPGRADE_ARGS = [
  "upgrade",
  "--id",
  CODEX_STORE_PRODUCT_ID,
  "--source",
  "msstore",
  "--silent",
  "--accept-package-agreements",
  "--accept-source-agreements",
  "--disable-interactivity",
] as const;
/** APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE (0x8A15002B): nothing newer for this machine. */
export const WINGET_UPDATE_NOT_APPLICABLE = 0x8a15002b;

/** What the Store's install queue said within the script's short watch (≤ ~20 s). */
export type StoreUpdateStart = "started" | "completed" | "no-update";
/** What winget said when it exited. */
export type WingetUpgradeResult = "installed" | "no-update";

export interface WindowsCodexUpdateDriver {
  /** Queue the Codex update in the Store; throws when the Store refused or reported an error. */
  storeUpdate(): Promise<StoreUpdateStart>;
  /** Run winget to the end (bounded by its own timeout); throws when missing or failed. */
  wingetUpgrade(): Promise<WingetUpgradeResult>;
  /** Unreadable counts as running (never risk reopening a second Codex). */
  isRunning(): Promise<boolean>;
  /** True only when Codex Desktop is known to have exited. */
  installationStopped(): Promise<boolean>;
  quit(): Promise<void>;
  /** Starts Codex; true only means the start was issued. */
  reopen(): Promise<boolean>;
  healthy(): Promise<boolean>;
}

/**
 * Searches the Store for a Codex update and queues it. Prints `STORE=started|completed|no-update`
 * or `STORE=error <hresult>`; a WinRT exception exits non-zero (PowerShell's own error).
 */
export function storeUpdateScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager, Windows.ApplicationModel.Store.Preview, ContentType = WindowsRuntime]
[void][Windows.ApplicationModel.Store.Preview.InstallControl.AppUpdateOptions, Windows.ApplicationModel.Store.Preview, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${"`"}1' } | Select-Object -First 1
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  if (-not $task.Wait(45000)) { throw 'STORE_TIMEOUT' }
  $task.Result
}
$itemType = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallItem]
$m = New-Object Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager
$o = New-Object Windows.ApplicationModel.Store.Preview.InstallControl.AppUpdateOptions
$o.AutomaticallyDownloadAndInstallUpdateIfFound = $true
$o.AllowForcedAppRestart = $true
$item = Await ($m.SearchForUpdatesAsync('${CODEX_STORE_PRODUCT_ID}', '', '', '', $o)) $itemType
if ($null -eq $item) {
  $pkg = Get-AppxPackage -Name '${CODEX_PACKAGE_NAME}' | Select-Object -First 1
  if ($pkg) { $item = Await ($m.UpdateAppByPackageFamilyNameAsync($pkg.PackageFamilyName)) $itemType }
}
if ($null -eq $item) { Write-Output 'STORE=no-update'; exit 0 }
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $s = $item.GetCurrentStatus()
  $state = [string]$s.InstallState
  if ($state -eq 'Completed') { Write-Output 'STORE=completed'; exit 0 }
  if ($state -eq 'Error' -or $state -eq 'Canceled') {
    $code = if ($s.ErrorCode) { '0x{0:X8}' -f $s.ErrorCode.HResult } else { $state }
    Write-Output ('STORE=error ' + $code); exit 0
  }
  Start-Sleep -Milliseconds 1000
}
Write-Output 'STORE=started'
`;
}

export function parseStoreUpdate(output: string): StoreUpdateStart {
  const match = /STORE=([\w-]+)/u.exec(output);
  const value = match?.[1];
  if (value === "started" || value === "completed" || value === "no-update") return value;
  throw new Error("CODEX_STORE_UPDATE_FAILED");
}

/** winget's exit code: 0 installed; "no applicable update" is not an install. */
export function wingetResult(code: number | null): WingetUpgradeResult {
  if (code === 0) return "installed";
  // Node reports Windows exit codes as unsigned 32-bit or as a negative int32.
  if (code !== null && code >>> 0 === WINGET_UPDATE_NOT_APPLICABLE) return "no-update";
  throw new Error("CODEX_WINGET_FAILED");
}

export type WingetRunner = (
  file: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => Promise<number | null>;
export const runWinget: WingetRunner = (file, args, environment) =>
  new Promise((resolve) => {
    // shell:false; an app execution alias is started by CreateProcess like any executable.
    execFile(
      file,
      [...args],
      { env: environment, timeout: 20 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error) => {
        if (!error) return resolve(0);
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        resolve(typeof code === "number" ? code : null);
      },
    );
  });

export function createWindowsCodexUpdateDriver(options: {
  run?: PowerShellRunner;
  /** Full path of winget (alias included), or null when it is not installed. */
  findWinget: () => Promise<{ file: string; environment: NodeJS.ProcessEnv } | null>;
  runWinget?: WingetRunner;
  desktopRunning: () => Promise<boolean | null>;
  quit: () => Promise<boolean>;
  reopen: () => Promise<boolean>;
  healthy: () => Promise<boolean>;
}): WindowsCodexUpdateDriver {
  const run = options.run ?? runPowerShell;
  return {
    storeUpdate: async () => {
      const output = await run(storeUpdateScript(), 150_000).catch(() => {
        throw new Error("CODEX_STORE_UPDATE_FAILED");
      });
      return parseStoreUpdate(output);
    },
    wingetUpgrade: async () => {
      const winget = await options.findWinget();
      if (!winget) throw new Error("CODEX_WINGET_UNAVAILABLE");
      return wingetResult(
        await (options.runWinget ?? runWinget)(
          winget.file,
          WINGET_UPGRADE_ARGS,
          winget.environment,
        ),
      );
    },
    isRunning: async () => (await options.desktopRunning().catch(() => null)) !== false,
    installationStopped: async () => (await options.desktopRunning().catch(() => null)) === false,
    quit: async () => {
      if (!(await options.quit())) throw new Error("CODEX_QUIT_FAILED");
    },
    reopen: options.reopen,
    healthy: options.healthy,
  };
}

/**
 * Milliseconds since the last keyboard/mouse input in this session (GetLastInputInfo), or null.
 * One reading serves 10 seconds: each read starts PowerShell and compiles a small type.
 */
export function windowsInputIdleMs(
  run: PowerShellRunner = runPowerShell,
  now: () => number = Date.now,
): () => Promise<number | null> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Rly0 -Name Input -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
public static long IdleMs() {
  var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
  if (!GetLastInputInfo(ref info)) return -1;
  return (long)unchecked((uint)Environment.TickCount - info.dwTime);
}
'@
Write-Output ('IDLE=' + [Rly0.Input]::IdleMs())
`;
  let cached: { at: number; value: number | null } | null = null;
  return async () => {
    const at = now();
    if (cached && at - cached.at < 10_000) return cached.value;
    let value: number | null = null;
    try {
      const match = /IDLE=(-?\d+)/u.exec(await run(script));
      const parsed = match?.[1] ? Number(match[1]) : NaN;
      value = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    } catch {
      value = null;
    }
    cached = { at, value };
    return value;
  };
}
