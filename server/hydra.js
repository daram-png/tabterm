import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const HEALTH_URL = process.env.HYDRATEAMS_HEALTH_URL || 'http://127.0.0.1:3456/health';
const LAUNCHER = process.env.HYDRATEAMS_LAUNCHER || 'C:/Tools/HydraTeams/hydra-launcher.sh';
const BASH = process.env.HYDRATEAMS_BASH || 'C:/Program Files/Git/bin/bash.exe';
const TIMEOUT_MS = Number(process.env.HYDRATEAMS_HEALTH_TIMEOUT_MS || 2000);
const POLL_MS = Number(process.env.HYDRATEAMS_POLL_MS || 1000);
const POLL_MAX = Number(process.env.HYDRATEAMS_POLL_MAX || 10);

async function healthy() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(HEALTH_URL, { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function runLauncher() {
  return new Promise((resolve) => {
    const child = spawn(BASH, [LAUNCHER, 'start'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, log: String(e) }));
    child.on('exit', (code) => resolve({ ok: code === 0, code, log: out }));
  });
}

let inflight = null;
let lastStatus = { ready: false, lastCheck: 0, log: '' };

export async function ensureHydraReady({ force = false } = {}) {
  if (!force && lastStatus.ready && Date.now() - lastStatus.lastCheck < 5000) {
    return lastStatus;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    if (await healthy()) {
      lastStatus = { ready: true, lastCheck: Date.now(), log: 'already-healthy' };
      return lastStatus;
    }
    const r = await runLauncher();
    for (let i = 0; i < POLL_MAX; i++) {
      await delay(POLL_MS);
      if (await healthy()) {
        lastStatus = { ready: true, lastCheck: Date.now(), log: r.log };
        return lastStatus;
      }
    }
    lastStatus = { ready: false, lastCheck: Date.now(), log: r.log };
    return lastStatus;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function hydraStatus() {
  return { ...lastStatus };
}
