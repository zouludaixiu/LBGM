param(
  # QQ NT 的默认安装路径；如安装在其他位置，用 -QQPath 传入实际路径。
  [string]$QQPath = 'C:\Program Files\Tencent\QQNT\QQ.exe'
)

$ErrorActionPreference = 'Stop'

$policyName = 'LBGM QQ Voice Priority'
$statusDirectory = Join-Path $env:APPDATA 'champion-soundboard'
$statusPath = Join-Path $statusDirectory 'qq-qos-status.json'

New-Item -ItemType Directory -Path $statusDirectory -Force | Out-Null

try {
  if (-not (Test-Path -LiteralPath $qqPath)) {
    throw "QQ executable was not found: $qqPath"
  }

  $policy = Get-NetQosPolicy -Name $policyName -ErrorAction SilentlyContinue
  if ($policy) {
    Set-NetQosPolicy -Name $policyName `
      -AppPathNameMatchCondition $qqPath `
      -IPProtocolMatchCondition Both `
      -DSCPAction 46 `
      -NetworkProfile All `
      -Precedence 200 `
      -ErrorAction Stop | Out-Null
  } else {
    New-NetQosPolicy -Name $policyName `
      -AppPathNameMatchCondition $qqPath `
      -IPProtocolMatchCondition Both `
      -DSCPAction 46 `
      -NetworkProfile All `
      -Precedence 200 `
      -ErrorAction Stop | Out-Null
  }

  $verified = Get-NetQosPolicy -Name $policyName -ErrorAction Stop
  $status = [ordered]@{
    ok = $true
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    name = $verified.Name
    owner = $verified.Owner
    appPath = $verified.AppPathNameMatchCondition
    protocol = [string]$verified.IPProtocolMatchCondition
    dscp = $verified.DSCPAction
    networkProfile = [string]$verified.NetworkProfile
    precedence = $verified.Precedence
    persistent = $verified.Owner -eq 'Group Policy (Machine)'
  }
} catch {
  $status = [ordered]@{
    ok = $false
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    error = $_.Exception.Message
  }
}

$status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding UTF8
if (-not $status.ok) { throw $status.error }
