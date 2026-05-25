import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const WORKER_ENV_KEYS = new Set(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_STATE_DIR']);

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function parseBatSetLines(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = line.match(/^set\s+"([A-Z][A-Z0-9_]*)=(.*)"$/i);
    if (!m) m = line.match(/^set\s+([A-Z][A-Z0-9_]*)=(.*)$/i);
    if (!m) continue;
    const key = m[1].toUpperCase();
    if (!WORKER_ENV_KEYS.has(key)) continue;
    let val = m[2].trim();
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

async function tryRead(path) {
  try {
    await access(path);
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function loadWorkerEnv(workerDir) {
  const ccxPath = resolve(workerDir, '.ccx-env');
  const batPath = resolve(workerDir, 'start-ccx.bat');
  const ccx = await tryRead(ccxPath);
  if (ccx) {
    const parsed = parseEnvFile(ccx);
    const filtered = {};
    for (const k of WORKER_ENV_KEYS) if (parsed[k]) filtered[k] = parsed[k];
    return { env: filtered, source: '.ccx-env', warnings: [] };
  }
  const bat = await tryRead(batPath);
  if (bat) {
    const parsed = parseBatSetLines(bat);
    const warnings = [];
    for (const k of WORKER_ENV_KEYS) {
      if (!parsed[k]) warnings.push(`${k} missing in start-ccx.bat`);
    }
    return { env: parsed, source: 'start-ccx.bat', warnings };
  }
  return { env: {}, source: 'none', warnings: ['no .ccx-env or start-ccx.bat'] };
}

export function buildClaudeInvocation() {
  const cmd = process.env.CLAUDE_COMMAND || 'claude';
  const argsStr = process.env.CLAUDE_ARGS || '';
  return { cmd, argsStr };
}

export function buildEngineInvocation(engine) {
  if (engine === 'opencode') {
    return {
      cmd: process.env.OPENCODE_COMMAND || 'opencode',
      argsStr: process.env.OPENCODE_ARGS || '',
      sessionArgsStr: process.env.SESSION_OPENCODE_ARGS || '',
      anthropicBaseUrl: process.env.OPENCODE_ANTHROPIC_BASE_URL || 'http://127.0.0.1:18802',
    };
  }
  return {
    cmd: process.env.CLAUDE_COMMAND || 'claude',
    argsStr: process.env.CLAUDE_ARGS || '',
    sessionArgsStr: process.env.SESSION_CLAUDE_ARGS || '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'http://localhost:3456',
  };
}
