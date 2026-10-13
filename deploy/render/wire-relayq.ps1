# Wires PulseBoard <-> RelayQ on Render without printing any secret.
#  - relayq-demo: PULSEBOARD_URL, PULSEBOARD_TOKEN (= pulseboard RELAYQ_SERVICE_TOKEN)
#  - pulseboard:  RELAYQ_WEBHOOK_SECRET (= relayq WEBHOOK_SECRET), RELAYQ_API_KEY (new rq_ key; only its sha256 goes into RelayQ's DB)
# Then redeploys both. Usage: $env:RENDER_API_KEY = 'rnd_...'; .\deploy\render\wire-relayq.ps1
$ErrorActionPreference = 'Stop'
$pb = 'srv-db6rnuon74is738p9dfg'; $rq = 'srv-db4t7lo473hc7392hrbg'
$relayqRepo = 'E:\Projects\relayq'
if (-not $env:RENDER_API_KEY) { throw 'Set $env:RENDER_API_KEY first.' }
$h = @{ Authorization = "Bearer $env:RENDER_API_KEY"; Accept = 'application/json' }
$api = 'https://api.render.com/v1/services'
function Get-Var($svc, $k) {
  $v = (Invoke-RestMethod -Uri "$api/$svc/env-vars/$k" -Headers $h).value
  if (-not $v) { throw "$k is empty on $svc" }; $v
}
function Set-Var($svc, $k, $v) {
  Invoke-RestMethod -Method Put -Uri "$api/$svc/env-vars/$k" -Headers $h -ContentType 'application/json' `
    -Body (@{ value = $v } | ConvertTo-Json) | Out-Null
  Write-Host "set $k on $svc"
}

Set-Var $rq 'PULSEBOARD_URL' 'https://pulseboard-fmbj.onrender.com/api'
Set-Var $rq 'PULSEBOARD_TOKEN' (Get-Var $pb 'RELAYQ_SERVICE_TOKEN')
Set-Var $pb 'RELAYQ_WEBHOOK_SECRET' (Get-Var $rq 'WEBHOOK_SECRET')

# Tenant key: same format and hash as relayq src/cli/create-key.ts.
$bytes = New-Object byte[] 24; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = 'rq_' + ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
$sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($key))
$hash = -join ($sha | ForEach-Object { $_.ToString('x2') })
$env:DATABASE_URL = Get-Var $rq 'DATABASE_URL'
Push-Location $relayqRepo
try {
  node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.apiKey.create({data:{hash:'$hash',tenant:'pulseboard'}}).then(()=>p.`$disconnect())"
  if ($LASTEXITCODE -ne 0) { throw 'inserting the RelayQ api key failed' }
} finally { Pop-Location; Remove-Item Env:DATABASE_URL }
Set-Var $pb 'RELAYQ_API_KEY' $key

foreach ($svc in $pb, $rq) {
  Invoke-RestMethod -Method Post -Uri "$api/$svc/deploys" -Headers $h -ContentType 'application/json' -Body '{}' | Out-Null
  Write-Host "deploy triggered on $svc"
}
