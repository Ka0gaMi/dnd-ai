<#
Stops the dnd-ai server (whatever is listening on port 8765) and any running tunnel-client.
#>
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$Port = 8765
$stopped = @()

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $listening) {
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  if ($proc) {
    Write-Host "Stopping $($proc.ProcessName) (PID $($proc.Id)) listening on port $Port..." -ForegroundColor Cyan
    Stop-Process -Id $proc.Id -Force
    $stopped += "$($proc.ProcessName) (PID $($proc.Id))"
  }
}

$tunnelProcs = Get-Process -Name 'tunnel-client' -ErrorAction SilentlyContinue
foreach ($proc in $tunnelProcs) {
  Write-Host "Stopping tunnel-client (PID $($proc.Id))..." -ForegroundColor Cyan
  Stop-Process -Id $proc.Id -Force
  $stopped += "tunnel-client (PID $($proc.Id))"
}

if ($stopped.Count -eq 0) {
  Write-Host 'Nothing was running.' -ForegroundColor Yellow
} else {
  Write-Host "Stopped: $($stopped -join ', ')" -ForegroundColor Green
}

Start-Sleep -Milliseconds 500
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "Port $Port is still in use." -ForegroundColor Red
} else {
  Write-Host "Port $Port is free." -ForegroundColor Green
}
