# Registers (or replaces) a per-user Windows scheduled task: retrain.ps1 every Sunday 03:00.
# Missed runs (machine off) start at next logon/boot; a failed run (exit 1) is retried 3 times, 30 min apart. Remove: Unregister-ScheduledTask PulseBoard-ETA-Retrain
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\retrain.ps1`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 30) -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName 'PulseBoard-ETA-Retrain' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Get-ScheduledTask -TaskName 'PulseBoard-ETA-Retrain' | Get-ScheduledTaskInfo | Select-Object TaskName, NextRunTime
