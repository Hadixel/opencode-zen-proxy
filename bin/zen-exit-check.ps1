#Requires -Version 5.1
<#
.SYNOPSIS
  Check (and switch) proxy exits for OpenCode Zen on Windows / PowerShell.

.DESCRIPTION
  Usage:
    .\bin\zen-exit-check.ps1                       # Probe active proxy
    .\bin\zen-exit-check.ps1 -Proxy http://127.0.0.1:10900
    .\bin\zen-exit-check.ps1 -Sweep "path\to\guiConfigs"
    .\bin\zen-exit-check.ps1 -Use "path\to\config.json"
#>
[CmdletBinding()]
param(
    [string]$Proxy = "http://127.0.0.1:10900",
    [string]$Sweep,
    [string]$Use
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir "zen-service.ps1")

$ZenDir = Join-Path $HOME ".config\zen-proxy"
$ZenCfg = Join-Path $ZenDir "zen.json"

function Get-ExitIp([string]$proxyUrl) {
    try {
        $wc = [System.Net.WebClient]::new()
        $wc.Proxy = [System.Net.WebProxy]::new($proxyUrl)
        return $wc.DownloadString("https://api.ipify.org").Trim()
    } catch {
        return "unreachable"
    }
}

function Test-ZenQuota([string]$proxyUrl, [string]$model = "opencode/deepseek-v4.1-flash-free") {
    $opencodeCmd = Get-Command "opencode" -ErrorAction SilentlyContinue
    if (-not $opencodeCmd) { return "opencode not found" }

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $opencodeCmd.Source
    $psi.Arguments = "run --standalone --model $model `"say OK`""
    $psi.EnvironmentVariables["HTTPS_PROXY"] = $proxyUrl
    $psi.EnvironmentVariables["HTTP_PROXY"] = $proxyUrl
    $psi.EnvironmentVariables["NO_PROXY"] = "localhost,127.0.0.1,::1"
    $psi.EnvironmentVariables["ZEN_RETRY_DISABLE"] = "1"
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        $completed = $p.WaitForExit(30000)
        if (-not $completed) {
            $p.Kill()
            return "timeout"
        }
        $out = $p.StandardOutput.ReadToEnd()
        $err = $p.StandardError.ReadToEnd()
        $text = "$out`n$err"
        if ($out -match "\bOK\b" -and $text -notmatch "FreeUsageLimit|FreeTierError|free usage limit") {
            return "OK"
        }
        return ($text.Trim() -split "`n")[-1]
    } catch {
        return $_.Exception.Message
    }
}

if ($Use) {
    if (-not (Test-Path $Use)) {
        Write-Error "Config file not found: $Use"
        exit 1
    }
    Copy-Item $Use $ZenCfg -Force
    Write-Host "[zen-exit-check] Switched active config to $Use"
    & (Join-Path $ScriptDir "zen-service.ps1") "restart"
    exit 0
}

if ($Sweep) {
    if (-not (Test-Path $Sweep)) {
        Write-Error "Directory not found: $Sweep"
        exit 1
    }
    $XrayBin = Find-Xray
    if (-not $XrayBin) {
        Write-Error "Xray binary required for sweep."
        exit 1
    }
    $sparePort = 10950
    $configs = Get-ChildItem -Path $Sweep -Filter "*.json"
    Write-Host "Sweeping $($configs.Count) config(s) in $Sweep..." -ForegroundColor Cyan

    foreach ($file in $configs) {
        try {
            $cfg = Get-Content $file.FullName -Raw | ConvertFrom-Json
            foreach ($ib in $cfg.inbounds) {
                if ($ib.protocol -in @("mixed", "socks", "http")) { $ib.port = $sparePort }
            }
            $tmpSweep = Join-Path ([System.IO.Path]::GetTempPath()) "zen-sweep-$sparePort.json"
            $cfg | ConvertTo-Json -Depth 15 | Set-Content $tmpSweep -Encoding UTF8

            $p = Start-Process -FilePath $XrayBin -ArgumentList "run", "-c", "`"$tmpSweep`"" -PassThru -NoNewWindow
            Start-Sleep -Seconds 2

            $ip = Get-ExitIp "http://127.0.0.1:$sparePort"
            if ($ip -eq "unreachable") {
                Write-Host ("{0,-35} {1}" -f $file.Name, "SKIP (unreachable)") -ForegroundColor DarkGray
            } else {
                $status = Test-ZenQuota "http://127.0.0.1:$sparePort"
                $color = if ($status -eq "OK") { "Green" } else { "Yellow" }
                Write-Host ("{0,-35} exit={1,-18} zen={2}" -f $file.Name, $ip, $status) -ForegroundColor $color
            }
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            Remove-Item $tmpSweep -Force -ErrorAction SilentlyContinue
        } catch {
            Write-Warning "Failed to test $($file.Name): $_"
        }
    }
    exit 0
}

# Single probe
Write-Host "Probing proxy: $Proxy" -ForegroundColor Cyan
$exitIp = Get-ExitIp $Proxy
Write-Host "  Exit IP: $exitIp"
$zenStatus = Test-ZenQuota $Proxy
$color = if ($zenStatus -eq "OK") { "Green" } else { "Red" }
Write-Host "  Zen Free Tier Status: $zenStatus" -ForegroundColor $color
