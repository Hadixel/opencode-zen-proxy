#Requires -Version 5.1
<#
.SYNOPSIS
  Configure OpenCode to use the Zen Proxy at the fetch layer.

.DESCRIPTION
  Writes HTTPS_PROXY/HTTP_PROXY/NO_PROXY into OpenCode's service.json
  and installs the Zen retry plugin into OpenCode's plugin directory.

.PARAMETER Proxy
  Proxy URL. Default: http://127.0.0.1:10900

.PARAMETER NoProxy
  No-proxy hosts. Default: localhost,127.0.0.1,::1

.PARAMETER PrintShellEnv
  Only print the PowerShell environment variables.
#>
[CmdletBinding()]
param(
    [string]$Proxy = $(if ($env:ZEN_PROXY) { $env:ZEN_PROXY } else { "http://127.0.0.1:10900" }),
    [string]$NoProxy = "localhost,127.0.0.1,::1",
    [switch]$PrintShellEnv
)

$ErrorActionPreference = "Stop"

if ($PrintShellEnv) {
    Write-Output "`$env:HTTPS_PROXY = `"$Proxy`""
    Write-Output "`$env:HTTP_PROXY = `"$Proxy`""
    Write-Output "`$env:NO_PROXY = `"$NoProxy`""
    exit 0
}

$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $HOME ".config\opencode" }
if (-not (Test-Path $ConfigDir)) {
    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
}

# 1. Update service.json
$ServiceFile = Join-Path $ConfigDir "service.json"
$ConfigData = @{}
if (Test-Path $ServiceFile) {
    try {
        $Raw = Get-Content $ServiceFile -Raw
        if ($Raw.Trim()) {
            $ConfigData = $Raw | ConvertFrom-Json -AsHashtable
        }
    } catch {
        Write-Warning "Could not parse existing service.json; creating new configuration."
        $ConfigData = @{}
    }
}

if (-not $ConfigData.ContainsKey("env") -or $null -eq $ConfigData["env"]) {
    $ConfigData["env"] = @{}
}

$ConfigData["env"]["HTTPS_PROXY"] = $Proxy
$ConfigData["env"]["HTTP_PROXY"] = $Proxy
$ConfigData["env"]["NO_PROXY"] = $NoProxy

$JsonContent = $ConfigData | ConvertTo-Json -Depth 10
Set-Content -Path $ServiceFile -Value $JsonContent -Encoding UTF8
Write-Host "[zen-setup] Updated service environment in $ServiceFile"

# 2. Install retry plugin
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginSrc = Join-Path $ScriptDir "zen-retry-plugin.js"

if (Test-Path $PluginSrc) {
    $PluginDir = Join-Path $ConfigDir "plugin"
    if (-not (Test-Path $PluginDir)) {
        New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
    }
    $PluginDest = Join-Path $PluginDir "zen-retry.js"
    if (Test-Path $PluginDest) {
        $OldHash = (Get-FileHash $PluginDest -Algorithm SHA256).Hash
        $NewHash = (Get-FileHash $PluginSrc -Algorithm SHA256).Hash
        if ($OldHash -ne $NewHash) {
            $Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
            Copy-Item $PluginDest (Join-Path $PluginDir "zen-retry.js.bak.$Timestamp") -Force
        }
    }
    Copy-Item $PluginSrc $PluginDest -Force
    Write-Host "[zen-setup] Installed retry plugin in $PluginDest"
}

Write-Host "`nOpenCode is now configured for Zen Proxy."
Write-Host "Next step: restart OpenCode service to apply changes:"
Write-Host "  opencode service restart`n"
