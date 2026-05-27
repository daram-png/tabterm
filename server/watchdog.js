import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';

// Env-derived values are read lazily inside startWatchdog (and via the
// helpers below) because this module is imported BEFORE index.js calls
// dotenv.config(). Capturing them at module-evaluation time would freeze
// them at the pre-dotenv default and silently ignore .env overrides like
// WATCHDOG_AUTOSTART=false. That bug spawned a watchdog that pops visible
// cmd.exe windows for every revived subagent.
const HEALTHY_MAX_AGE_MS = 90_000;
const DEGRADED_MAX_AGE_MS = 600_000;
const TAIL_MAX_LINES = 500;

function envAutostart() {
  return String(process.env.WATCHDOG_AUTOSTART ?? 'true') === 'true';
}
function envScriptPath() {
  return process.env.WATCHDOG_PATH || 'C:/workspace/watchdog/watchdog.js';
}
function envConfigPath() {
  return process.env.WATCHDOG_CONFIG || 'C:/workspace/watchdog/config-ccx-full.json';
}
function envLogPath() {
  return process.env.WATCHDOG_LOG || 'C:/workspace/watchdog/watchdog.log';
}

let wdProc = null;
let wdStartedAt = 0;
let wdLastExitCode = null;
let wdLastError = null;

export async function startWatchdog(log) {
  const AUTOSTART = envAutostart();
  const SCRIPT_PATH = envScriptPath();
  const CONFIG_PATH = envConfigPath();
  const LOG_PATH = envLogPath();
  if (!AUTOSTART) {
    log.info('[watchdog] WATCHDOG_AUTOSTART=false — skipping spawn');
    return { spawned: false, reason: 'autostart-disabled' };
  }
  if (!existsSync(SCRIPT_PATH)) {
    log.warn({ path: SCRIPT_PATH }, '[watchdog] script missing — skipping');
    return { spawned: false, reason: 'script-missing' };
  }
  if (!existsSync(CONFIG_PATH)) {
    log.warn({ path: CONFIG_PATH }, '[watchdog] config missing — skipping');
    return { spawned: false, reason: 'config-missing' };
  }
  if (wdProc) {
    return { spawned: false, reason: 'already-spawned', pid: wdProc.pid };
  }

  // Log-only advisory: if watchdog.log mtime is fresh, another watchdog may
  // still be running. We do NOT block spawn on this (the 90s mtime window
  // would otherwise create a blind period after a crashed watchdog where
  // we silently refuse to restart). The PID guard above is the authoritative
  // duplicate-prevention. The two-watchdog overlap is brief and self-healing
  // (the older one notices its PID file/log changed and exits).
  if (existsSync(LOG_PATH)) {
    try {
      const s = await stat(LOG_PATH);
      const age = Date.now() - s.mtimeMs;
      if (age < HEALTHY_MAX_AGE_MS) {
        log.info({ ageMs: age }, '[watchdog] existing log mtime is fresh — another watchdog may be active');
      }
    } catch { /* stat failure is non-fatal advisory */ }
  }

  try {
    const proc = spawn('node', [SCRIPT_PATH, '--config', CONFIG_PATH], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    wdProc = proc;
    wdStartedAt = Date.now();
    wdLastError = null;
    log.info({ pid: proc.pid }, '[watchdog] spawned');

    proc.on('exit', (code, signal) => {
      log.warn({ code, signal, pid: proc.pid }, '[watchdog] child exited');
      wdLastExitCode = code;
      if (wdProc === proc) wdProc = null;
    });
    proc.on('error', (err) => {
      log.error({ err: err.message }, '[watchdog] runtime error');
      wdLastError = String(err.message || err);
      if (wdProc === proc) wdProc = null;
    });
    return { spawned: true, pid: proc.pid };
  } catch (e) {
    wdLastError = String(e?.message || e);
    log.error({ err: wdLastError }, '[watchdog] spawn failed');
    return { spawned: false, reason: 'spawn-error', error: wdLastError };
  }
}

export function stopWatchdog(log) {
  const proc = wdProc;
  if (!proc) return false;
  try {
    log.info({ pid: proc.pid }, '[watchdog] stopping child');
    proc.kill('SIGTERM');
    // Do NOT null wdProc here — let the 'exit' handler do it so
    // wdLastExitCode reflects the actual termination, not a stale state.
  } catch (e) {
    log.warn({ err: e?.message }, '[watchdog] kill failed — assuming already exited');
    wdProc = null;
  }
  return true;
}

export function getWatchdogPid() {
  return wdProc?.pid ?? null;
}

export function getWatchdogState() {
  return {
    pid: wdProc?.pid ?? null,
    startedAt: wdStartedAt || null,
    lastExitCode: wdLastExitCode,
    lastError: wdLastError,
    scriptPath: SCRIPT_PATH,
    configPath: CONFIG_PATH,
    logPath: LOG_PATH,
    autostart: AUTOSTART,
  };
}

export async function getWatchdogHealth() {
  try {
    if (!existsSync(LOG_PATH)) return { status: 'dead', reason: 'log-missing', mtimeMs: null, ageMs: null };
    const s = await stat(LOG_PATH);
    const age = Date.now() - s.mtimeMs;
    let status = 'healthy';
    if (age > DEGRADED_MAX_AGE_MS) status = 'dead';
    else if (age > HEALTHY_MAX_AGE_MS) status = 'degraded';
    return { status, mtimeMs: s.mtimeMs, ageMs: age };
  } catch (e) {
    return { status: 'dead', reason: 'stat-failed', error: String(e?.message || e) };
  }
}

export async function tailWatchdogLog(requested = 50) {
  const lines = Math.max(1, Math.min(TAIL_MAX_LINES, Number(requested) || 50));
  if (!existsSync(LOG_PATH)) return [];
  try {
    const buf = await readFile(LOG_PATH, 'utf8');
    const all = buf.split(/\r?\n/);
    while (all.length && all[all.length - 1] === '') all.pop();
    return all.slice(-lines);
  } catch {
    return [];
  }
}
