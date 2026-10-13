# Creates the five /pulseboard/* SSM SecureStrings the AWS app stack reads (CloudFormation can't create SecureStrings).
# JWT secrets: generated. RelayQ ones: copied from the Render PulseBoard service, so both deployments talk to the
# same RelayQ (relayq-demo on Render) with the same tenant key and callback secret. Values are never printed.
# Existing parameters are left alone (delete one to regenerate it).
# Usage: .\deploy\aws\put-secrets.ps1   (AWS profile "pulseboard"; Render key from $env:RENDER_API_KEY or the Render CLI login)
$ErrorActionPreference = 'Stop'
$profile_ = 'pulseboard'
$region = 'ap-south-1'
$svc = 'srv-db6rnuon74is738p9dfg'

$renderKey = $env:RENDER_API_KEY
if (-not $renderKey) {
  $cli = Join-Path $HOME '.render\cli.yaml'
  $m = Select-String -Path $cli -Pattern '^\s+key:\s*(\S+)' | Select-Object -First 1
  if (-not $m) { throw 'No Render key: set $env:RENDER_API_KEY or run "render login".' }
  $renderKey = $m.Matches[0].Groups[1].Value
}
$h = @{ Authorization = "Bearer $renderKey"; Accept = 'application/json' }
function FromRender($name) {
  $v = (Invoke-RestMethod -Uri "https://api.render.com/v1/services/$svc/env-vars/$name" -Headers $h).value
  if (-not $v) { throw "Render service has no $name" }
  return $v
}
function Random48 { $b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) }

$existing = (aws ssm describe-parameters --profile $profile_ --region $region `
  --parameter-filters 'Key=Name,Option=BeginsWith,Values=/pulseboard/' --query 'Parameters[].Name' --output text) -split '\s+'

$wanted = [ordered]@{
  'jwt-access-secret'     = { Random48 }
  'jwt-refresh-secret'    = { Random48 }
  'relayq-api-key'        = { FromRender 'RELAYQ_API_KEY' }
  'relayq-service-token'  = { FromRender 'RELAYQ_SERVICE_TOKEN' }
  'relayq-webhook-secret' = { FromRender 'RELAYQ_WEBHOOK_SECRET' }
}
foreach ($name in $wanted.Keys) {
  $path = "/pulseboard/$name"
  if ($existing -contains $path) { Write-Host "exists   $path"; continue }
  $value = & $wanted[$name]
  aws ssm put-parameter --profile $profile_ --region $region --name $path --type SecureString --value $value --output text | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "put-parameter failed for $path" }
  Write-Host "created  $path"
}
