<#
  Run by the uninstaller: undoes the Hub's own pause of Microsoft Store app updates.

  While the Store offers a Codex build the Hub has not verified, the Hub turns off the Store's
  "app updates" switch (AppInstallManager.AutoUpdateSetting, Windows-wide) and journals the
  original value in %USERPROFILE%\.rly0-hub\codex-store-hold.json
  (packages/host-runtime/src/rly0-hub-service/codex-store-hold.ts). Removing the Hub must not leave
  that switch off. Only the Hub's own change is undone: a journal that records the person's own
  choice (userEnabledFor) is just removed, and a switch someone turned back on is left alone.
  Never fails the uninstall: exits 0 even when the Store cannot be reached (the journal then stays,
  so a reinstalled Hub restores it).
#>
$ErrorActionPreference = 'Stop'
try {
  # The Hub only changes the Store switch when its data folder is the default one
  # (codexStoreControlAllowed), so the journal lives there; CODEXHOST_DATA_DIR is checked too.
  $journal = $null
  foreach ($dir in @($env:CODEXHOST_DATA_DIR, (Join-Path $env:USERPROFILE '.rly0-hub'))) {
    if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'codex-store-hold.json'))) {
      $journal = Join-Path $dir 'codex-store-hold.json'
      break
    }
  }
  if (-not $journal) { exit 0 }
  $restore = $true
  try {
    $value = Get-Content -Raw -LiteralPath $journal | ConvertFrom-Json
    if ($value.userEnabledFor) { $restore = $false }
    elseif ($value.originalValue -and $value.originalValue -ne 'Enabled') { $restore = $false }
  } catch {
    # A damaged journal still proves the Hub turned updates off: restore the Store default.
  }
  if ($restore) {
    [void][Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager, Windows.ApplicationModel.Store.Preview, ContentType = WindowsRuntime]
    $m = New-Object Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager
    if ([string]$m.AutoUpdateSetting -eq 'Disabled') {
      $m.AutoUpdateSetting = [Windows.ApplicationModel.Store.Preview.InstallControl.AutoUpdateSetting]::Enabled
    }
  }
  Remove-Item -LiteralPath $journal -Force
} catch {
  Write-Output ("restore-store-updates: " + $_.Exception.Message)
}
exit 0
