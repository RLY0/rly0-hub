# RLY/0 Hub - Windows local build entry: load VS C++ env, then run an npm script.
# Usage: pwsh -NoProfile -File scripts/rly0/build-win.ps1 [npm-script, default: build]
param([string]$Task = "build")
$ErrorActionPreference = "Stop"
$vc = Get-ChildItem "C:\Program Files\Microsoft Visual Studio\2022\*\VC\Auxiliary\Build\vcvars64.bat" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $vc) { throw "vcvars64.bat not found: install Visual Studio 2022 'Desktop development with C++'" }
cmd /c "`"$($vc.FullName)`" >nul 2>nul && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
npm run $Task
exit $LASTEXITCODE
