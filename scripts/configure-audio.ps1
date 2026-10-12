param(
  [ValidateRange(-3, 12)]
  [single]$MicGainDb = 12,
  # The app passes the configured device names; the fallbacks keep a standalone
  # run working on the machine this project was built for.
  [string]$Headphones = '',
  [string]$Microphone = '',
  [string]$VoicemeeterDir = 'C:\Program Files (x86)\VB\Voicemeeter'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$voicemeeterExe = Join-Path $VoicemeeterDir 'voicemeeter_x64.exe'
$remoteDll = Join-Path $VoicemeeterDir 'VoicemeeterRemote64.dll'
$stateDirectory = Join-Path $env:APPDATA 'champion-soundboard'
$voicemeeterConfig = Join-Path $stateDirectory 'voicemeeter-lbgm.xml'

if (-not (Test-Path -LiteralPath $voicemeeterExe) -or -not (Test-Path -LiteralPath $remoteDll)) {
  throw "Voicemeeter Standard or its Remote API was not found in '$VoicemeeterDir'."
}

New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

if (-not (Get-Process voicemeeter_x64 -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $voicemeeterExe -WindowStyle Hidden
  Start-Sleep -Seconds 4
}

Add-Type -Path (Join-Path $PSScriptRoot 'PersistentAudio.cs')
if (-not $Headphones -or -not $Microphone) {
  throw 'Device names are required. Pass -Headphones and -Microphone (they are chosen in the first-run wizard or stored in settings.json).'
}
$prefixPattern = '^(?:(?:Default|Communications)\s*[-:]+\s*)+'
$headphones = ($Headphones -replace $prefixPattern, '').Trim()
$microphone = ($Microphone -replace $prefixPattern, '').Trim()

$endpoints = Get-PnpDevice -PresentOnly -Class AudioEndpoint -ErrorAction Stop
$headphonesDevice = $endpoints |
  Where-Object { $_.FriendlyName -eq $headphones } | Select-Object -First 1
$microphoneDevice = $endpoints |
  Where-Object { $_.FriendlyName -eq $microphone } | Select-Object -First 1
if (-not $headphonesDevice -or -not $microphoneDevice) {
  throw "The configured playback or recording endpoint was not found: '$headphones' / '$microphone'. Check the device names."
}
$headphonesEndpointId = $headphonesDevice.InstanceId -replace '^SWD\\MMDEVAPI\\', ''
$microphoneEndpointId = $microphoneDevice.InstanceId -replace '^SWD\\MMDEVAPI\\', ''

# Ordinary Windows applications and previews always use the physical devices.
[LbgmPersistentAudio.DefaultDevice]::Set($headphonesEndpointId)
[LbgmPersistentAudio.DefaultDevice]::Set($microphoneEndpointId)

$login = [LbgmPersistentAudio.Voicemeeter]::VBVMR_Login()
if ($login -ne 0) { throw "Voicemeeter Remote API login failed: $login" }

try {
  # Voicemeeter normally restores its own last shutdown state.  Load our known-
  # good file first so a Windows restart cannot revive an older gain/routing
  # snapshot before the individual parameters below are enforced again.
  if (Test-Path -LiteralPath $voicemeeterConfig) {
    $loadResult = [LbgmPersistentAudio.Voicemeeter]::SetString('Command.Load', $voicemeeterConfig)
    if ($loadResult -ne 0) { throw "Voicemeeter configuration load failed: $loadResult" }
    Start-Sleep -Seconds 2
  }

  # MME keeps the K9 output in shared mode so Bilibili, NetEase Cloud Music,
  # browser audio and the preview player can use it while Voicemeeter is open.
  $setA1 = [LbgmPersistentAudio.Voicemeeter]::SetString('Bus[0].device.mme', $headphones)
  $setMic = [LbgmPersistentAudio.Voicemeeter]::SetString('Strip[0].device.mme', $microphone)
  if ($setA1 -ne 0 -or $setMic -ne 0) { throw "Voicemeeter device configuration failed: A1=$setA1 Mic=$setMic" }
  Start-Sleep -Seconds 2

  $commands = @(
    'Strip[0].A1=0;', 'Strip[0].B1=1;', ('Strip[0].Gain=' + $MicGainDb.ToString([Globalization.CultureInfo]::InvariantCulture) + ';'),
    'Strip[1].A1=0;', 'Strip[1].B1=1;',
    'Strip[2].A1=0;', 'Strip[2].B1=1;',
    'Bus[1].Mute=0;', 'Bus[1].Mono=0;', 'Bus[1].mode.normal=1;'
  )
  foreach ($command in $commands) {
    $result = [LbgmPersistentAudio.Voicemeeter]::VBVMR_SetParametersW($command)
    if ($result -ne 0) { throw "Voicemeeter parameter write failed: $command ($result)" }
    Start-Sleep -Milliseconds 120
  }
  Start-Sleep -Seconds 2

  # The Remote API can keep the pre-write value cached in the current login.
  # Reconnect before verification so the value we report is the engine's
  # persisted value rather than the stale local cache.
  [void][LbgmPersistentAudio.Voicemeeter]::VBVMR_Logout()
  Start-Sleep -Milliseconds 500
  $verifyLogin = [LbgmPersistentAudio.Voicemeeter]::VBVMR_Login()
  if ($verifyLogin -ne 0) { throw "Voicemeeter verification login failed: $verifyLogin" }
  [void][LbgmPersistentAudio.Voicemeeter]::VBVMR_IsParametersDirty()

  $verified = [ordered]@{}
  foreach ($name in @('Strip[0].A1','Strip[0].B1','Strip[0].Gain','Strip[1].A1','Strip[1].B1','Strip[2].A1','Strip[2].B1','Bus[1].Mono')) {
    [single]$value = 0
    $readResult = [LbgmPersistentAudio.Voicemeeter]::VBVMR_GetParameterFloat($name, [ref]$value)
    if ($readResult -ne 0) { throw "Voicemeeter parameter read failed: $name ($readResult)" }
    $verified[$name] = $value
  }
  if ([Math]::Abs($verified['Strip[0].Gain'] - $MicGainDb) -gt 0.1 -or $verified['Strip[0].A1'] -ne 0 -or $verified['Strip[0].B1'] -ne 1) {
    throw 'The microphone gain or routing did not match the requested configuration.'
  }

  # Keep a restorable copy in addition to applying the settings on every app launch.
  $saveResult = [LbgmPersistentAudio.Voicemeeter]::SetString('Command.Save', $voicemeeterConfig)
  if ($saveResult -ne 0) { throw "Voicemeeter configuration save failed: $saveResult" }

  [pscustomobject]@{
    ok = $true
    defaultPlayback = $headphones
    defaultRecording = $microphone
    defaultPlaybackEndpointId = $headphonesEndpointId
    defaultRecordingEndpointId = $microphoneEndpointId
    requestedMicGainDb = $MicGainDb
    a1Mode = 'MME shared'
    configFile = $voicemeeterConfig
    routes = $verified
  } | ConvertTo-Json -Depth 4 -Compress
}
finally {
  [void][LbgmPersistentAudio.Voicemeeter]::VBVMR_Logout()
}
