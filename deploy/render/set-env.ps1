# Sets DATABASE_URL (from .env.render) and REDIS_URL on the Render service, then redeploys.
# Usage: $env:RENDER_API_KEY = 'rnd_...'; .\deploy\render\set-env.ps1
$ErrorActionPreference = 'Stop'
$svc = 'srv-db6rnuon74is738p9dfg'
if (-not $env:RENDER_API_KEY) { throw 'Set $env:RENDER_API_KEY first (Dashboard > Account Settings > API Keys).' }
$line = Get-Content (Join-Path $PSScriptRoot '..\..\.env.render') | Where-Object { $_ -match '^\s*DATABASE_URL=' } | Select-Object -First 1
if (-not $line) { throw 'DATABASE_URL not found in .env.render' }
$db = ($line -replace '^\s*DATABASE_URL=', '').Trim().Trim('"').Trim("'")
$h = @{ Authorization = "Bearer $env:RENDER_API_KEY"; Accept = 'application/json' }
$vars = @{ DATABASE_URL = $db; REDIS_URL = 'redis://red-db4t6g0473hc7392dgag:6379' }
foreach ($k in $vars.Keys) {
  Invoke-RestMethod -Method Put -Uri "https://api.render.com/v1/services/$svc/env-vars/$k" -Headers $h `
    -ContentType 'application/json' -Body (@{ value = $vars[$k] } | ConvertTo-Json) | Out-Null
  Write-Host "set $k"
}
Invoke-RestMethod -Method Post -Uri "https://api.render.com/v1/services/$svc/deploys" -Headers $h -ContentType 'application/json' -Body '{}' | Out-Null
Write-Host 'deploy triggered'
