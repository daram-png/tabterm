import { randomBytes } from 'node:crypto';
import { spawnPty } from './pty.js';

const RING_BYTES = Number(process.env.RING_BUFFER_BYTES || 2 * 1024 * 1024);
const TRIM_SLACK = 4096;

class PtySession {
  constructor({ id, label, cwd, command, cols, rows, pty, meta }) {
    this.id = id;
    this.label = label;
    this.cwd = cwd;
    this.command = command;
    this.cols = cols;
    this.rows = rows;
    this.pty = pty;
    this.alive = true;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.exitCode = null;
    this.ring = Buffer.alloc(0);
    this.ringLimit = RING_BYTES;
    this.clients = new Set();
    this._pendingDelete = null;
    this.meta = meta || {};
  }

  summary() {
    return {
      id: this.id,
      label: this.label,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      alive: this.alive,
      exitCode: this.exitCode,
      createdAt: this.createdAt,
      clients: this.clients.size,
      kind: this.meta.kind || 'worker',
      workerIndex: this.meta.workerIndex ?? null,
    };
  }

  _appendRing(buf) {
    if (this.ring.length + buf.length <= this.ringLimit) {
      this.ring = this.ring.length ? Buffer.concat([this.ring, buf]) : Buffer.from(buf);
      return;
    }
    const combined = Buffer.concat([this.ring, buf]);
    const overflow = combined.length - this.ringLimit;
    let cut = overflow;
    const searchEnd = Math.min(combined.length, overflow + TRIM_SLACK);
    for (let i = overflow; i < searchEnd; i++) {
      if (combined[i] === 0x0a) { cut = i + 1; break; }
    }
    this.ring = combined.subarray(cut);
  }

  onPtyData(data) {
    this.lastActivity = Date.now();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this._appendRing(buf);
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        try { ws.send(buf, { binary: true }); } catch {}
      }
    }
  }

  onPtyExit(code) {
    this.alive = false;
    this.exitCode = code ?? null;
    this.lastActivity = Date.now();
    const msg = JSON.stringify({ type: 'exit', code: this.exitCode });
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch {}
      }
    }
  }

  attach(ws) {
    if (this.ring.length) {
      try { ws.send(this.ring, { binary: true }); } catch {}
    }
    if (!this.alive) {
      try { ws.send(JSON.stringify({ type: 'exit', code: this.exitCode })); } catch {}
    }
    this.clients.add(ws);
  }

  detach(ws) {
    this.clients.delete(ws);
    if (!this.alive && this.clients.size === 0 && this._onIdle) {
      try { this._onIdle(this); } catch {}
    }
  }

  write(data) {
    if (!this.alive) return;
    try { this.pty.write(data); } catch {}
  }

  resize(cols, rows) {
    if (!this.alive) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    try { this.pty.resize(cols, rows); } catch {}
  }

  softStop() {
    if (!this.alive) return;
    try { this.pty.write('\x03'); } catch {}
  }

  kill() {
    this.alive = false;
    try { this.pty.kill(); } catch {}
    for (const ws of this.clients) {
      try { ws.close(1000, 'session-killed'); } catch {}
    }
  }
}

class SessionStore {
  #map = new Map();

  list() {
    return [...this.#map.values()].map((s) => s.summary());
  }

  get(id) {
    return this.#map.get(id);
  }

  create({ label, cwd, command, cols, rows, onExit, extraEnv, claudeArgs, meta }) {
    const id = randomBytes(8).toString('hex');
    const pty = spawnPty({ command, cwd, cols, rows, extraEnv, claudeArgs });
    const s = new PtySession({ id, label, cwd, command, cols, rows, pty, meta });
    s._onIdle = (sess) => {
      if (this.#map.get(id) === sess) this.#map.delete(id);
    };
    pty.onData((d) => s.onPtyData(d));
    pty.onExit(({ exitCode }) => {
      s.onPtyExit(exitCode);
      if (typeof onExit === 'function') {
        try { onExit({ id, exitCode }); } catch {}
      }
      setTimeout(() => {
        if (this.#map.get(id) === s && s.clients.size === 0) this.#map.delete(id);
      }, 60_000);
    });
    this.#map.set(id, s);
    return s;
  }

  kill(id) {
    const s = this.#map.get(id);
    if (!s) return false;
    s.kill();
    this.#map.delete(id);
    return true;
  }

  killAll() {
    for (const s of this.#map.values()) {
      try { s.kill(); } catch {}
    }
    this.#map.clear();
  }
}

export const sessions = new SessionStore();
