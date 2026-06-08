# Connection Watchman - remove the Windows Scheduled Tasks. Run in an ADMIN PowerShell.
# Your data (uptime.db) is left in place.
$ErrorActionPreference = "SilentlyContinue"
foreach ($svc in @("monitor","dashboard")) {
  $name = "Connection Watchman $svc"
  Stop-ScheduledTask -TaskName $name
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
[Environment]::SetEnvironmentVariable("UPTIME_PORT", $null, "Machine")
Write-Host "Removed scheduled tasks. Your data (uptime.db) was left in place."
