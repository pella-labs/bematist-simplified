# Register a per-user scheduled task that runs `bm-pilot run` at logon.
# Usage:
#   powershell -ExecutionPolicy Bypass -File windows-service-install.ps1 -BinaryPath "C:\Users\you\.local\bin\bm-pilot.exe"

param(
    [Parameter(Mandatory = $true)]
    [string]$BinaryPath,
    [string]$TaskName = "Bematist"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $BinaryPath)) {
    throw "binary not found: $BinaryPath"
}

$action    = New-ScheduledTaskAction -Execute $BinaryPath -Argument "run"
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Bematist telemetry collector" | Out-Null

Write-Host "Registered scheduled task '$TaskName' -> $BinaryPath run"
Write-Host "Start now:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove:      Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
