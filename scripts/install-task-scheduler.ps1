# Registers a logon-triggered scheduled task for claude-stats-daemon.
# Launches via wscript.exe + run-hidden.vbs so no console window appears.
# (Avoids em-dash characters to keep PowerShell happy on older locales.)
$ErrorActionPreference = "Stop"
$TaskName = "ClaudeStatsDaemon"
$DaemonRoot = (Resolve-Path "$PSScriptRoot\..").Path
$VbsLauncher = Join-Path $DaemonRoot "scripts\run-hidden.vbs"
$ScriptPath = Join-Path $DaemonRoot "src\index.js"

if (-not (Test-Path $ScriptPath)) {
  throw "Cannot find $ScriptPath. Run install from the claude-stats-daemon dir."
}
if (-not (Test-Path $VbsLauncher)) {
  throw "Cannot find $VbsLauncher."
}

# wscript.exe runs .vbs files windowless. The .vbs then spawns node with
# WindowStyle = 0 (hidden), so the daemon has no visible console.
$Action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$VbsLauncher`"" `
  -WorkingDirectory $DaemonRoot

# Two triggers, both protected against double-launch by MultipleInstances IgnoreNew:
#   1. AtLogOn (1 min delay)         - normal startup
#   2. Periodic, every 15 min        - safety heartbeat. No-op when daemon is
#                                      already alive; force-starts it if dead.
# This catches the case where the in-process watchdog exited and Task Scheduler's
# RestartCount was exhausted (it'll still get a fresh chance at the next 15 min tick).
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$LogonTrigger.Delay = "PT1M"

$HeartbeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) `
  -RepetitionInterval (New-TimeSpan -Minutes 15)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# RestartCount bumped from 3 to 999 — a USB stall after sleep can outlast 3
# one-minute retries; we'd rather keep trying indefinitely than give up.
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -Hidden `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $Action `
  -Trigger @($LogonTrigger, $HeartbeatTrigger) `
  -Principal $Principal -Settings $Settings -Force | Out-Null
Write-Host "OK: Registered scheduled task '$TaskName' (hidden)"
Write-Host "  - Fires 1 min after logon (primary trigger)"
Write-Host "  - Heartbeat every 15 min (restarts daemon if dead, no-op if alive)"
Write-Host "  - Restart on failure: up to 999 times, 1 min apart"
Write-Host "  Test now: Start-ScheduledTask -TaskName $TaskName"
