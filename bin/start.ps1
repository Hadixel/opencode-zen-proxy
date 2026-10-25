#Requires -Version 5.1
<#
.SYNOPSIS
  All-in-one launcher for OpenCode Zen Proxy system on Windows / PowerShell.

.DESCRIPTION
  Launches both Xray (127.0.0.1:10901) and zen-relay (127.0.0.1:10900)
  in a single command. Pressing Ctrl+C stops both cleanly.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServiceScript = Join-Path $ScriptDir "zen-service.ps1"

Write-Host "=== Starting OpenCode Zen Proxy System ===" -ForegroundColor Cyan

# Start services
& $ServiceScript "start"

Write-Host "`nOpenCode Zen Proxy is running!" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop services at any time.`n" -ForegroundColor Yellow

try {
    while ($true) {
        Start-Sleep -Seconds 2
    }
} finally {
    Write-Host "`nShutting down OpenCode Zen Proxy system..." -ForegroundColor Cyan
    & $ServiceScript "stop"
    Write-Host "Stopped cleanly." -ForegroundColor Green
}
