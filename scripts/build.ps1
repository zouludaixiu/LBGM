$ErrorActionPreference = 'Stop'

# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in
# the legacy ANSI codepage, which corrupts non-ASCII literals.

$root = Split-Path -Parent $PSScriptRoot
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw '.NET Framework 64-bit compiler was not found at the expected location.' }

# The hotkey helper executable is locked while the soundboard runs.
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq $electron -or $_.Name -eq 'AudioRouteWatchdog.exe' }
if ($running) { throw 'The soundboard is still running. Quit it from the tray before building.' }

# NOTE: the hotkey helper source keeps its historical name (GameHotkeyHelper.cs)
# while the deployed binary must stay GameHotkeyStateHelperV2.exe, because the
# Electron main process launches that exact file name.
$helperSrc = Join-Path $PSScriptRoot 'GameHotkeyHelper.cs'
$helperOut = Join-Path $PSScriptRoot 'GameHotkeyStateHelperV2.exe'
& $csc /nologo /optimize+ /platform:x64 /target:winexe /out:"$helperOut" "$helperSrc"
if ($LASTEXITCODE -ne 0) { throw 'GameHotkeyStateHelperV2.exe compilation failed.' }

# Compile the watchdog to .new.exe: the running copy cannot be replaced in
# place. deploy-audio-fix.ps1 stops the app, swaps the file and restarts.
$watchdogSrc = Join-Path $PSScriptRoot 'AudioRouteWatchdog.cs'
$watchdogOut = Join-Path $PSScriptRoot 'AudioRouteWatchdog.new.exe'
& $csc /nologo /optimize+ /platform:x64 /target:winexe /out:"$watchdogOut" "$watchdogSrc"
if ($LASTEXITCODE -ne 0) { throw 'AudioRouteWatchdog compilation failed.' }

node --check (Join-Path $root 'main.js')
node --check (Join-Path $root 'renderer\app.js')

[pscustomobject]@{
  ok = $true
  hotkeyHelper = $helperOut
  watchdog = $watchdogOut
  note = 'Run scripts\deploy-audio-fix.ps1 to swap in AudioRouteWatchdog.new.exe and restart the app.'
} | ConvertTo-Json -Compress
