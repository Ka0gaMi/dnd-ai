# Connects the spike MCP server to ChatGPT through OpenAI's Secure MCP Tunnel (no public URL).
# Prereqs: the spike server is running (node server.mjs), $env:CONTROL_PLANE_API_KEY holds a
# runtime API key with Tunnels Read + Use, and you pass the tunnel id from
# https://platform.openai.com/settings/organization/tunnels
param(
  [Parameter(Mandatory = $true)][string]$TunnelId
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $env:CONTROL_PLANE_API_KEY) {
  throw 'Set $env:CONTROL_PLANE_API_KEY to your runtime API key first (Tunnels Read + Use).'
}

$tc = 'C:\Users\Kornelijus.kvindt\tools\tunnel-client\tunnel-client.exe'
$secret = (Get-Content secret.txt -Raw).Trim()
$mcpUrl = "http://127.0.0.1:8765/mcp/$secret"
$profileDir = Join-Path $PSScriptRoot 'tunnel-profiles'

& $tc init --force --sample sample_mcp_remote_no_auth --profile dnd-spike `
  --profile-dir $profileDir --tunnel-id $TunnelId --mcp-server-url $mcpUrl `
  --health-listen-addr 127.0.0.1:8790

& $tc doctor --profile dnd-spike --profile-dir $profileDir --explain

Write-Host ''
Write-Host "Tunnel daemon starting. Status UI: http://127.0.0.1:8790/ui   (Ctrl+C stops it)" -ForegroundColor Green
Write-Host "In ChatGPT: Settings -> Apps/Plugins -> + -> Connection: Tunnel -> pick $TunnelId" -ForegroundColor Green
& $tc run --profile dnd-spike --profile-dir $profileDir
