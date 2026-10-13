# Weekly ETA retrain (run by the PulseBoard-ETA-Retrain scheduled task). Brings up whatever is down:
#   Docker Desktop -> RelayQ postgres/redis -> RelayQ API (:3200) -> RelayQ worker -> eta server (:8000),
# queues ml.retrain, waits for the job to finish, then stops only the processes it started.
# Exit 1 on any failure; the scheduled task retries (3 times, 30 min apart). Log: ml/eta/retrain.log
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$relayq = if ($env:RELAYQ_DIR) { $env:RELAYQ_DIR } else { 'E:\Projects\relayq' }
$url = 'http://localhost:3200'
$log = Join-Path $PSScriptRoot 'retrain.log'
function Log($m) { "$(Get-Date -Format s) $m" | Add-Content $log }
function Wait-Until($what, [int]$seconds, [scriptblock]$ok) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (& $ok)) { if ((Get-Date) -gt $deadline) { throw "timed out waiting for $what" }; Start-Sleep 3 }
}
function Healthy($u) { try { (Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } }
# PowerShell 5.1 turns native stderr into terminating errors under 'Stop'; cmd swallows it. Returns success.
function Run($cmdline) { & cmd /c "$cmdline >nul 2>&1"; $LASTEXITCODE -eq 0 }
function Listening($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

$started = @()
try {
  $key = ((Get-Content (Join-Path $root '.env')) -match '^RELAYQ_API_KEY=' | Select-Object -First 1) -replace '^RELAYQ_API_KEY=', ''
  if (-not $key) { throw 'RELAYQ_API_KEY missing from .env' }

  if (-not (Run 'docker info')) {
    Log 'starting Docker Desktop'
    Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    Wait-Until 'Docker' 300 { Run 'docker info' }
  }
  if (-not (Run "docker compose --project-directory `"$relayq`" up -d --wait postgres redis")) { throw 'relayq postgres/redis failed to start' }
  if (-not (Run "docker compose --project-directory `"$root`" --profile ml up -d --wait eta")) { throw 'eta server failed to start' }

  $tsx = Join-Path $relayq 'node_modules\.bin\tsx.cmd'
  if (-not (Healthy "$url/health")) {
    Log 'starting RelayQ API'
    $started += Start-Process $tsx '--env-file-if-exists=.env src/api/server.ts' -WorkingDirectory $relayq -WindowStyle Hidden -PassThru
    Wait-Until 'RelayQ API' 120 { Healthy "$url/health" }
  }
  if (-not (Listening 9101)) {  # dev worker metrics port; the API holds 9100
    Log 'starting RelayQ worker'
    $env:METRICS_PORT = '9101'
    $started += Start-Process $tsx '--env-file-if-exists=.env src/worker/index.ts' -WorkingDirectory $relayq -WindowStyle Hidden -PassThru
    Wait-Until 'RelayQ worker' 120 { Listening 9101 }
  }

  $h = @{ authorization = "Bearer $key" }
  $body = @{ type = 'ml.retrain'; payload = @{ modelName = 'eta'; dataUrl = 'synthetic:4000' } } | ConvertTo-Json -Depth 3
  $job = Invoke-RestMethod -Method Post -Uri "$url/jobs" -Headers $h -ContentType 'application/json' -Body $body
  Log "queued $($job.jobId)"
  $script:status = $null
  Wait-Until "job $($job.jobId)" 3600 { $script:status = (Invoke-RestMethod "$url/jobs/$($job.jobId)" -Headers $h).status; $script:status -in 'completed', 'failed', 'dead' }
  if ($script:status -ne 'completed') { throw "job $($job.jobId) ended $($script:status)" }
  $m = Invoke-RestMethod "$url/models/eta" -Headers $h
  Log "done: latest v$($m.history[0].version) $($m.history[0].status); serving v$($m.promoted.version)"
} catch {
  Log "FAILED $($_.Exception.Message)"
  $failed = $true
} finally {
  foreach ($p in $started) { $null = Run "taskkill /PID $($p.Id) /T /F" }
}
if ($failed) { exit 1 }
