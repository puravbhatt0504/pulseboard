# Gives the Render service Bedrock access: creates an access key for the pulseboard-render-bedrock IAM user
# (infra PulseboardBedrock stack: GLM 5 + Titan only), writes it and the model settings to Render's env,
# then redeploys. The secret goes straight from AWS to Render and is never printed.
# Usage: $env:RENDER_API_KEY = 'rnd_...'; .\deploy\render\set-bedrock.ps1
$ErrorActionPreference = 'Stop'
$svc = 'srv-db6rnuon74is738p9dfg'
$user = 'pulseboard-render-bedrock'
if (-not $env:RENDER_API_KEY) { throw 'Set $env:RENDER_API_KEY first (Dashboard > Account Settings > API Keys).' }

# One key at a time: an older key for this user means it was already set up (rotate by deleting it in IAM first).
$existing = aws iam list-access-keys --user-name $user --profile pulseboard --query 'AccessKeyMetadata[].AccessKeyId' --output text
if ($LASTEXITCODE -ne 0) { throw "aws iam list-access-keys failed (run: aws login --profile pulseboard)" }
$existing = "$existing".Trim() # no keys: empty output (null) or "None"
if ($existing -and $existing -ne 'None') { throw "$user already has an access key ($existing). Delete it in IAM first if you want a new one." }

$key = aws iam create-access-key --user-name $user --profile pulseboard --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'aws iam create-access-key failed' }

$h = @{ Authorization = "Bearer $env:RENDER_API_KEY"; Accept = 'application/json' }
$vars = [ordered]@{
  AWS_REGION            = 'ap-south-1'
  ASK_BEDROCK_MODEL     = 'zai.glm-5'
  EMBED_BEDROCK_MODEL   = 'amazon.titan-embed-text-v2:0'
  AWS_ACCESS_KEY_ID     = $key.AccessKey.AccessKeyId
  AWS_SECRET_ACCESS_KEY = $key.AccessKey.SecretAccessKey
}
foreach ($k in $vars.Keys) {
  Invoke-RestMethod -Method Put -Uri "https://api.render.com/v1/services/$svc/env-vars/$k" -Headers $h `
    -ContentType 'application/json' -Body (@{ value = $vars[$k] } | ConvertTo-Json) | Out-Null
  Write-Host "set $k"
}
Invoke-RestMethod -Method Post -Uri "https://api.render.com/v1/services/$svc/deploys" -Headers $h -ContentType 'application/json' -Body '{}' | Out-Null
Write-Host 'deploy triggered'
