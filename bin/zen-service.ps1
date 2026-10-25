#Requires -Version 5.1
<#
.SYNOPSIS
  Background daemon and service manager for OpenCode Zen Proxy on Windows / PowerShell.

.DESCRIPTION
  Manages Xray (127.0.0.1:10901) and zen-relay (127.0.0.1:10900).

.PARAMETER Action
  One of: start, stop, restart, status, scrape
#>
[CmdletBinding()]
param(
    [ValidateSet("start", "stop", "restart", "status", "scrape")]
    [string]$Action = "status"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ZenDir = if ($env:ZEN_CONFIG_DIR) { $env:ZEN_CONFIG_DIR } else { Join-Path $HOME ".config\zen-proxy" }
$LogDir = Join-Path $ZenDir "logs"
$PidFile = Join-Path $ZenDir "zen-service.pid"
$ConfigFile = if ($env:ZEN_CONFIG) { $env:ZEN_CONFIG } else { Join-Path $ZenDir "zen.json" }

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

function Find-Xray {
    if ($env:XRAY -and (Test-Path $env:XRAY)) {
        return $env:XRAY
    }
    $ExeName = if ($IsWindows -or ($PSVersionTable.PSVersion.Major -le 5)) { "xray.exe" } else { "xray" }
    $cmd = Get-Command $ExeName -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    $cmdPlain = Get-Command "xray" -ErrorAction SilentlyContinue
    if ($cmdPlain) {
        return $cmdPlain.Source
    }

    $candidates = @(
        (Join-Path $HOME ".local\share\v2rayN\bin\xray\$ExeName"),
        (Join-Path $HOME ".local\share\zen-proxy\$ExeName"),
        (Join-Path $HOME ".local\share\zen-proxy\xray\$ExeName"),
        (Join-Path $HOME ".local\bin\$ExeName"),
        (Join-Path $HOME "v2rayN\bin\xray\$ExeName"),
        (Join-Path $HOME "Downloads\v2rayN\bin\xray\$ExeName"),
        "$env:LOCALAPPDATA\v2rayN\bin\xray\$ExeName",
        "$env:APPDATA\v2rayN\bin\xray\$ExeName",
        "$env:ProgramFiles\v2rayN\bin\xray\$ExeName",
        "${env:ProgramFiles(x86)}\v2rayN\bin\xray\$ExeName",
        (Join-Path $HOME "scoop\apps\xray\current\$ExeName"),
        "/usr/local/bin/xray",
        "/usr/bin/xray"
    )

    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) {
            return $c
        }
    }
    return $null
}

function Test-PortListening([int]$Port) {
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $asyncResult = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        $waitSuccess = $asyncResult.AsyncWaitHandle.WaitOne(300, $false)
        if ($waitSuccess -and $client.Connected) {
            $client.EndConnect($asyncResult)
            $client.Close()
            return $true
        }
        $client.Close()
        return $false
    } catch {
        return $false
    }
}

function Stop-PortProcess([int]$Port) {
    if ($IsWindows -or ($PSVersionTable.PSVersion.Major -le 5)) {
        try {
            $conns = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
            foreach ($c in $conns) {
                if ($c.OwningProcess -and $c.OwningProcess -ne $PID) {
                    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
                }
            }
        } catch {
            # Fallback to netstat on older Windows
            try {
                $lines = netstat -ano -p tcp | Select-String ":$Port\s.*LISTENING"
                foreach ($l in $lines) {
                    $parts = $l.ToString().Trim() -split '\s+'
                    $targetPid = $parts[-1]
                    if ($targetPid -and $targetPid -ne "0" -and $targetPid -ne "$PID") {
                        Stop-Process -Id ([int]$targetPid) -Force -ErrorAction SilentlyContinue
                    }
                }
            } catch {}
        }
    } else {
        try { & fuser -k -9 "$Port/tcp" 2>$null } catch {}
    }
}

function Stop-Services {
    Write-Host "Stopping OpenCode Zen Proxy system..."
    if (Test-Path $PidFile) {
        try {
            $pids = (Get-Content $PidFile -Raw).Trim() -split '\s+'
            foreach ($p in $pids) {
                if ($p -match '^\d+$') {
                    Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue
                }
            }
        } catch {}
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
    Stop-PortProcess 10900
    Stop-PortProcess 10901
    Stop-PortProcess 10902
    Start-Sleep -Milliseconds 600
    Write-Host "Proxy services stopped."
}

function Start-Services {
    if ((Test-PortListening 10900) -and (Test-PortListening 10901)) {
        Write-Host "Zen Proxy is already running on 127.0.0.1:10900 and 127.0.0.1:10901."
        return
    }

    Stop-PortProcess 10900
    Stop-PortProcess 10901
    Stop-PortProcess 10902
    Start-Sleep -Milliseconds 500

    $XrayBin = Find-Xray
    if (-not $XrayBin) {
        Write-Error "Xray binary not found. Please install Xray or run zen-install.ps1."
        return
    }

    if (-not (Test-Path $ConfigFile)) {
        Write-Host "No config found at $ConfigFile. Generating initial config..."
        Invoke-Scrape
        return
    }

    # Ensure config points to 10901
    try {
        $raw = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        $changed = $false
        foreach ($ib in $raw.inbounds) {
            if ($ib.protocol -in @("mixed", "socks", "http")) {
                if ($ib.port -ne 10901) { $ib.port = 10901; $changed = $true }
            } elseif ($ib.protocol -eq "dokodemo-door") {
                if ($ib.port -ne 10954) { $ib.port = 10954; $changed = $true }
            }
        }
        if ($changed) {
            $raw | ConvertTo-Json -Depth 15 | Set-Content $ConfigFile -Encoding UTF8
        }
    } catch {}

    Write-Host "Starting OpenCode Zen Proxy system in background..."

    $XrayLog = Join-Path $LogDir "xray.log"
    $XrayErrLog = Join-Path $LogDir "xray.err.log"
    $RelayLog = Join-Path $LogDir "relay.log"
    $RelayErrLog = Join-Path $LogDir "relay.err.log"

    # 1. Start Xray
    if ($IsWindows -or ($PSVersionTable.PSVersion.Major -le 5)) {
        $xrayProc = Start-Process -FilePath $XrayBin `
            -ArgumentList "run", "-c", "`"$ConfigFile`"" `
            -RedirectStandardOutput $XrayLog `
            -RedirectStandardError $XrayErrLog `
            -WindowStyle Hidden `
            -PassThru
        $XrayPid = $xrayProc.Id
    } else {
        $shCmd = "setsid `"$XrayBin`" run -c `"$ConfigFile`" > `"$XrayLog`" 2> `"$XrayErrLog`" &"
        & sh -c $shCmd
        Start-Sleep -Milliseconds 400
        $XrayPid = $(pgrep -f "xray run -c $ConfigFile" 2>$null | Select-Object -First 1)
    }

    # Wait for Xray
    $waited = 0
    while (-not (Test-PortListening 10901)) {
        Start-Sleep -Milliseconds 500
        $waited++
        if ($waited -ge 20) {
            Write-Error "Xray failed to start on 127.0.0.1:10901. Check $XrayLog and $XrayErrLog"
            return
        }
    }
    Write-Host "  - Xray running on 127.0.0.1:10901 (PID $XrayPid)"

    # 2. Start zen-relay
    $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Error "Node.js not found on PATH. Please install Node.js."
        return
    }
    $RelayScript = Join-Path $ScriptDir "zen-relay.js"

    if ($IsWindows -or ($PSVersionTable.PSVersion.Major -le 5)) {
        $relayProc = Start-Process -FilePath $nodeCmd.Source `
            -ArgumentList "`"$RelayScript`"" `
            -RedirectStandardOutput $RelayLog `
            -RedirectStandardError $RelayErrLog `
            -WindowStyle Hidden `
            -PassThru
        $RelayPid = $relayProc.Id
    } else {
        $shCmd = "setsid `"$($nodeCmd.Source)`" `"$RelayScript`" > `"$RelayLog`" 2> `"$RelayErrLog`" &"
        & sh -c $shCmd
        Start-Sleep -Milliseconds 400
        $RelayPid = $(pgrep -f "node.*zen-relay.js" 2>$null | Select-Object -First 1)
    }

    $waited = 0
    while (-not (Test-PortListening 10900)) {
        Start-Sleep -Milliseconds 500
        $waited++
        if ($waited -ge 20) {
            Write-Error "zen-relay failed to start on 127.0.0.1:10900. Check $RelayLog"
            return
        }
    }
    Write-Host "  - zen-relay running on 127.0.0.1:10900 (PID $RelayPid)"

    "$XrayPid $RelayPid" | Set-Content -Path $PidFile -Encoding ASCII
    Write-Host "OpenCode Zen Proxy is ready!"
    Write-Host "Logs: $RelayLog, $XrayLog"
}

function Get-ServiceStatus {
    Write-Host "=== OpenCode Zen Proxy Status ==="
    if (Test-PortListening 10900) {
        Write-Host "zen-relay: RUNNING on 127.0.0.1:10900" -ForegroundColor Green
    } else {
        Write-Host "zen-relay: STOPPED (port 10900 not listening)" -ForegroundColor Red
    }

    if (Test-PortListening 10901) {
        Write-Host "xray:      RUNNING on 127.0.0.1:10901" -ForegroundColor Green
    } else {
        Write-Host "xray:      STOPPED (port 10901 not listening)" -ForegroundColor Red
    }

    $RelayLog = Join-Path $LogDir "relay.log"
    if (Test-Path $RelayLog) {
        Write-Host "`nRecent zen-relay logs:"
        Get-Content $RelayLog -Tail 10
    }
}

function Invoke-Scrape {
    Write-Host "Re-scraping live public proxies and validating Zen free quota..."
    $ScrapeScript = Join-Path $ScriptDir "zen-scrape.js"
    $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Error "Node.js is required to run the scraper."
        return
    }

    $env:ZEN_TARGET_OK = if ($env:ZEN_TARGET_OK) { $env:ZEN_TARGET_OK } else { "5" }
    $env:ZEN_CHECK_CONCURRENCY = if ($env:ZEN_CHECK_CONCURRENCY) { $env:ZEN_CHECK_CONCURRENCY } else { "5" }

    & $nodeCmd.Source "$ScrapeScript" --limit 1000 --concurrency 40 --zen-check 200 --output "$ConfigFile"
    Write-Host "Restarting services with fresh proxy pool..."
    Stop-Services
    Start-Services
}

if ($MyInvocation.InvocationName -ne '.') {
    switch ($Action) {
        "start"   { Start-Services }
        "stop"    { Stop-Services }
        "restart" { Stop-Services; Start-Services }
        "status"  { Get-ServiceStatus }
        "scrape"  { Invoke-Scrape }
    }
}
