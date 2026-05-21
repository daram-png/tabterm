# diagnose-workers.ps1
# Map cmd.exe / claude.exe / bun(telegram bot) processes to worker-N, identify duplicates.
# Read-only: no kills.

$ErrorActionPreference = 'Stop'

function Get-WorkerFromCmdLine([string]$cmdLine) {
  if (-not $cmdLine) { return $null }
  if ($cmdLine -match 'worker-(\d+)') { return [int]$matches[1] }
  return $null
}

function Get-OrEmpty($map, $key) {
  if ($map.ContainsKey($key)) { return $map[$key] }
  return @()
}

# 1. cmd.exe with worker-N in CommandLine
$cmdByWorker = @{}
$allCmd = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'"
foreach ($p in $allCmd) {
  $w = Get-WorkerFromCmdLine $p.CommandLine
  if ($null -ne $w) {
    if (-not $cmdByWorker.ContainsKey($w)) { $cmdByWorker[$w] = @() }
    $cmdByWorker[$w] += [PSCustomObject]@{
      Pid     = $p.ProcessId
      Ppid    = $p.ParentProcessId
      Started = $p.CreationDate
      Cmd     = $p.CommandLine
    }
  }
}

# 2. claude.exe: walk parent chain (up to 5 hops) to find a worker-N cmd.exe
$allClaude = Get-CimInstance Win32_Process -Filter "Name='claude.exe'"
$claudeByWorker = @{}
$claudeUnmapped = @()
foreach ($p in $allClaude) {
  $worker = $null
  $cursor = $p.ParentProcessId
  $hops = 0
  while ($cursor -and $hops -lt 5) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor" -ErrorAction SilentlyContinue
    if (-not $parent) { break }
    if ($parent.Name -eq 'cmd.exe') {
      $worker = Get-WorkerFromCmdLine $parent.CommandLine
      if ($null -ne $worker) { break }
    }
    $cursor = $parent.ParentProcessId
    $hops++
  }
  $entry = [PSCustomObject]@{
    Pid     = $p.ProcessId
    Ppid    = $p.ParentProcessId
    Started = $p.CreationDate
  }
  if ($null -ne $worker) {
    if (-not $claudeByWorker.ContainsKey($worker)) { $claudeByWorker[$worker] = @() }
    $claudeByWorker[$worker] += $entry
  } else {
    $claudeUnmapped += $entry
  }
}

# 3. telegram bot: each worker STATE_DIR/bot.pid points to the paired bun process
$botPidByWorker = @{}
$botAlive = @{}
for ($i = 0; $i -lt 8; $i++) {
  $stateDir = Join-Path $env:USERPROFILE ".claude\channels\telegram-w$i"
  $pidFile  = Join-Path $stateDir 'bot.pid'
  if (Test-Path $pidFile) {
    try {
      $val = [int]((Get-Content $pidFile -Raw).Trim())
      $botPidByWorker[$i] = $val
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$val" -ErrorAction SilentlyContinue
      $botAlive[$i] = if ($proc) { $true } else { $false }
    } catch { }
  }
}

$allBun = Get-CimInstance Win32_Process -Filter "Name='bun.exe'"

# 4. Output
Write-Host ""
Write-Host "=== Per-worker processes ===" -ForegroundColor Cyan
for ($w = 0; $w -lt 8; $w++) {
  $cmd    = Get-OrEmpty $cmdByWorker $w
  $claude = Get-OrEmpty $claudeByWorker $w
  $botPid = $botPidByWorker[$w]
  $alive  = $botAlive[$w]
  $aliveStr = if ($alive) { 'ALIVE' } elseif ($null -ne $botPid) { 'DEAD' } else { 'NONE' }
  $line = "worker-$w : cmd $($cmd.Count) / claude $($claude.Count) / bot.pid=$botPid ($aliveStr)"
  if ($claude.Count -gt 1) { Write-Host $line -ForegroundColor Yellow }
  else { Write-Host $line }
  foreach ($c in ($claude | Sort-Object Started)) {
    Write-Host ("    claude PID={0,-6} Ppid={1,-6} Started={2}" -f $c.Pid, $c.Ppid, $c.Started)
  }
}

Write-Host ""
Write-Host "=== Duplicates (claude.exe count > 1) ===" -ForegroundColor Cyan
$dupFound = $false
for ($w = 0; $w -lt 8; $w++) {
  $claude = Get-OrEmpty $claudeByWorker $w
  if ($claude.Count -gt 1) {
    $dupFound = $true
    Write-Host ("worker-$w : {0} duplicates" -f $claude.Count) -ForegroundColor Yellow
    $sorted = $claude | Sort-Object Started
    $i = 0
    foreach ($c in $sorted) {
      $tag = if ($i -eq 0) { '[oldest]' } elseif ($i -eq ($sorted.Count - 1)) { '[newest]' } else { '' }
      Write-Host ("    PID={0,-6} Started={1} {2}" -f $c.Pid, $c.Started, $tag)
      $i++
    }
  }
}
if (-not $dupFound) { Write-Host "none" }

Write-Host ""
Write-Host "=== Unmapped claude.exe (external spawn or tabterm-direct) ===" -ForegroundColor Cyan
if ($claudeUnmapped.Count -eq 0) {
  Write-Host "none"
} else {
  Write-Host ("total {0}" -f $claudeUnmapped.Count)
  foreach ($c in ($claudeUnmapped | Sort-Object Started)) {
    Write-Host ("    PID={0,-6} Ppid={1,-6} Started={2}" -f $c.Pid, $c.Ppid, $c.Started)
  }
}

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
$totalClaude = $allClaude.Count
$totalBun    = $allBun.Count
$mappedClaude = ($claudeByWorker.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
$dupCount = 0
for ($w = 0; $w -lt 8; $w++) {
  $cnt = (Get-OrEmpty $claudeByWorker $w).Count
  if ($cnt -gt 1) { $dupCount += ($cnt - 1) }
}
Write-Host "claude.exe total : $totalClaude (mapped $mappedClaude / unmapped $($claudeUnmapped.Count))"
Write-Host "bun.exe total    : $totalBun"
Write-Host "duplicate kill candidates : $dupCount (keep 1 per worker)"
