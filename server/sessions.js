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
    // Multi-client dim tracking. Map<WebSocket, {cols, rows} | null>.
    // PTY can only have ONE buffer dimension at a time. With multiple clients
    // (e.g. PC + phone viewing the same session), we'd previously last-write-
    // wins on resize msgs → PTY flips dims constantly → both clients render
    // corrupted because their internal xterm coord systems can't keep up.
    // Strategy: PTY size = min(cols), min(rows) across all clients with
    // reported dims. The smallest client constrains output width; larger
    // clients see content in a sub-portion of their xterm (empty space on
    // the right). No corruption. Same model tmux uses when multiple terminals
    // attach to one window.
    // ws → null = client connected but hasn't reported dims yet (don't
    //              constrain min until it does).
    // ws → {cols, rows} = client's last reported viewport size.
    this.clients = new Map();
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
      engine: this.meta.engine || null,
      apiPort: this.meta.apiPort ?? null,
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
    for (const ws of this.clients.keys()) {
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
    for (const ws of this.clients.keys()) {
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
    // Add with null dims; client will send a resize msg shortly via fit().
    // Until then this client doesn't constrain the min-size calculation.
    this.clients.set(ws, null);
  }

  detach(ws) {
    // Guard: ws may be unknown (double close/error event from same socket).
    // Without has() check, get(ws) === undefined, and `undefined !== null` is
    // true → hadDims = true → spurious _recomputeSize call.
    const hadDims = this.clients.has(ws) && this.clients.get(ws) !== null;
    this.clients.delete(ws);
    // If the leaving client had reported dims, the constraint set shrunk —
    // recompute since the new min might be larger (other clients can use
    // more of their available xterm space).
    if (hadDims) this._recomputeSize();
    if (!this.alive && this.clients.size === 0 && this._onIdle) {
      try { this._onIdle(this); } catch {}
    }
  }

  write(data) {
    if (!this.alive) return;
    try { this.pty.write(data); } catch {}
  }

  // Per-client dim update. Called from the WS resize message handler.
  // Records this client's preferred viewport size, then recomputes the
  // effective PTY size as min across all clients with reported dims.
  updateClientDims(ws, cols, rows) {
    if (!this.clients.has(ws)) return;
    const prev = this.clients.get(ws);
    if (prev && prev.cols === cols && prev.rows === rows) return;
    this.clients.set(ws, { cols, rows });
    this._recomputeSize();
  }

  // Compute min(cols), min(rows) across all clients with reported dims,
  // and resize the PTY accordingly. No-op when no client has dims yet
  // (the initial PTY size from spawn stays in effect).
  _recomputeSize() {
    if (!this.alive) return;
    let minC = Infinity, minR = Infinity;
    for (const dims of this.clients.values()) {
      if (!dims) continue;
      if (dims.cols < minC) minC = dims.cols;
      if (dims.rows < minR) minR = dims.rows;
    }
    if (!isFinite(minC) || !isFinite(minR)) return;
    if (minC === this.cols && minR === this.rows) return;
    this.cols = minC;
    this.rows = minR;
    try { this.pty.resize(minC, minR); } catch {}
  }

  // Legacy direct-resize entry point. Retained so that any code path that
  // doesn't have a ws context (e.g. an internal admin tool) can still force
  // a PTY resize. The WS handler should use updateClientDims instead so
  // multi-client coexistence stays consistent.
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

  // Async kill: signals the PTY, waits for the real exit event (with timeout),
  // then closes attached WS clients. Awaiting onExit before any downstream
  // filesystem op prevents the EBUSY race where Windows still holds handles
  // on the PTY's cwd after pty.kill() returns.
  async kill(timeoutMs = 5000) {
    if (!this.alive) return;
    this.alive = false;
    try { this.pty.kill(); } catch {}
    try {
      if (typeof this.pty.whenExited === 'function') {
        await this.pty.whenExited(timeoutMs);
      }
    } catch {}
    for (const ws of this.clients.keys()) {
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

  setLabel(id, name) {
    const s = this.#map.get(id);
    if (!s || !s.alive) return null;
    s.label = name;
    return s.summary();
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

  // Returns a Promise<boolean>. Removes the session from the map first so
  // concurrent lookups don't see it, then awaits Session.kill which waits
  // for the PTY's onExit event before resolving.
  async kill(id, timeoutMs = 5000) {
    const s = this.#map.get(id);
    if (!s) return false;
    this.#map.delete(id);
    await s.kill(timeoutMs);
    return true;
  }

  // Best-effort fire-and-forget for shutdown paths. Does not await onExit
  // because the process is about to exit anyway.
  killAll() {
    for (const s of this.#map.values()) {
      try {
        s.alive = false;
        s.pty.kill();
      } catch {}
    }
    this.#map.clear();
  }

  // Used by /api/system/cleanup-zombies to build the protection set: the
  // top PID of each live PTY (cmd.exe) — node-pty exposes it as pty.pid.
  // Descendants (claude.exe, plugin node.exe) are added by walking ppid.
  getPtyPid(id) {
    const s = this.#map.get(id);
    if (!s || !s.alive) return null;
    try { return s.pty?.pid ?? null; } catch { return null; }
  }
}

export const sessions = new SessionStore();
