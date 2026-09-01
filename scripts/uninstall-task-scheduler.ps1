$ErrorActionPreference = "Stop"
$TaskName = "ClaudeStatsDaemon"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "✓ Unregistered scheduled task '$TaskName'"
} else {
  Write-Host "Task '$TaskName' not found — nothing to do"
}
