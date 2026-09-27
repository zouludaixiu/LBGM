param(
  [string]$TargetPath = '',
  [string]$Arguments = '',
  [string]$IconPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $TargetPath) { throw 'TargetPath is required.' }

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutName = ([string][char]0x82F1) + [char]0x96C4 + [char]0x97F3 + [char]0x4E50 + [char]0x53F0 + '.lnk'
$shortcutPath = Join-Path $desktop $shortcutName

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $TargetPath
if ($Arguments) { $shortcut.Arguments = $Arguments }
$shortcut.WorkingDirectory = Split-Path -Parent $TargetPath
$shortcut.Description = 'League champion music soundboard'
$shortcut.IconLocation = "$(if ($IconPath) { $IconPath } else { $TargetPath }),0"
$shortcut.Save()

# Run elevated so the app and the game have the same integrity level.
$bytes = [IO.File]::ReadAllBytes($shortcutPath)
$bytes[0x15] = $bytes[0x15] -bor 0x20
[IO.File]::WriteAllBytes($shortcutPath, $bytes)

[pscustomobject]@{ ok = $true; path = $shortcutPath; runAs = $true } | ConvertTo-Json -Compress
