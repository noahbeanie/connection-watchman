# Connection Watchman - one-command installer for Windows.
#
#   From a clone (admin PowerShell):  .\install.ps1
#   Remotely:  irm https://raw.githubusercontent.com/noahbeanie/connection-watchman/main/install.ps1 | iex
#
# Registers the monitor + dashboard as always-on Scheduled Tasks that run at boot
# as SYSTEM (even when logged out). Pure Python 3 stdlib, no pip.
$ErrorActionPreference = "Stop"
$Repo = "https://github.com/noahbeanie/connection-watchman.git"

# Need admin to register SYSTEM tasks that start at boot.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) {
  Write-Host "Please run this in an ADMIN PowerShell (right-click Windows Terminal / PowerShell > Run as administrator), then re-run."
  return
}

# Use this folder if it's a clone (monitor.py beside the script); otherwise fetch it.
$here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
if (Test-Path (Join-Path $here "monitor.py")) {
  $Dir = $here
} else {
  $Dir = Join-Path $env:LOCALAPPDATA "ConnectionWatchman"
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "git not found. Install Git (winget install -e --id Git.Git) or download the repo and run .\install.ps1 from inside it."
    return
  }
  if (Test-Path (Join-Path $Dir ".git")) { git -C $Dir pull --ff-only } else { git clone --depth 1 $Repo $Dir }
}

# Ensure Python 3.
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $py) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Python not found - installing via winget..."
    winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
    $py = (Get-Command python -ErrorAction SilentlyContinue).Source
  }
  if (-not $py) { Write-Host "Could not find or install Python 3. Install it from https://python.org and re-run."; return }
}

# Port: reuse a prior install's port so upgrades never move it; otherwise prefer 8080 and
# fall back to the next free port. Chosen once, then persisted so restarts never change it.
$existing = [Environment]::GetEnvironmentVariable("UPTIME_PORT","Machine")
if ($existing) {
  $Port = [int]$existing
} elseif (Get-ScheduledTask -TaskName "Connection Watchman dashboard" -ErrorAction SilentlyContinue) {
  $Port = 8080
} else {
  $Port = 8080
  for ($p = 8080; $p -lt 8090; $p++) {
    try { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $p); $l.Start(); $l.Stop(); $Port = $p; break } catch { }
  }
}
# The SYSTEM scheduled task inherits machine env vars; persist the chosen port.
[Environment]::SetEnvironmentVariable("UPTIME_PORT", "$Port", "Machine")

Write-Host "App:    $Dir"
Write-Host "Python: $py"
Write-Host "Port:   $Port"

# Register two always-on tasks (start at boot as SYSTEM, restart on failure, no time limit).
foreach ($svc in @("monitor","dashboard")) {
  $name     = "Connection Watchman $svc"
  $action   = New-ScheduledTaskAction -Execute $py -Argument "$svc.py" -WorkingDirectory $Dir
  $trigger  = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $name
}

# Print exactly where to go (this is what you see right after install).
$hostName = [System.Net.Dns]::GetHostName()
$ip = $null
try { $ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress } catch { }
Write-Host ""
Write-Host "Connection Watchman is running. Open the dashboard at:"
Write-Host "  On this device:     http://localhost:${Port}"
Write-Host "  From other devices: http://${hostName}.local:${Port}   <-- bookmark this one"
if ($ip) { Write-Host "  Or by IP:           http://${ip}:${Port}" }
Write-Host ""
Write-Host "Tip: bookmark the .local address - it keeps working even if the device's IP changes."
Write-Host "Remove with:  .\uninstall.ps1   (run as admin)"
Start-Process "http://localhost:${Port}"
