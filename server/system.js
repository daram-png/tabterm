import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import { audit } from './audit.js';
import { hydraStatus, hydraLiveHealth } from './hydra.js';
import {
  getWatchdogPid,
  getWatchdogState,
  getWatchdogHealth,
  tailWatchdogLog,
  startWatchdog,
  stopWatchdog,
} from './watchdog.js';

const execFileAsync = promisify(execFile);

const ZOMBIE_TARGETS = new Set(['bun.exe', 'claude.exe', 'node.exe']);
const PROCESS_LIST_BUFFER = 8 * 1024 * 1024;

async function listProcessSnapshot() {
  // PowerShell Get-CimInstance returns ProcessId + ParentProcessId.
  // wmic is deprecated since Windows 11 22H2, so we avoid it.
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId | ConvertTo-Json -Compress',
      ],
      { maxBuffer: PROCESS_LIST_BUFFER, windowsHide: true },
    );
    // Strip BOM + whitespace — some PowerShell versions prepend a UTF-8 BOM
    // even with -NoProfile. JSON.parse throws on BOM, but the outer try
    // would swallow it as "process-list-failed" without explanation.
    const cleaned = (stdout || '[]').replace(/^﻿/, '').trim();
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const map = new Map();
    for (const p of arr) {
      if (!p || typeof p.ProcessId !== 'number') continue;
      map.set(p.ProcessId, {
        name: String(p.Name || '').toLowerCase(),
        ppid: typeof p.ParentProcessId === 'number' ? p.ParentProcessId : null,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

function descendantsOf(rootPids, processMap) {
  const set = new Set();
  for (const r of rootPids) if (Number.isInteger(r) && r > 0) set.add(r);
  let grew = true;
  let safety = 64; // process tree depth bound, prevents pathological loops
  while (grew && safety-- > 0) {
    grew = false;
    for (const [pid, info] of processMap) {
      if (!set.has(pid) && info.ppid != null && set.has(info.ppid)) {
        set.add(pid);
        grew = true;
      }
    }
  }
  return set;
}

export function registerSystemRoutes(app, ctx) {
  const {
    sessions,
    spawnWorkerSession,
    workersCount,
    requireAuth,
    requireCsrf,
  } = ctx;

  app.post('/api/system/cleanup-zombies', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    if (!requireCsrf(req, reply)) return;

    // Stop the watchdog FIRST. The external watchdog at WATCHDOG_PATH
    // respawns dead claude/bot processes on its own schedule, so anything we
    // kill here gets undone within a cycle. Leave it stopped until the user
    // explicitly reboots via /api/system/boot-all, which restarts it.
    const watchdogStopped = stopWatchdog(app.log);

    const processMap = await listProcessSnapshot();
    if (processMap.size === 0) {
      audit.log({ event: 'system.cleanup-zombies.aborted', reason: 'process-list-empty', ip: req.ip });
      return reply.code(500).send({ error: 'process-list-failed' });
    }

    const sessionPids = [];
    for (const s of sessions.list()) {
      const pid = sessions.getPtyPid(s.id);
      if (pid) sessionPids.push(pid);
    }
    const wdPid = getWatchdogPid();
    const roots = [process.pid, wdPid, ...sessionPids].filter(
      (x) => Number.isInteger(x) && x > 0,
    );
    const protectedSet = descendantsOf(roots, processMap);

    const targets = [];
    for (const [pid, info] of processMap) {
      if (!ZOMBIE_TARGETS.has(info.name)) continue;
      if (protectedSet.has(pid)) continue;
      targets.push({ pid, name: info.name, ppid: info.ppid });
    }

    const killed = [];
    const failed = [];
    for (const t of targets) {
      try {
        // /T = kill the whole tree. Without it bun.exe wrappers leave their
        // server.ts children alive (and vice versa), so duplicates persist
        // and the next cleanup pass keeps finding them.
        await execFileAsync('taskkill.exe', ['/F', '/T', '/PID', String(t.pid)], { windowsHide: true });
        killed.push(t);
      } catch (e) {
        failed.push({ ...t, error: String(e?.message || e).slice(0, 200) });
      }
    }

    audit.log({
      event: 'system.cleanup-zombies',
      ip: req.ip,
      killedCount: killed.length,
      failedCount: failed.length,
      protectedCount: protectedSet.size,
      processCount: processMap.size,
      rootPids: roots,
      watchdogStopped,
    });

    return {
      killed,
      failed,
      protectedPids: [...protectedSet],
      processCount: processMap.size,
      watchdogStopped,
    };
  });

  app.post('/api/system/boot-all', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    if (!requireCsrf(req, reply)) return;
    if (typeof spawnWorkerSession !== 'function') {
      return reply.code(500).send({ error: 'spawn-helper-missing' });
    }

    const { intervalMs } = req.body || {};
    const gap = Math.min(Math.max(Number(intervalMs ?? 3000), 0), 30_000);

    const existing = new Set(
      sessions.list()
        .filter((s) => s.kind === 'worker' && s.alive && s.workerIndex != null)
        .map((s) => s.workerIndex),
    );

    const spawned = [];
    const skipped = [];
    const failed = [];

    for (let i = 0; i < workersCount; i++) {
      if (existing.has(i)) {
        skipped.push({ workerIndex: i, reason: 'already-running' });
        continue;
      }
      const r = await spawnWorkerSession({ workerIndex: i, ip: req.ip });
      if (r.ok) {
        spawned.push({ workerIndex: i, sessionId: r.session.id });
      } else {
        failed.push({
          workerIndex: i,
          code: r.error?.code ?? 500,
          ...(r.error?.body || {}),
        });
      }
      if (gap > 0 && i < workersCount - 1) {
        await delay(gap);
      }
    }

    // Restart the watchdog after spawning workers. cleanup-zombies leaves
    // it stopped (it has to, or our kills get undone within a cycle), so
    // boot-all is the one place that re-arms monitoring without requiring
    // a server restart. startWatchdog is a no-op if already running.
    const watchdogResult = await startWatchdog(app.log);

    audit.log({
      event: 'system.boot-all',
      ip: req.ip,
      spawnedCount: spawned.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      gapMs: gap,
      watchdog: watchdogResult,
    });

    return { spawned, skipped, failed, intervalMs: gap, watchdog: watchdogResult };
  });

  app.get('/api/system/watchdog-status', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const [tail, health, hydraLive] = await Promise.all([
      tailWatchdogLog(50),
      getWatchdogHealth(),
      hydraLiveHealth().catch(() => null),
    ]);
    return {
      watchdog: { ...getWatchdogState(), health },
      hydra: {
        live: hydraLive,
        cached: hydraStatus(),
      },
      logTail: tail,
    };
  });
}
