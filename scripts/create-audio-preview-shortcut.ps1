param([switch]$Packaged)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$electronPath = Join-Path $projectDirectory 'node_modules\electron\dist\electron.exe'
$launchArguments = '"' + $projectDirectory + '" --audio-preview'
if ($Packaged) {
  $electronPath = Join-Path $projectDirectory 'release\internal-audio-preview\win-unpacked\LBGM.exe'
  $launchArguments = '--audio-preview'
}
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) { throw 'Please install the project dependencies first.' }
$shortcutName = 'LBGM ' + (-join (@(0x5185,0x90e8,0x6df7,0x97f3,0x6d4b,0x8bd5,0x7248) | ForEach-Object { [char]$_ })) + '.lnk'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) $shortcutName
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronPath
$shortcut.Arguments = $launchArguments
$shortcut.WorkingDirectory = $projectDirectory
$shortcut.Description = 'LBGM internal audio preview - separate settings, existing music library copied on first launch'
$shortcut.IconLocation = (Join-Path $projectDirectory 'renderer\app.ico') + ',0'
$shortcut.Save()
# Same integrity level as the game for the unchanged global-hotkey helper.
$shortcutBytes = [IO.File]::ReadAllBytes($shortcutPath)
$shortcutBytes[0x15] = $shortcutBytes[0x15] -bor 0x20
[IO.File]::WriteAllBytes($shortcutPath, $shortcutBytes)
[pscustomobject]@{ Path = $shortcutPath; Target = $electronPath; Arguments = $shortcut.Arguments; Elevated = $true } | ConvertTo-Json -Compress
