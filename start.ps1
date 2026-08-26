# Start SOLSCALP's long-running processes, detached, with real logs.
#
# WHY NOT pm2
#   pm2 is installed on this machine and reports these apps as "online" with a
#   pid and zero restarts while never executing the script at all: no snapshots,
#   no output, and both its own .log and .err files stayed at zero bytes through
#   a run that should have produced hundreds of lines. A process manager that
#   reports a healthy daemon when nothing is running is worse than no manager,
#   because it converts a loud failure into a silent one -- and this recorder's
#   data cannot be re-collected after the fact, so silent downtime is permanent
#   evidence loss. Verified working by contrast: Start-Process, below.
#
#   (pm2 still runs the separate stock-oracle app fine. This is not a claim that
#   pm2 is broken in general, only that it does not work for these scripts here.)
#
# WHY NOT `nohup ... &` FROM A SHELL
#   A backgrounded job is a child of the shell that started it. When that shell
#   goes away the job goes too -- the recorder ran 5.7 hours and then vanished
#   with no error and nobody having killed it. Start-Process creates a genuinely
#   independent process instead.
#
# Usage:   .\start.ps1            both
#          .\start.ps1 -Only bot  just one
#          npm run stop           stop them, verified

param(
  [ValidateSet('all', 'record', 'bot')]
  [string]$Only = 'all'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $root '.env'))) {
  Write-Host "No .env found. Copy .env.example and set SOLANA_RPC_URL." -ForegroundColor Yellow
  exit 2
}
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null

function Start-Solscalp {
  param([string]$Name, [string]$Script, [string[]]$ScriptArgs)

  # Our own log sink: independent of any process manager's capture, because that
  # capture is exactly what proved unreliable here.
  $env:SOLSCALP_LOG_FILE = "data/$Name.log"
  $proc = Start-Process -FilePath 'node' `
    -ArgumentList (@($Script) + $ScriptArgs) `
    -WorkingDirectory $root `
    -RedirectStandardOutput "data\$Name.out" `
    -RedirectStandardError  "data\$Name.err" `
    -WindowStyle Hidden -PassThru
  Write-Host ("  started {0,-8} pid {1}" -f $Name, $proc.Id) -ForegroundColor Green
  return $proc.Id
}

Write-Host "SOLSCALP" -ForegroundColor Cyan
Write-Host "paper only - there is no keypair in this repo and nothing here can sign"
Write-Host ""

$started = @()
if ($Only -eq 'all' -or $Only -eq 'record') {
  # The evidence collector. This is the one that must not miss time.
  $started += Start-Solscalp -Name 'record' -Script 'scripts/record.js' -ScriptArgs @('--early')
}
if ($Only -eq 'all' -or $Only -eq 'bot') {
  # 60s keeps the pair inside GeckoTerminal's 30 req/min per-IP budget; the
  # limiters are per-process and cannot see each other.
  $started += Start-Solscalp -Name 'bot' -Script 'scripts/bot.js' `
    -ScriptArgs @('--early', '--paper', '--interval', '60')
}

Write-Host ""
Write-Host "Verifying they are actually working (not merely running)..." -ForegroundColor Cyan
$before = 0
$today = Join-Path $root ("data\recordings\" + (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') + '.jsonl')
if (Test-Path $today) { $before = (Get-Content $today | Measure-Object -Line).Lines }
Start-Sleep -Seconds 12

$alive = @()
foreach ($id in $started) {
  if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $alive += $id }
}
Write-Host ("  processes alive: {0}/{1}" -f $alive.Count, $started.Count)
foreach ($n in @('record', 'bot')) {
  $f = Join-Path $root "data\$n.log"
  if (Test-Path $f) {
    $last = Get-Content $f -Tail 1
    Write-Host ("  {0,-8} {1}" -f $n, $last)
  }
}
Write-Host ""
Write-Host "Logs:  data\record.log  data\bot.log" -ForegroundColor DarkGray
Write-Host "Stop:  npm run stop" -ForegroundColor DarkGray
Write-Host "A running process keeps the credentials it loaded at startup -- editing" -ForegroundColor DarkGray
Write-Host ".env does not reach it, so restart after changing a token." -ForegroundColor DarkGray
