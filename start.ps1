<#
Starts the dnd-ai server (and, by default, the OpenAI tunnel) in the background and opens the
companion window. Safe to re-run: it skips steps that are already done and refuses to start a
second server if one is already listening on port 8765 (run .\stop.ps1 first).
#>
[CmdletBinding()]
param(
  [switch]$NoTunnel,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$Port = 8765
$TunnelHealthPort = 8790
$TunnelExe = Join-Path $env:USERPROFILE 'tools\tunnel-client\tunnel-client.exe'
$LogDir = Join-Path $PSScriptRoot 'logs'
$ServerLog = Join-Path $LogDir 'server.log'
$ServerErrLog = Join-Path $LogDir 'server.err.log'
$TunnelLog = Join-Path $LogDir 'tunnel.log'
$TunnelErrLog = Join-Path $LogDir 'tunnel.err.log'

# --- fail fast: tunnel prerequisites, before installing/building/starting anything ---
if (-not $NoTunnel) {
  if (-not $env:CONTROL_PLANE_API_KEY) {
    throw ('Set $env:CONTROL_PLANE_API_KEY in this PowerShell window first: a runtime API key with ' +
      'Tunnels Read + Use, from https://platform.openai.com/settings/organization/api-keys')
  }
  if (-not (Test-Path $TunnelExe)) {
    throw "Tunnel client not found at $TunnelExe"
  }
}

function Get-NewestWriteTimeUtc([string[]]$Paths) {
  $files = foreach ($p in $Paths) {
    if (Test-Path $p -PathType Leaf) { Get-Item $p }
    elseif (Test-Path $p) { Get-ChildItem -Path $p -Recurse -File -ErrorAction SilentlyContinue }
  }
  ($files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
}

function Test-Stale([string]$Target, [string[]]$WatchPaths) {
  if (-not (Test-Path $Target)) { return $true }
  $newest = Get-NewestWriteTimeUtc $WatchPaths
  return $newest -and $newest -gt (Get-Item $Target).LastWriteTimeUtc
}

function Wait-ForHttp200([string]$Url, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $nextDot = (Get-Date).AddSeconds(2)
  while ((Get-Date) -lt $deadline) {
    try {
      if ((Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { return $true }
    } catch { }
    if ((Get-Date) -ge $nextDot) {
      Write-Host -NoNewline '.'
      $nextDot = (Get-Date).AddSeconds(2)
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# --- refuse if already running (the port-8765 gotcha: a stale server silently keeps the port) ---
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  $owner = Get-Process -Id $listening[0].OwningProcess -ErrorAction SilentlyContinue
  Write-Host "Port $Port is already in use by $($owner.ProcessName) (PID $($owner.Id))." -ForegroundColor Red
  Write-Host 'Run .\stop.ps1 first.' -ForegroundColor Red
  exit 1
}

# --- dependencies ---
if (-not (Test-Path 'node_modules')) {
  Write-Host 'Installing server dependencies...' -ForegroundColor Cyan
  npm install
}
if (-not (Test-Path 'web/node_modules')) {
  Write-Host 'Installing companion dependencies...' -ForegroundColor Cyan
  npm --prefix web install
}

# --- build ---
if (Test-Stale 'dist/bin/http.js' @('src')) {
  Write-Host 'Building server...' -ForegroundColor Cyan
  npm run build
}
if (Test-Stale 'web/dist/index.html' @('web/src', 'web/index.html')) {
  Write-Host 'Building companion UI...' -ForegroundColor Cyan
  npm run build:web
}

# --- start server ---
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
# Start-Process truncates the redirected log, so the previous session's tool-call record is kept under
# the date it was last written: it is the baseline the tool audit reads.
foreach ($log in @($ServerLog, $ServerErrLog)) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 0) {
    $stamp = (Get-Item $log).LastWriteTime.ToString('yyyyMMdd-HHmmss')
    $name = [System.IO.Path]::GetFileNameWithoutExtension($log)
    Move-Item $log (Join-Path $LogDir ("{0}-{1}.log" -f $name, $stamp))
  }
}
Start-Process -FilePath 'node' -ArgumentList @('dist\bin\http.js') `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
  -RedirectStandardOutput $ServerLog -RedirectStandardError $ServerErrLog | Out-Null

Write-Host 'Waiting for the server to become healthy...' -ForegroundColor Cyan
$serverWaitStart = Get-Date
if (-not (Wait-ForHttp200 "http://127.0.0.1:$Port/healthz" 90)) {
  Write-Host ''
  Write-Host "Server did not become healthy within 90s; check $ServerLog" -ForegroundColor Red
  exit 1
}
$serverWaitElapsed = [int](New-TimeSpan -Start $serverWaitStart -End (Get-Date)).TotalSeconds
Write-Host ''
Write-Host "Server healthy after ${serverWaitElapsed}s" -ForegroundColor Green

# --- start tunnel ---
$tunnelStatus = 'skipped (-NoTunnel)'
if (-not $NoTunnel) {
  $profileDir = Join-Path $PSScriptRoot 'tunnel\tunnel-profiles'
  Start-Process -FilePath $TunnelExe -ArgumentList @('run', '--profile', 'dnd-spike', '--profile-dir', $profileDir) `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
    -RedirectStandardOutput $TunnelLog -RedirectStandardError $TunnelErrLog | Out-Null

  Write-Host 'Waiting for the tunnel to become ready...' -ForegroundColor Cyan
  if (Wait-ForHttp200 "http://127.0.0.1:$TunnelHealthPort/readyz" 90) {
    Write-Host ''
    $tunnelStatus = 'ready'
  } else {
    Write-Host ''
    $tunnelStatus = "not ready after 90s (check $TunnelLog)"
    Write-Warning "Tunnel did not report ready within 90s; check $TunnelLog"
  }
}

if (-not $NoBrowser) {
  Start-Process "http://127.0.0.1:$Port/"
}

Write-Host ''
Write-Host '=== dnd-ai is running ===' -ForegroundColor Green
Write-Host "Server URL:    http://127.0.0.1:$Port/"
Write-Host "Companion URL: http://127.0.0.1:$Port/  (same process, second monitor)"
Write-Host "Tunnel:        $tunnelStatus"
$portraitStatus = if ($env:CLOUDFLARE_ACCOUNT_ID -and $env:CLOUDFLARE_API_TOKEN) { 'enabled' }
  else { 'disabled (set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)' }
Write-Host "Portraits:     $portraitStatus"
Write-Host "Server log:    $ServerLog"
if (-not $NoTunnel) {
  Write-Host "Tunnel log:    $TunnelLog"
  Write-Host "Tunnel errors: $TunnelErrLog"
}
if ($tunnelStatus -ne 'ready') {
  Write-Host 'Tunnel not running -> ChatGPT will show cached/old tools until it is.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host "In ChatGPT: open a chat, add the 'dnd tunnel' app, and type: /resume  (or 'start a new story')"
