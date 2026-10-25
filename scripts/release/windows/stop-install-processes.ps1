<#
  Run by the installer before it replaces files: ends every process whose executable lives in the
  install directory, so no file in it is held open.

  Running executables cannot be deleted (DeleteFile fails with error 5), and the Restart Manager
  cannot close windowless console helpers such as codexhost-node-repl.exe, which Codex Desktop's
  CLI and Claude Code start as MCP servers from outside the install directory.

  -Mode Detect   prints what is running and exits 2 when Codex Desktop uses this install (it would
                 start the shim again if only the shim were ended), else 0.
  -Mode Stop     ends them: politely first, then by force, again until none is left or the
                 timeout passes. With -CloseCodex, Codex Desktop and the Codex CLI go too.
                 Files of processes that still cannot be ended are renamed aside, which Windows
                 allows for a running executable, so the copy that follows can write the new file.
                 Exits 0 when every file can be replaced, else 1.
  Leftovers renamed aside by an earlier run are deleted whenever they are no longer in use.
#>
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [ValidateSet('Detect', 'Stop')][string]$Mode = 'Stop',
  [switch]$CloseCodex,
  [int]$TimeoutSeconds = 20,
  # Wildcards for where Codex Desktop and its CLI run from; tests use a throwaway folder.
  [string[]]$CodexPatterns
)

$ErrorActionPreference = 'SilentlyContinue'
$root = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\') + '\'
if (-not $CodexPatterns) {
  $CodexPatterns = @('*\WindowsApps\OpenAI.Codex_*')
  if ($env:LOCALAPPDATA) { $CodexPatterns += (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex') + '\*' }
}
$asideSuffix = '.rly0-old-'

function Get-PlainPath([string]$Path) {
  if (-not $Path) { return $null }
  # Codex Desktop starts helpers through \\?\ paths; compare them like any other path.
  if ($Path.StartsWith('\\?\')) { return $Path.Substring(4) }
  return $Path
}

function Test-Under([string]$Path, [string]$Dir) {
  return $Path -and $Dir -and $Path.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase)
}

function Test-CodexExecutable([string]$Path) {
  foreach ($pattern in $CodexPatterns) { if ($Path -and $Path -like $pattern) { return $true } }
  return $false
}

function Get-Targets([bool]$WithCodex) {
  $all = @(Get-CimInstance Win32_Process)
  $byId = @{}
  foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
  # This script and the installer above it are never ended, even when the Hub started the
  # installer and so is its ancestor.
  $keep = @{}
  $id = $PID
  while ($id -and $byId.ContainsKey($id) -and -not $keep.ContainsKey($id)) {
    $keep[$id] = $true
    $id = [int]$byId[$id].ParentProcessId
  }
  $hit = @{}
  foreach ($p in $all) {
    $exe = Get-PlainPath $p.ExecutablePath
    if ((Test-Under $exe $root) -or ($WithCodex -and (Test-CodexExecutable $exe))) { $hit[[int]$p.ProcessId] = $true }
  }
  # What those processes started (Claude Code under the Host, its MCP servers) goes with them;
  # Codex Desktop itself only when closing it was agreed to.
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $all) {
      $pid0 = [int]$p.ProcessId
      if ($hit.ContainsKey($pid0) -or -not $hit.ContainsKey([int]$p.ParentProcessId)) { continue }
      if ([int]$p.ParentProcessId -eq $pid0) { continue }
      if (-not $WithCodex -and (Test-CodexExecutable (Get-PlainPath $p.ExecutablePath))) { continue }
      $hit[$pid0] = $true
      $grew = $true
    }
  }
  $result = @()
  foreach ($p in $all) {
    $pid0 = [int]$p.ProcessId
    if (-not $hit.ContainsKey($pid0) -or $keep.ContainsKey($pid0)) { continue }
    $result += [pscustomobject]@{ Id = $pid0; Path = (Get-PlainPath $p.ExecutablePath); Name = [string]$p.Name }
  }
  return , $result
}

function Test-CodexUsesInstall {
  # The shim or launcher running from here means Codex Desktop is attached to this install.
  foreach ($t in (Get-Targets $false)) {
    if (-not (Test-Under $t.Path $root)) { continue }
    if (@('codexhost-shim.exe', 'codexhost.exe') -contains $t.Name.ToLowerInvariant()) { return $true }
  }
  return $false
}

function Remove-Leftovers {
  Get-ChildItem -LiteralPath $root -Recurse -File -Force -Filter "*$asideSuffix*" |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
}

function Wait-Gone([int[]]$Ids, [int]$Milliseconds) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($Milliseconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $Ids)) { return }
    Start-Sleep -Milliseconds 200
  }
}

if ($Mode -eq 'Detect') {
  foreach ($t in (Get-Targets $false)) { Write-Output ("{0} {1}" -f $t.Id, $t.Path) }
  if (Test-CodexUsesInstall) { exit 2 }
  exit 0
}

Remove-Leftovers
$withCodex = [bool]$CloseCodex
$deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSeconds))
$polite = $true
while ($true) {
  $targets = Get-Targets $withCodex
  if ($targets.Count -eq 0) { break }
  if ([DateTime]::UtcNow -ge $deadline) { break }
  $ids = @($targets | ForEach-Object { $_.Id })
  if ($polite) {
    # Windowed apps (the Hub tray, Codex Desktop) get a chance to close cleanly.
    foreach ($id in $ids) { $proc = Get-Process -Id $id; if ($proc -and $proc.MainWindowHandle -ne 0) { [void]$proc.CloseMainWindow() } }
    Wait-Gone $ids 3000
    $polite = $false
    continue
  }
  foreach ($id in $ids) { Stop-Process -Id $id -Force }
  Wait-Gone $ids 2000
}

# Handles of ended processes are released asynchronously.
Start-Sleep -Milliseconds 500
$remaining = Get-Targets $withCodex
if ($remaining.Count -eq 0) { Remove-Leftovers; exit 0 }

$blocked = $false
foreach ($t in $remaining) {
  Write-Output ("still running: {0} {1}" -f $t.Id, $t.Path)
  $files = @($t.Path)
  $proc = Get-Process -Id $t.Id
  if ($proc) { $files += @($proc.Modules | ForEach-Object { Get-PlainPath $_.FileName }) }
  foreach ($file in ($files | Where-Object { Test-Under $_ $root } | Select-Object -Unique)) {
    if ($file -like "*$asideSuffix*") { continue }
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $aside = "$file$asideSuffix$([DateTime]::UtcNow.Ticks)"
    try {
      [IO.File]::Move($file, $aside)
      Write-Output ("renamed aside: {0}" -f $file)
    } catch {
      Write-Output ("cannot replace: {0}" -f $file)
      $blocked = $true
    }
  }
}
if ($blocked) { exit 1 }
exit 0
