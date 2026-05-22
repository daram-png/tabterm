import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:process';

const IS_WIN = platform === 'win32';

function killPidTree(pid) {
  return new Promise((resolve) => {
    if (!pid || pid < 2) return resolve(false);
    if (IS_WIN) {
      const p = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
      p.on('exit', (code) => resolve(code === 0));
      p.on('error', () => resolve(false));
    } else {
      try { process.kill(pid, 'SIGKILL'); resolve(true); }
      catch { resolve(false); }
    }
  });
}

function isAlive(pid) {
  if (!pid || pid < 2) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

// Read STATE_DIR/bot.pid and force-kill the bot process tree if alive.
// Returns { killed, pid, reason } for audit logging. Never throws.
export async function killStaleBot(stateDir) {
  if (!stateDir) return { killed: false, reason: 'no-state-dir' };
  const pidFile = join(stateDir, 'bot.pid');
  if (!existsSync(pidFile)) return { killed: false, reason: 'no-pid-file' };
  let pid;
  try { pid = parseInt(readFileSync(pidFile, 'utf8'), 10); }
  catch { return { killed: false, reason: 'pid-read-fail' }; }
  if (!Number.isInteger(pid) || pid < 2) {
    return { killed: false, reason: 'invalid-pid' };
  }
  if (!isAlive(pid)) return { killed: false, reason: 'already-dead', pid };
  const ok = await killPidTree(pid);
  return { killed: ok, pid };
}
