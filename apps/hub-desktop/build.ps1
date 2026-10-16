#Requires -Version 7.0
# Builds the standalone RLY/0 Hub window into an existing payload folder:
#   bin/rly0-hub.exe (+ WebView2 SDK DLLs, icon), app/hub-ui/, app/hub-service.mjs
# Uses the .NET Framework compiler that ships with Windows and the pinned WebView2 SDK package.
[CmdletBinding()] param([Parameter(Mandatory)] [string] $PayloadRoot)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$payload = [IO.Path]::GetFullPath($PayloadRoot)
if (-not (Test-Path -LiteralPath (Join-Path $payload 'runtime/node.exe'))) { throw "Not a payload folder (runtime/node.exe missing): $payload" }

$sdkVersion = '1.0.3537.50'
$sdkHash = '5EA526BBD728ADDA0DA4D31219267E96460494A427E4894C4E09D9F320F4B9AA'
$cache = Join-Path $repo '.codexhost/release-cache/webview2'
$null = New-Item -ItemType Directory -Path $cache -Force
$package = Join-Path $cache "microsoft.web.webview2.$sdkVersion.nupkg"
if (-not (Test-Path -LiteralPath $package)) {
    Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile $package -TimeoutSec 120
}
if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $sdkHash) { throw 'WebView2 SDK package hash mismatch' }
$sdk = Join-Path $cache "webview2-$sdkVersion"
if (-not (Test-Path -LiteralPath $sdk)) { [IO.Compression.ZipFile]::ExtractToDirectory($package, $sdk) }

$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework compiler not found' }

$bin = Join-Path $payload 'bin'
$null = New-Item -ItemType Directory -Path $bin -Force
foreach ($dll in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')) {
    Copy-Item -LiteralPath (Join-Path $sdk "lib/net462/$dll") -Destination $bin -Force
}
Copy-Item -LiteralPath (Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $bin -Force
$icon = Join-Path $bin 'rly0-hub.ico'
Copy-Item -LiteralPath (Join-Path $repo 'crates/launcher/assets/codexhost.ico') -Destination $icon -Force

$exe = Join-Path $bin 'rly0-hub.exe'
$arguments = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', "/out:$exe", "/win32icon:$icon",
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll',
    ('/r:' + (Join-Path $bin 'Microsoft.Web.WebView2.Core.dll')), ('/r:' + (Join-Path $bin 'Microsoft.Web.WebView2.WinForms.dll')),
    (Join-Path $PSScriptRoot 'Rly0Hub.cs'))
$output = & $compiler @arguments 2>&1
if ($LASTEXITCODE -ne 0) { $output | Write-Output; throw 'Hub window compilation failed' }

$ui = Join-Path $payload 'app/hub-ui'
if (Test-Path -LiteralPath $ui) { Remove-Item -LiteralPath $ui -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'www') -Destination $ui -Recurse

& node (Join-Path $repo 'packages/host-runtime/scripts/build-hub-service.mjs') --output (Join-Path $payload 'app/hub-service.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Hub service bundle failed' }
$licenses = Join-Path $payload 'licenses'
$null = New-Item -ItemType Directory -Path $licenses -Force
Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $licenses 'WebView2-SDK-LICENSE.txt') -Force
$notices = Join-Path $payload 'THIRD_PARTY_NOTICES.txt'
if ((Test-Path -LiteralPath $notices) -and -not (Select-String -LiteralPath $notices -SimpleMatch 'Microsoft.Web.WebView2' -Quiet)) {
    Add-Content -LiteralPath $notices -Encoding utf8NoBOM -Value @(
        '',
        "Microsoft.Web.WebView2 $sdkVersion (RLY/0 Hub window)",
        'License text: licenses/WebView2-SDK-LICENSE.txt',
        '',
        'Geist font (RLY/0 Hub window)',
        'License: SIL Open Font License 1.1',
        'License text: app/hub-ui/fonts/OFL-LICENSE.txt')
}
Write-Output "RLY/0 Hub window built: $exe"
