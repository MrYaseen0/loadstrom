# Strom Fire launcher (Windows PowerShell)
# Usage:   powershell -ExecutionPolicy Bypass -File .\run.ps1
# Double-clicking start.bat is easier for most users.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "  Node.js is required. Install it free (LTS) from https://nodejs.org" -ForegroundColor Red
  Write-Host ""
  exit 1
}

if (-not $env:PORT) { $env:PORT = '8787' }

Write-Host ""
Write-Host "  Starting Strom Fire on http://127.0.0.1:$($env:PORT)/" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

# Open the dashboard a couple of seconds after the server boots.
$openJob = {
  param($port)
  Start-Sleep -Seconds 2
  Start-Process "http://127.0.0.1:$port/"
}
Start-Job -ScriptBlock $openJob -ArgumentList $env:PORT | Out-Null

node server.js
