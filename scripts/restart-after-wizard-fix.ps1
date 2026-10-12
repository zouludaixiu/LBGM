$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $project 'node_modules\electron\dist\electron.exe'
$watchdog = Join-Path $PSScriptRoot 'AudioRouteWatchdog.exe'
$hotkeys = Join-Path $PSScriptRoot 'GameHotkeyStateHelperV2.exe'
# These exact executable paths belong to this checkout, not other apps.
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -eq $electron -or $_.ExecutablePath -eq $watchdog -or $_.ExecutablePath -eq $hotkeys } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
Start-Process -FilePath $electron -ArgumentList ('"' + $project + '"') -WorkingDirectory $project
