// Multi-client PTY sizing: PTY follows the LARGEST attached client (max dims),
// and the authoritative size is broadcast so smaller clients can adopt + scale.
// Root cause this replaces: min-dims left larger clients rendering TUI output on
// a mismatched grid → unreadable layout skew when a 2nd (smaller) device joined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtySession } from './sessions.js';

function fakePty() {
  return { resized: [], resize(c, r) { this.resized.push([c, r]); }, write() {}, kill() {} };
}
function fakeWs() {
  return { readyState: 1, sent: [], send(m) { this.sent.push(m); } };
}
function sizeMsgs(ws) {
  return ws.sent
    .filter((m) => typeof m === 'string')
    .map((m) => { try { return JSON.parse(m); } catch { return {}; } })
    .filter((o) => o.type === 'size');
}
function newSession(pty) {
  return new PtySession({ id: '1', label: 'x', cwd: '.', command: 'c', cols: 80, rows: 24, pty, meta: {} });
}

test('sizing: PTY adopts MAX cols/rows across clients (not min)', () => {
  const pty = fakePty();
  const s = newSession(pty);
  const a = fakeWs(); const b = fakeWs();
  s.attach(a); s.attach(b);
  s.updateClientDims(a, 200, 50);
  s.updateClientDims(b, 45, 20);
  assert.equal(s.cols, 200);
  assert.equal(s.rows, 50);
});

test('sizing: authoritative size is broadcast to clients on change', () => {
  const pty = fakePty();
  const s = newSession(pty);
  const a = fakeWs(); s.attach(a);
  s.updateClientDims(a, 120, 30);
  const msgs = sizeMsgs(a);
  assert.ok(msgs.length >= 1, 'a size message was broadcast');
  const last = msgs[msgs.length - 1];
  assert.equal(last.cols, 120);
  assert.equal(last.rows, 30);
});

test('sizing: a newly attached client receives the current size immediately', () => {
  const pty = fakePty();
  const s = newSession(pty);
  const a = fakeWs(); s.attach(a); s.updateClientDims(a, 150, 40);
  const b = fakeWs(); s.attach(b);
  const msgs = sizeMsgs(b);
  assert.ok(msgs.length >= 1, 'new client gets a size message on attach');
  assert.equal(msgs[0].cols, 150);
  assert.equal(msgs[0].rows, 40);
});

test('sizing: detaching the largest client shrinks PTY to the next-largest', () => {
  const pty = fakePty();
  const s = newSession(pty);
  const a = fakeWs(); const b = fakeWs();
  s.attach(a); s.attach(b);
  s.updateClientDims(a, 200, 50);
  s.updateClientDims(b, 100, 30);
  assert.equal(s.cols, 200);
  s.detach(a);
  assert.equal(s.cols, 100, 'PTY = next max after largest leaves');
  assert.equal(s.rows, 30);
});

test('sizing: clients with no reported dims do not constrain the size', () => {
  const pty = fakePty();
  const s = newSession(pty);
  const a = fakeWs(); const b = fakeWs();
  s.attach(a); s.attach(b); // b never reports dims (null)
  s.updateClientDims(a, 110, 28);
  assert.equal(s.cols, 110);
  assert.equal(s.rows, 28);
});
