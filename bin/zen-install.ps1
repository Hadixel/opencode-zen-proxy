#Requires -Version 5.1
<#
.SYNOPSIS
  One-command installer for OpenCode Zen Proxy on Windows.

.DESCRIPTION
  Installs required components, downloads Xray for Windows if missing,
  configures OpenCode with the Zen retry plugin, generates the initial
  proxy config, and starts the background proxy service.

  Usage:
    .\bin\zen-install.ps1
    irm https://raw.githubusercontent.com/Hadixel/opencode-zen-proxy/main/bin/zen-install.ps1 | iex
#>
[CmdletBinding()]
param(
    [switch]$NoScrape,
    [switch]$NoService,
    [switch]$NoRestart,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

Write-Host "=== OpenCode Zen Proxy Installer for Windows ===" -ForegroundColor Cyan

$ScriptDir = $null
if ($MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
    try {
        $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    } catch {}
}

if (-not $ScriptDir -or -not (Test-Path (Join-Path $ScriptDir "zen-relay.js"))) {
    # Running from web download (iex): clone or download repo
    $TargetRepo = Join-Path $HOME ".local\share\opencode-zen-proxy"
    $gitCmd = Get-Command "git" -ErrorAction SilentlyContinue
    if ($gitCmd) {
        if (-not (Test-Path $TargetRepo)) {
            Write-Host "Cloning opencode-zen-proxy repository to $TargetRepo..."
            & $gitCmd.Source clone "https://github.com/Hadixel/opencode-zen-proxy.git" $TargetRepo
        } else {
            Write-Host "Updating repository at $TargetRepo..."
            Push-Location $TargetRepo
            try { & $gitCmd.Source pull origin main } catch {}
            Pop-Location
        }
    } else {
        Write-Host "Git not found. Downloading repository archive from GitHub..."
        $zipUrl = "https://github.com/Hadixel/opencode-zen-proxy/archive/refs/heads/main.zip"
        $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "zen-install-$(Get-Random)"
        New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
        $zipFile = Join-Path $tmpDir "repo.zip"
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing
        Expand-Archive -Path $zipFile -DestinationPath $tmpDir -Force
        $unzipped = Join-Path $tmpDir "opencode-zen-proxy-main"
        if (Test-Path $TargetRepo) { Remove-Item $TargetRepo -Recurse -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TargetRepo) | Out-Null
        Move-Item -Path $unzipped -Destination $TargetRepo -Force
        Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    $ScriptDir = Join-Path $TargetRepo "bin"
}

$ZenDir = Join-Path $HOME ".config\zen-proxy"
$ConfigFile = Join-Path $ZenDir "zen.json"
if (-not (Test-Path $ZenDir)) {
    New-Item -ItemType Directory -Force -Path $ZenDir | Out-Null
}

# 1. Check Node.js
Write-Host "[1/5] Checking Node.js..."
$nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    $winget = Get-Command "winget" -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "Node.js not found. Installing Node.js LTS via winget..." -ForegroundColor Yellow
        winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
    }
    if (-not $nodeCmd) {
        Write-Error "Node.js is required. Please install Node.js from https://nodejs.org and rerun."
        exit 1
    }
}
$nodeVer = & $nodeCmd.Source --version
Write-Host "      Found Node.js $nodeVer" -ForegroundColor Green

# 2. Check or download Xray
Write-Host "[2/5] Checking Xray..."
. (Join-Path $ScriptDir "zen-service.ps1")
$xrayPath = Find-Xray
if (-not $xrayPath -or $Force) {
    Write-Host "Xray not found. Downloading latest Xray-core for Windows..." -ForegroundColor Yellow
    $arch = if ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE.ToUpperInvariant() } else { "AMD64" }
    $asset = switch ($arch) {
        "ARM64" { "Xray-windows-arm64-v8a.zip" }
        default { "Xray-windows-64.zip" }
    }
    $downloadUrl = "https://github.com/XTLS/Xray-core/releases/latest/download/$asset"
    $xrayInstallDir = Join-Path $HOME ".local\share\zen-proxy"
    if (-not (Test-Path $xrayInstallDir)) {
        New-Item -ItemType Directory -Force -Path $xrayInstallDir | Out-Null
    }
    $zipPath = Join-Path $xrayInstallDir "xray.zip"
    Write-Host "      Downloading $downloadUrl..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing
    Write-Host "      Extracting to $xrayInstallDir..."
    Expand-Archive -Path $zipPath -DestinationPath $xrayInstallDir -Force
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    $xrayPath = Find-Xray
}

if (-not $xrayPath) {
    Write-Error "Could not locate or download Xray. Please install Xray or place xray.exe on PATH."
    exit 1
}
Write-Host "      Using Xray: $xrayPath" -ForegroundColor Green

# 3. Configure OpenCode
Write-Host "[3/5] Configuring OpenCode proxy environment and plugin..."
$SetupScript = Join-Path $ScriptDir "zen-setup.ps1"
& $SetupScript

# 4. Scrape & Validate
if (-not $NoScrape) {
    Write-Host "[4/5] Scraping and validating proxy exit nodes..."
    if (-not (Test-Path $ConfigFile) -or $Force) {
        $ScrapeScript = Join-Path $ScriptDir "zen-scrape.js"
        $env:ZEN_TARGET_OK = "3"
        $env:ZEN_CHECK_CONCURRENCY = "4"
        & $nodeCmd.Source "$ScrapeScript" --limit 300 --concurrency 30 --zen-check 50 --output "$ConfigFile"
    } else {
        Write-Host "      Existing config found at $ConfigFile (use -Force to re-scrape)."
    }
} else {
    Write-Host "[4/5] Skipping proxy scrape (-NoScrape specified)."
}

# 5. Start Service
if (-not $NoService) {
    Write-Host "[5/5] Starting proxy services in background..."
    $ServiceScript = Join-Path $ScriptDir "zen-service.ps1"
    & $ServiceScript "restart"
} else {
    Write-Host "[5/5] Skipping service start (-NoService specified)."
}

if (-not $NoRestart) {
    $opencodeCmd = Get-Command "opencode" -ErrorAction SilentlyContinue
    if ($opencodeCmd) {
        Write-Host "`nRestarting OpenCode background service..."
        try {
            & $opencodeCmd.Source service restart
        } catch {
            Write-Host "Note: run 'opencode service restart' to apply proxy configuration."
        }
    }
}

Write-Host "`n=== Installation Complete! ===" -ForegroundColor Green
Write-Host "You can verify with:"
Write-Host "  opencode run --model opencode/deepseek-v4.1-flash-free `"Hello!`"`n"
