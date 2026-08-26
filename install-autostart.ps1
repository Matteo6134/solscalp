# Make SOLSCALP start itself at logon.
#
# WHY A SCHEDULED TASK RATHER THAN pm2
#   pm2 is installed here and reports these scripts as "online" while never
#   executing them: correct path, correct cwd, a pid, zero restarts, and zero
#   snapshots written. A supervisor that claims a daemon is healthy when nothing
#   is running is worse than none, because it turns a loud failure into a silent
#   one -- and this recorder's data cannot be re-collected afterwards, so silent
#   downtime is permanent evidence loss.
#
# WHY AtLogOn AND NOT AtStartup
#   AtStartup runs before any user session exists, in a context that does not
#   reliably have the user's environment or drive mappings. The recorder needs to
#   read .env from the repo and reach the network as this user. Logon is the
#   honest trigger: it also means the task needs no stored password.
#
# Usage:  .\install-autostart.ps1            register
#         .\install-autostart.ps1 -Remove    unregister
#         .\install-autostart.ps1 -Status    show what is registered

param(
  [switch]$Remove,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$TaskName = 'SOLSCALP'
$root = $PSScriptRoot
$starter = Join-Path $root 'start.ps1'
$startupDir = [Environment]::GetFolderPath('Startup')
$cmdName = 'solscalp.cmd'

function Show-Status {
  $f = Join-Path $startupDir $cmdName
  if (-not (Test-Path $f)) { Write-Host "autostart: not installed" -ForegroundColor Yellow; return }
  Write-Host "autostart: installed" -ForegroundColor Green
  Write-Host "  file   : $f"
  Write-Host "  runs   : $starter"
  Write-Host "  trigger: at logon for $env:USERNAME"
}

if ($Status) { Show-Status; exit 0 }

if ($Remove) {
  $f = Join-Path $startupDir $cmdName
  if (Test-Path $f) {
    Remove-Item $f -Force
    Write-Host "removed autostart ($f)" -ForegroundColor Green
    Write-Host "already-running processes are untouched; use 'npm run stop' for those"
  } else { Write-Host "nothing to remove" -ForegroundColor Yellow }
  exit 0
}

if (-not (Test-Path $starter)) { throw "start.ps1 not found next to this script" }
if (-not (Test-Path (Join-Path $root '.env'))) {
  Write-Host "Warning: no .env yet. The task will register, but SOLSCALP needs" -ForegroundColor Yellow
  Write-Host "SOLANA_RPC_URL set before it can do anything useful." -ForegroundColor Yellow
}

# A .cmd rather than a .lnk: plain text, so anyone can read exactly what runs.
$cmdPath = Join-Path $startupDir 'solscalp.cmd'
$body = @"
@echo off
rem Starts SOLSCALP at logon. Written by install-autostart.ps1.
rem Paper only: there is no keypair in this repo and nothing here can sign.
cd /d "$root"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$starter"
"@
Set-Content -Path $cmdPath -Value $body -Encoding ASCII

# VERIFY. The first version of this script printed "registered" after the call
# had already failed -- the same report-success-without-checking bug that let five
# stale bot processes accumulate earlier. Never announce what was not confirmed.
Write-Host ""
if (-not (Test-Path $cmdPath)) {
  Write-Host "FAILED: could not write $cmdPath. Nothing will auto-start." -ForegroundColor Red
  exit 2
}
Write-Host "registered: SOLSCALP will start at logon" -ForegroundColor Green
Write-Host ""
Show-Status
Write-Host ""
Write-Host "start.ps1 does not stack copies: it is the only thing this runs, and" -ForegroundColor DarkGray
Write-Host "'npm run stop' is how you stop them." -ForegroundColor DarkGray
Write-Host "It will NOT start a second copy if one is already running." -ForegroundColor DarkGray
Write-Host "Remove with:  .\install-autostart.ps1 -Remove" -ForegroundColor DarkGray
