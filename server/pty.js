import { spawn } from 'node-pty';
import { platform } from 'node:process';

const IS_WIN = platform === 'win32';

function escapePercent(s) {
  return String(s).replace(/%/g, '%%');
}

function quoteCmdArg(s) {
  const v = String(s);
  if (v === '') return '""';
  if (!/[\s"&|<>^()%]/.test(v)) return v;
  const escaped = v.replace(/(\\*)("|$)/g, (_, slashes, quote) => {
    if (quote === '"') return `${slashes}${slashes}\\"`;
    return `${slashes}${slashes}`;
  });
  return `"${escaped}"`;
}

function buildCmdLine({ claudeCmd, claudeArgs }) {
  const cmdQuoted = /[\s"&|<>^]/.test(claudeCmd) ? `"${claudeCmd.replace(/"/g, '""')}"` : claudeCmd;
  const argsStr = (claudeArgs || '').trim();
  const line = `chcp 65001 >NUL & ${cmdQuoted}${argsStr ? ' ' + argsStr : ''}`;
  return escapePercent(line);
}

export function spawnPty({ command, cwd, cols, rows, extraEnv = {}, claudeArgs }) {
  let file, args;
  if (IS_WIN) {
    file = process.env.ComSpec || 'cmd.exe';
    const line = buildCmdLine({ claudeCmd: command, claudeArgs });
    args = ['/d', '/s', '/c', line];
  } else {
    file = '/bin/bash';
    args = ['-lc', `${command} ${claudeArgs || ''}`.trim()];
  }
  const env = {
    ...process.env,
    TERM: process.env.TERM || 'xterm-256color',
    PYTHONUTF8: process.env.PYTHONUTF8 || '1',
    ...extraEnv,
  };
  const pty = spawn(file, args, {
    name: env.TERM,
    cwd,
    env,
    cols,
    rows,
    useConpty: IS_WIN ? true : undefined,
  });

  let alive = true;
  const exitWaiters = new Set();
  pty.onExit(() => {
    alive = false;
    for (const r of exitWaiters) {
      try { r('exit'); } catch {}
    }
    exitWaiters.clear();
  });

  // Resolve when the PTY process actually exits (or timeoutMs elapses).
  // Returns 'already-dead' | 'exit' | 'timeout'. Used by Session.kill so that
  // rm -rf on the PTY cwd can wait for Windows to release file handles before
  // running (EBUSY race on ConPTY teardown).
  function whenExited(timeoutMs = 5000) {
    if (!alive) return Promise.resolve('already-dead');
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        exitWaiters.delete(resolve);
        resolve('timeout');
      }, timeoutMs);
      const wrap = (kind) => {
        clearTimeout(t);
        resolve(kind);
      };
      exitWaiters.add(wrap);
    });
  }

  return {
    onData(cb) { pty.onData(cb); },
    onExit(cb) { pty.onExit(cb); },
    write(d) { if (alive) pty.write(d); },
    resize(c, r) { if (alive) try { pty.resize(c, r); } catch {} },
    kill() {
      if (!alive) return;
      try { pty.kill(); } catch {}
    },
    whenExited,
    get alive() { return alive; },
    pid: pty.pid,
    _quoteCmdArg: quoteCmdArg,
  };
}
