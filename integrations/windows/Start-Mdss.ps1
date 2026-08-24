#Requires -Version 5.1
<#
.SYNOPSIS
    One-command starter for mdss on Windows: hidden daemon (when needed) + tray icon.

.DESCRIPTION
    Safe to run repeatedly:
      - if a daemon already answers on the port, it is reused;
      - otherwise a hidden `mdss serve --db <Dir> --watch` is spawned (not owned -
        it keeps running after this script exits);
      - the tray companion is started unless -NoTray (the tray itself is
        single-instance and shows gray -> green once the daemon is warm).

.PARAMETER Db
    Notes directory to index/watch (required).

.PARAMETER Port
    Daemon port (default 8747).

.PARAMETER BindHost
    Host for health checks (default 127.0.0.1).

.PARAMETER ApiKey
    Bearer token if your daemon requires auth (or set MDSS_API_KEY).

.PARAMETER NoTray
    Skip starting the tray icon.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File Start-Mdss.ps1 -Db D:\Notes

.EXAMPLE
    .\start-mdss.cmd D:\Notes            # same thing, double-clickable
#>
param(
    [Parameter(Mandatory = $true)] [string] $Db,
    [int] $Port = 8747,
    [string] $BindHost = '127.0.0.1',
    [string] $ApiKey = '',
    [switch] $NoTray
)

$ErrorActionPreference = 'Stop'
$HealthUrl = "http://$($BindHost):$Port/health"

function Get-MdssHealth {
    try {
        $headers = @{}
        if ($ApiKey -or $env:MDSS_API_KEY) { $headers['Authorization'] = "Bearer $(if ($ApiKey) { $ApiKey } else { $env:MDSS_API_KEY })" }
        return Invoke-RestMethod -Uri $HealthUrl -Headers $headers -Method Get -TimeoutSec 2
    } catch { return $null }
}

$h = Get-MdssHealth
if ($null -ne $h) {
    Write-Output ("daemon already UP - {0} chunks ({1}) at {2}" -f $h.chunks, $h.model, $HealthUrl)
} else {
    if (-not (Test-Path -LiteralPath $Db)) { throw "notes directory not found: $Db" }
    $mdssCmd = Get-Command mdss -ErrorAction SilentlyContinue
    if ($mdssCmd) {
        $exe = $mdssCmd.Source; $argList = @('serve', '--db', $Db, '--port', "$Port", '--host', $BindHost, '--watch')
    } else {
        $exe = 'npx'; $argList = @('--yes', 'md-semantic-search', 'serve', '--db', $Db, '--port', "$Port", '--host', $BindHost, '--watch')
    }
    Write-Output "daemon DOWN - spawning hidden serve (first model load can take a minute)..."
    [void](Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Hidden)
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $h = Get-MdssHealth
        if ($null -ne $h) { break }
    }
    if ($null -eq $h) { throw "daemon did not come up within 90s at $HealthUrl" }
    Write-Output ("daemon UP - {0} chunks ({1})" -f $h.chunks, $h.model)
}

if ($NoTray) {
    Write-Output "search UI: http://$($BindHost):$Port/"
    exit 0
}

$tray = Join-Path $PSScriptRoot 'mdss-tray.ps1'
if (-not (Test-Path -LiteralPath $tray)) { Write-Warning "tray script not found next to launcher; skipping tray"; exit 0 }
$trayArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tray, '-Db', $Db, '-Port', "$Port", '-BindHost', $BindHost)
if ($ApiKey) { $trayArgs += @('-ApiKey', $ApiKey) }
[void](Start-Process -FilePath 'powershell' -ArgumentList $trayArgs -WindowStyle Hidden)
Write-Output "tray started (single-instance). Web UI: http://$($BindHost):$Port/"
