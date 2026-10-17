$ErrorActionPreference = 'Stop'

# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in
# the legacy ANSI codepage, which corrupts non-ASCII literals.

$root = Split-Path -Parent $PSScriptRoot
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw '.NET Framework 64-bit compiler was not found at the expected location.' }

# The hotkey helper executable is locked while the soundboard runs.
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq $electron }
if ($running) { throw 'The soundboard is still running. Quit it from the tray before building.' }

# NOTE: the hotkey helper source keeps its historical name (GameHotkeyHelper.cs)
# while the deployed binary must stay GameHotkeyStateHelperV2.exe, because the
# Electron main process launches that exact file name.
$helperSrc = Join-Path $PSScriptRoot 'GameHotkeyHelper.cs'
$helperOut = Join-Path $PSScriptRoot 'GameHotkeyStateHelperV2.exe'
& $csc /nologo /optimize+ /platform:x64 /target:winexe /out:"$helperOut" "$helperSrc"
if ($LASTEXITCODE -ne 0) { throw 'GameHotkeyStateHelperV2.exe compilation failed.' }

node --check (Join-Path $root 'main.js')
if ($LASTEXITCODE -ne 0) { throw 'main.js syntax check failed.' }
node --check (Join-Path $root 'renderer\app.js')
if ($LASTEXITCODE -ne 0) { throw 'renderer/app.js syntax check failed.' }

[pscustomobject]@{
  ok = $true
  hotkeyHelper = $helperOut
  note = 'The game hotkey helper is ready for packaging.'
} | ConvertTo-Json -Compress
