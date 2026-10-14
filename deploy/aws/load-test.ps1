# Phase 7: runs load/board.k6.js as a one-off Fargate task (stack PulseboardLoad) against the CloudFront URL,
# waits for it to finish and prints the k6 summary from CloudWatch Logs.
# Usage: .\deploy\aws\load-test.ps1 [-Vus 500] [-DurationS 60]
param([int]$Vus = 500, [int]$DurationS = 60)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'; $env:PYTHONIOENCODING = 'utf-8' # the AWS CLI chokes on k6's check marks otherwise
$aws = @('--profile', 'pulseboard', '--region', 'ap-south-1')

function Out($stack, $key) {
  aws cloudformation describe-stacks --stack-name $stack @aws --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" --output text
}
$base = Out 'PulseboardApp' 'Url'
$cluster = Out 'PulseboardLoad' 'ClusterName'
$taskDef = Out 'PulseboardLoad' 'TaskDef'
$sg = Out 'PulseboardLoad' 'SecurityGroup'
$subnets = Out 'PulseboardLoad' 'Subnets'

# load/board.k6.js, gzipped + base64 (ECS caps container overrides at 8 KB).
$raw = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '../../load/board.k6.js'))
$ms = New-Object IO.MemoryStream
$gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress)
$gz.Write($raw, 0, $raw.Length); $gz.Close()
$script = [Convert]::ToBase64String($ms.ToArray())

$overrides = @{ containerOverrides = @(@{ name = 'k6'; environment = @(
  @{ name = 'BASE'; value = $base }, @{ name = 'API_PATH'; value = '/api' },
  @{ name = 'K6_SCRIPT_GZ'; value = $script },
  @{ name = 'VUS'; value = "$Vus" }, @{ name = 'DURATION_S'; value = "$DurationS" }) }) } | ConvertTo-Json -Depth 6 -Compress
$overridesFile = New-TemporaryFile
Set-Content -Path $overridesFile -Value $overrides -Encoding ascii

$taskArn = aws ecs run-task @aws --cluster $cluster --task-definition $taskDef --launch-type FARGATE `
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=ENABLED}" `
  --overrides "file://$overridesFile" --query 'tasks[0].taskArn' --output text
if ($LASTEXITCODE -ne 0 -or -not $taskArn -or $taskArn -eq 'None') { throw 'run-task failed' }
Write-Host "k6 task $taskArn ($Vus VUs, ${DurationS}s) against $base"
aws ecs wait tasks-stopped @aws --cluster $cluster --tasks $taskArn
while ((aws ecs describe-tasks @aws --cluster $cluster --tasks $taskArn --query 'tasks[0].lastStatus' --output text) -ne 'STOPPED') { Start-Sleep 15 }

$exit = aws ecs describe-tasks @aws --cluster $cluster --tasks $taskArn --query 'tasks[0].containers[0].exitCode' --output text
$logGroup = Out 'PulseboardLoad' 'LogGroup'
$stream = "k6/k6/$($taskArn.Split('/')[-1])"
aws logs get-log-events @aws --log-group-name $logGroup --log-stream-name $stream --start-from-head --query 'events[].message' --output text |
  ForEach-Object { $_ -split "`t" }
Write-Host "k6 exit code $exit (99 = thresholds failed)"
