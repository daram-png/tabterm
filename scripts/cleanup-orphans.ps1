# cleanup-orphans.ps1
# Kill orphan bun/claude processes, keeping only:
#   - Paired telegram bots (STATE_DIR/bot.pid for worker-0..7)
#   - Parent claude.exe of each paired bot
#   - The claude.exe ancestor of THIS script (self-protect)
#
# Usage:
#   powershell -File cleanup-orphans.ps1            # dry-run (default)
#   powershell -File cleanup-orphans.ps1 -Force     # actually kill

param([switch]$Force)

$ErrorActionPreference = 'Stop'

function Get-Proc($targetPid) {
  return Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
}

# 1. Walk parent chain from $PID (this PowerShell) up to find a claude.exe to protect.
$selfPid = $PID
$selfClaudePid = $null
$cursor = $selfPid
$hops = 0
while ($cursor -and $hops -lt 10) {
  $p = Get-Proc $cursor
  if (-not $p) { break }
  if ($p.Name -eq 'claude.exe') { $selfClaudePid = $p.ProcessId; break }
  $cursor = $p.ParentProcessId
  $hops++
}

# 2. Read each worker STATE_DIR/bot.pid -> paired bot PID
$pairedBotPids = @()
$pairedClaudePids = @()
for ($i = 0; $i -lt 8; $i++) {
  $stateDir = Join-Path $env:USERPROFILE ".claude\channels\telegram-w$i"
  $pidFile  = Join-Path $stateDir 'bot.pid'
  if (-not (Test-Path $pidFile)) { continue }
  try {
    $botPid = [int]((Get-Content $pidFile -Raw).Trim())
  } catch { continue }
  $botProc = Get-Proc $botPid
  if (-not $botProc) { continue }
  $pairedBotPids += $botPid
  # Walk up to find claude.exe parent
  $cursor = $botProc.ParentProcessId
  $hops = 0
  while ($cursor -and $hops -lt 5) {
    $p = Get-Proc $cursor
    if (-not $p) { break }
    if ($p.Name -eq 'claude.exe') { $pairedClaudePids += $p.ProcessId; break }
    $cursor = $p.ParentProcessId
    $hops++
  }
}

# 3. Whitelist (use plain int arrays — hashtable.ContainsKey hits a
# uint32/int type mismatch on Win32_Process.ProcessId in PS 5.1).
$keepClaudeList = @($pairedClaudePids | ForEach-Object { [int]$_ })
if ($selfClaudePid) { $keepClaudeList += [int]$selfClaudePid }
$keepBunList = @($pairedBotPids | ForEach-Object { [int]$_ })

# 4. Collect kill targets
$allBun    = Get-CimInstance Win32_Process -Filter "Name='bun.exe'"
$allClaude = Get-CimInstance Win32_Process -Filter "Name='claude.exe'"
$killBun    = $allBun    | Where-Object { [int]$_.ProcessId -notin $keepBunList }
$killClaude = $allClaude | Where-Object { [int]$_.ProcessId -notin $keepClaudeList }

# 5. Output
Write-Host ""
Write-Host "=== Whitelist (keep) ===" -ForegroundColor Cyan
Write-Host ("paired bots (bun.exe)    : {0}" -f $pairedBotPids.Count)
foreach ($v in $pairedBotPids) { Write-Host ("    PID={0}" -f $v) }
Write-Host ("paired claude (parents)  : {0}" -f $pairedClaudePids.Count)
foreach ($v in $pairedClaudePids) { Write-Host ("    PID={0}" -f $v) }
Write-Host ("self claude (this CLI)   : {0}" -f $selfClaudePid)

Write-Host ""
Write-Host "=== Kill targets (orphan) ===" -ForegroundColor Yellow
Write-Host ("bun.exe orphan    : {0}" -f $killBun.Count)
foreach ($p in ($killBun | Sort-Object CreationDate)) {
  Write-Host ("    PID={0,-6} Ppid={1,-6} Started={2}" -f $p.ProcessId, $p.ParentProcessId, $p.CreationDate)
}
Write-Host ("claude.exe orphan : {0}" -f $killClaude.Count)
foreach ($p in ($killClaude | Sort-Object CreationDate)) {
  Write-Host ("    PID={0,-6} Ppid={1,-6} Started={2}" -f $p.ProcessId, $p.ParentProcessId, $p.CreationDate)
}

Write-Host ""
if ($Force) {
  Write-Host "=== Killing ===" -ForegroundColor Red
  foreach ($p in $killBun) {
    & taskkill /F /T /PID $p.ProcessId 2>&1 | Out-Null
    Write-Host ("    killed bun PID={0}" -f $p.ProcessId)
  }
  foreach ($p in $killClaude) {
    & taskkill /F /T /PID $p.ProcessId 2>&1 | Out-Null
    Write-Host ("    killed claude PID={0}" -f $p.ProcessId)
  }
} else {
  Write-Host "=== DRY-RUN ===" -ForegroundColor Green
  Write-Host "No processes were killed. Re-run with -Force to actually kill."
}
