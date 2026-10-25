#Requires -Version 5.1
<#
.SYNOPSIS
  OpenCode Zen Proxy entrypoint.
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ArgsList
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher = Join-Path $ScriptDir "bin\start.ps1"

& $Launcher @ArgsList
