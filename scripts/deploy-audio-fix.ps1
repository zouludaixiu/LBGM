$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $project 'node_modules\electron\dist\electron.exe'
$watchdog = Join-Path $PSScriptRoot 'AudioRouteWatchdog.exe'
$newWatchdog = Join-Path $PSScriptRoot 'AudioRouteWatchdog.new.exe'

if (-not (Test-Path -LiteralPath $electron)) { throw 'Electron executable was not found.' }
if (-not (Test-Path -LiteralPath $newWatchdog)) { throw 'Compiled watchdog update was not found.' }

# This Electron binary belongs only to LBGM. Stop the complete process tree so
# the watchdog executable can be replaced without leaving a stale renderer.
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -eq $electron -or $_.Name -eq 'AudioRouteWatchdog.exe' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

Move-Item -LiteralPath $newWatchdog -Destination $watchdog -Force

Start-Process -FilePath $electron -ArgumentList ('"' + $project + '"') -WorkingDirectory $project

[pscustomobject]@{
  ok = $true
  restarted = $true
  watchdog = $watchdog
} | ConvertTo-Json -Compress
