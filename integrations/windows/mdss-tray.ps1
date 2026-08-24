#Requires -Version 5.1
<#
.SYNOPSIS
    mdss-tray - system tray companion for `mdss serve`.

.DESCRIPTION
    Shows a tray icon reflecting the live state of the local mdss daemon:
    green = healthy, yellow = searches in flight / queue busy, gray = unreachable.
    Hovering shows chunk count, model, index age and watch status; a balloon pops
    whenever the knowledge base gets re-indexed (`built` timestamp changes).

    Zero npm dependencies: pure PowerShell over .NET WinForms (built into Windows).
    The daemon itself is NOT bundled here - point -Db at your notes and pass
    -Launch to let the tray start a hidden `mdss serve --watch`, or run the
    daemon yourself and the tray will simply attach to it.

.PARAMETER Db
    Notes directory passed to `mdss serve --db` when -Launch starts the daemon.

.PARAMETER Port
    Daemon port (default 8747, same default as `mdss serve`).

.PARAMETER BindHost
    Host the tray polls (default 127.0.0.1). Must match what serve was started with.

.PARAMETER ApiKey
    Bearer token, required if the daemon was started with --api-key.
    Falls back to $env:MDSS_API_KEY.

.PARAMETER Launch
    Spawn a hidden `mdss serve --db <Db> --watch` when /health does not answer.
    The spawned process belongs to this tray session and is stopped on Exit.

.PARAMETER PollMs
    Health poll interval in milliseconds (default 5000).

.PARAMETER CheckHealth
    Headless self-test: poll once, print a formatted status line, exit 0/1.
    No tray UI is created - used by scripts and CI smoke checks.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File mdss-tray.ps1 -Db D:\Notes -Launch

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File mdss-tray.ps1 -CheckHealth
#>
param(
    [string] $Db = '',
    [int] $Port = 8747,
    [string] $BindHost = '127.0.0.1',
    [string] $ApiKey = '',
    [switch] $Launch,
    [int] $PollMs = 5000,
    [switch] $CheckHealth
)

$ErrorActionPreference = 'Stop'

if (-not $ApiKey -and $env:MDSS_API_KEY) { $ApiKey = $env:MDSS_API_KEY }
$HealthUrl = "http://$($BindHost):$Port/health"

function Get-MdssHealth {
    try {
        $headers = @{}
        if ($ApiKey) { $headers['Authorization'] = "Bearer $ApiKey" }
        return Invoke-RestMethod -Uri $HealthUrl -Headers $headers -Method Get -TimeoutSec 2
    } catch {
        return $null
    }
}

function Format-IndexAge([string] $BuiltIso) {
    if (-not $BuiltIso) { return 'never' }
    try {
        $age = (Get-Date) - ([datetime]::Parse($BuiltIso, [Globalization.CultureInfo]::InvariantCulture))
    } catch { return 'unknown age' }
    if ($age.TotalMinutes -lt 1) { return 'just now' }
    if ($age.TotalHours   -lt 1) { return '{0}m ago'  -f [int]$age.TotalMinutes }
    if ($age.TotalDays    -lt 1) { return '{0}h {1}m ago' -f [int]$age.TotalHours, ([int]($age.Minutes)) }
    return '{0}d ago' -f [int]$age.TotalDays
}

function Format-MdssStatus($h) {
    if ($null -eq $h) { return "mdss DOWN on ${BindHost}:$Port" }
    return ('mdss OK - {0} chunks - {1} (dim {2}) - built {3}{4}{5}' -f `
        $h.chunks, $h.model, $h.dim, (Format-IndexAge $h.built), `
        ($(if ($h.watching) { ' - watching' } else { '' })), `
        ($(if ($h.in_flight -or $h.queued) { ' - busy ({0} in flight, {1} queued)' -f $h.in_flight, $h.queued } else { '' })))
}

# ---- Headless self-test path -------------------------------------------------
if ($CheckHealth) {
    $h = Get-MdssHealth
    Write-Output (Format-MdssStatus $h)
    if ($null -eq $h) { exit 1 }
    exit 0
}

# ---- Tray UI -----------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:childProc = $null      # daemon process we spawned (-Launch) and own
$script:lastHealth = $null     # previous poll result, for change detection

function New-StateIcon([System.Drawing.Color] $color) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $dot = New-Object System.Drawing.SolidBrush $color
    $ring = [System.Drawing.Pens]::DimGray
    $g.FillEllipse($dot, 3, 3, 10, 10)
    $g.DrawEllipse($ring, 2, 2, 11, 11)
    $g.Dispose()
    $dot.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$icons = @{
    Ok    = New-StateIcon ([System.Drawing.Color]::ForestGreen)
    Busy  = New-StateIcon ([System.Drawing.Color]::Goldenrod)
    Down  = New-StateIcon ([System.Drawing.Color]::Gray)
}

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = 'Hidden'
$form.FormBorderStyle = 'None'
$form.Opacity = 0
$form.ShowInTaskbar = $false

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemUi     = $menu.Items.Add('Open Web UI');            $itemUi.Add_Click({ Start-Process "http://$($BindHost):$Port/" }.GetNewClosure())
$itemStatus = $menu.Items.Add('Show status');            $itemStatus.Add_Click({ $script:balloonRequested = $true })
$itemStart  = $menu.Items.Add('Start serve (hidden)')
$itemStart.Add_Click({
    if ($script:childProc -and -not $script:childProc.HasExited) { return }
    if (-not $Db) {
        [System.Windows.Forms.MessageBox]::Show('Start the tray with -Db <notes dir> -Launch to allow spawning the daemon.', 'mdss tray') | Out-Null
        return
    }
    $mdss = Get-Command mdss -ErrorAction SilentlyContinue
    $exe = if ($mdss) { $mdss.Source } else { 'npx' }
    $argList = if ($mdss) { @('serve', '--db', $Db, '--port', "$Port", '--host', $BindHost, '--watch') }
               else           { @('--yes', 'md-semantic-search', 'serve', '--db', $Db, '--port', "$Port", '--host', $BindHost, '--watch') }
    $script:childProc = Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Hidden -PassThru
}.GetNewClosure())
$itemStop   = $menu.Items.Add('Stop serve')
$itemStop.Add_Click({
    if ($script:childProc -and -not $script:childProc.HasExited) {
        try { Stop-Process -Id $script:childProc.Id -Force -ErrorAction Stop } catch {}
        $script:childProc = $null
    }
}.GetNewClosure())
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$itemExit   = $menu.Items.Add('Exit')
$itemExit.Add_Click({ $form.Close() })

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icons.Down
$notify.Text = 'mdss: starting...'
$notify.ContextMenuStrip = $menu
$notify.Visible = $true

function Show-Balloon([string] $title, [string] $text, [System.Windows.Forms.ToolTipIcon] $kind) {
    $notify.BalloonTipTitle = $title
    $notify.BalloonTipText = $text
    $notify.ShowBalloonTip(5000, $title, $text, $kind)
}

function Update-TrayState {
    $h = Get-MdssHealth
    $prev = $script:lastHealth
    $script:lastHealth = $h

    if ($null -eq $h) {
        $notify.Icon = $icons.Down
        $notify.Text = Format-MdssStatus $null
        if ($null -ne $prev -or $script:balloonRequested) {
            Show-Balloon 'mdss daemon unreachable' "No answer from $HealthUrl. Is 'mdss serve' running?" 'Warning'
        }
        $itemStart.Enabled = ($null -ne $Db -and $Db -ne '')
        $itemStop.Enabled = ($script:childProc -and -not $script:childProc.HasExited)
    } else {
        $busy = [bool]($h.in_flight -or $h.queued)
        $notify.Icon = if ($busy) { $icons.Busy } else { $icons.Ok }
        $notify.Text = (Format-MdssStatus $h).Substring(0, [Math]::Min(63, (Format-MdssStatus $h).Length))
        $cameUp = ($null -eq $prev)
        $rebuilt = ($null -ne $prev -and $prev.built -ne $h.built)
        if ($cameUp -or $rebuilt -or $script:balloonRequested) {
            $title = if ($rebuilt) { 'Knowledge base re-indexed' } elseif ($cameUp) { 'mdss daemon is up' } else { 'mdss status' }
            Show-Balloon $title ("{0} chunks - {1}`nbuilt {2}" -f $h.chunks, $h.model, (Format-IndexAge $h.built)) 'Info'
        }
        $itemStart.Enabled = $false
        $itemStop.Enabled = ($script:childProc -and -not $script:childProc.HasExited)
    }
    $script:balloonRequested = $false
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $PollMs
$timer.Add_Tick({ Update-TrayState })

$form.Add_Shown({ Update-TrayState })
$form.Add_Closed({
    $timer.Stop()
    $notify.Visible = $false
    $notify.Dispose()
    if ($script:childProc -and -not $script:childProc.HasExited) {
        try { Stop-Process -Id $script:childProc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
})

if ($Launch -and $Db) {
    & { # reuse the menu-start logic once at boot
        $mdssCmd = Get-Command mdss -ErrorAction SilentlyContinue
        $exe = if ($mdssCmd) { $mdssCmd.Source } else { 'npx' }
        $argList = if ($mdssCmd) { @('serve', '--db', $Db, '--port', "$Port", '--host', $BindHost, '--watch') }
                   else           { @('--yes', 'md-semantic-search', 'serve', '--db', $Db, '--port', "$Port", '--host', $BindHost, '--watch') }
        $script:childProc = Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Hidden -PassThru
    }
}

$script:balloonRequested = $true   # first tick reports the initial state
$timer.Start()
[void]$form.Show()
[void][System.Windows.Forms.Application]::Run($form)
