# Queues RelayQ's ml.retrain for the eta model. Registered weekly by register-retrain-task.ps1.
# Key from this repo's gitignored .env (RELAYQ_API_KEY); RELAYQ_URL defaults to the local dev API.
# If RelayQ is down the POST fails and is logged; nothing is retried until next week.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$log = Join-Path $PSScriptRoot 'retrain.log'
$envFile = Get-Content (Join-Path $root '.env') -ErrorAction SilentlyContinue
$key = ($envFile | Where-Object { $_ -match '^RELAYQ_API_KEY=' } | Select-Object -First 1) -replace '^RELAYQ_API_KEY=', ''
$url = if ($env:RELAYQ_URL) { $env:RELAYQ_URL } else { 'http://localhost:3200' }
try {
  if (-not $key) { throw 'RELAYQ_API_KEY missing from .env' }
  $body = @{ type = 'ml.retrain'; payload = @{ modelName = 'eta'; dataUrl = 'synthetic:4000' } } | ConvertTo-Json -Depth 3
  $res = Invoke-RestMethod -Method Post -Uri "$url/jobs" -Headers @{ authorization = "Bearer $key" } -ContentType 'application/json' -Body $body
  "$(Get-Date -Format s) queued $($res.jobId)" | Add-Content $log
} catch {
  "$(Get-Date -Format s) FAILED $($_.Exception.Message)" | Add-Content $log
  exit 1
}
