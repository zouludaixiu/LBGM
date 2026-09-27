$ErrorActionPreference = 'Stop'

$taskName = 'LBGM Hero Music Console'
$statusPath = Join-Path $env:APPDATA 'champion-soundboard\startup-task-status.json'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

[pscustomobject]@{
  ok = $true
  taskName = $taskName
  removed = [bool]$existing
  checkedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
