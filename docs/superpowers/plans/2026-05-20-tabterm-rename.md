# tabterm worker/session rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tabterm 사이드바의 워커/세션 행에 연필 아이콘 + 인라인 rename UI 를 추가하고, 워커 라벨은 `data/labels.json` 에 영속, 세션 라벨은 in-memory 로 PTY 수명만큼 유지한다.

**Architecture:** Backend 는 신규 `server/labels.js` 모듈이 atomic write + `.bak` 복구 + write-queue 직렬화를 담당. 세 개의 REST 라우트(`GET /api/labels`, `PUT /api/labels/worker/:idx`, `PUT /api/sessions/:id/label`) 를 `server/index.js` 에 추가, `/api/preflight` 응답을 확장해 초기 라벨을 한 번에 전달. Frontend (`public/app.js`) 는 `state.workerLabels` 와 `state.editing` 으로 상태 관리, `displayName(p)` 헬퍼로 사이드바/슬롯 스트립/타이틀의 표시 로직 통일, 연필 클릭 시 인라인 `<input>` 으로 swap. iOS IME focus redirect 와 외부 renderSidebar 호출에 의한 input 파괴를 명시적으로 가드.

**Tech Stack:** Node 22+ (built-in `node:test` 사용), Fastify 5, node-pty, xterm.js, vanilla JS (no framework), CSS.

**Spec:** [`../specs/2026-05-20-tabterm-rename-design.md`](../specs/2026-05-20-tabterm-rename-design.md) (v2, Codex peer-reviewed)

**User mandate:** 본 plan 의 코드 변경 완료 후, 머지 전 Codex peer review 1회 필수 (Task 10).

---

## File Structure

**Create**
- `C:/Tools/tabterm/server/labels.js` — 라벨 store: validate + load + save + recovery + write queue
- `C:/Tools/tabterm/server/labels.test.js` — `node:test` 단위 테스트 (validateLabel + load/save 라운드트립)
- `C:/Tools/tabterm/data/labels.json` (런타임 자동 생성, gitignore 대상이므로 추가만 명시)

**Modify**
- `C:/Tools/tabterm/server/sessions.js` — `SessionStore.setLabel(id, name)` 메서드 추가
- `C:/Tools/tabterm/server/index.js` — 라우트 3개 추가, `/api/preflight` 응답 확장, 부팅 시 `labels.loadLabels()` 호출
- `C:/Tools/tabterm/public/app.js` — state.workerLabels / state.editing, displayName, renderWorkerRow/renderRow 변경, startRename/commitRename/cancelRename, renderSidebar 의 editing 보존, focusActivePane 의 iOS IME 가드
- `C:/Tools/tabterm/public/styles.css` — `.ws-rename-btn`, `.ws-rename-input`, `.ws-rename-counter`
- `C:/Tools/tabterm/CHANGELOG.md` — Unreleased 섹션 갱신
- `C:/Tools/tabterm/.gitignore` — `data/labels.json`, `data/labels.json.bak`, `data/labels.json.corrupted-*` 추가 (이미 `data/auth.json` 패턴이 있는지 확인)

---

## Task 1: Backend — `server/labels.js` validateLabel (TDD)

**Files:**
- Create: `C:/Tools/tabterm/server/labels.js`
- Create: `C:/Tools/tabterm/server/labels.test.js`

- [ ] **Step 1: Write the failing test**

Write to `C:/Tools/tabterm/server/labels.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLabel } from './labels.js';

test('validateLabel: non-string -> type', () => {
  for (const v of [null, undefined, 123, {}, [], true]) {
    const r = validateLabel(v);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'type');
  }
});

test('validateLabel: empty string after trim -> ok, cleared', () => {
  for (const v of ['', '   ', '\t\n  ']) {
    const r = validateLabel(v);
    assert.equal(r.ok, true);
    assert.equal(r.value, '');
  }
});

test('validateLabel: too long (33 UTF-16 code units) -> too_long', () => {
  const v = 'a'.repeat(33);
  const r = validateLabel(v);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'too_long');
});

test('validateLabel: exactly 32 code units -> ok', () => {
  const v = 'a'.repeat(32);
  const r = validateLabel(v);
  assert.equal(r.ok, true);
  assert.equal(r.value, v);
});

test('validateLabel: control chars -> control_char', () => {
  for (const c of ['\x00', '\x1f', '\x7f', 'good\x01here']) {
    const r = validateLabel(c);
    assert.equal(r.ok, false, `expected fail for char ${JSON.stringify(c)}`);
    assert.equal(r.error, 'control_char');
  }
});

test('validateLabel: trims surrounding whitespace', () => {
  const r = validateLabel('  pixiechess  ');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'pixiechess');
});

test('validateLabel: emoji allowed', () => {
  const r = validateLabel('🚀 pixie');
  assert.equal(r.ok, true);
  assert.equal(r.value, '🚀 pixie');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Tools/tabterm && node --test server/labels.test.js`
Expected: FAIL — `Cannot find package` or `validateLabel is not a function` (labels.js 미존재).

- [ ] **Step 3: Write minimal implementation**

Write to `C:/Tools/tabterm/server/labels.js`:

```js
// labels.js — worker/session 라벨 검증 + 워커 라벨 영속 저장
// 세션 라벨은 sessions.js 의 PtySession.label in-memory mutate (이 모듈 책임 아님).

const CONTROL_RE = /[\x00-\x1f\x7f]/;

export function validateLabel(input) {
  if (typeof input !== 'string') return { ok: false, error: 'type' };
  const value = input.trim();
  if (value === '') return { ok: true, value: '' };
  if (value.length > 32) return { ok: false, error: 'too_long' };
  if (CONTROL_RE.test(value)) return { ok: false, error: 'control_char' };
  return { ok: true, value };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/Tools/tabterm && node --test server/labels.test.js`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd C:/Tools/tabterm
git add server/labels.js server/labels.test.js
git commit -m "feat(labels): add validateLabel with node:test unit tests"
```

---

## Task 2: Backend — `server/labels.js` load + atomic save + write queue + recovery

**Files:**
- Modify: `C:/Tools/tabterm/server/labels.js`
- Modify: `C:/Tools/tabterm/server/labels.test.js`

- [ ] **Step 1: Write the failing integration test**

Append to `C:/Tools/tabterm/server/labels.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLabelsStore } from './labels.js';

function tmpDataDir() {
  return mkdtempSync(join(tmpdir(), 'tabterm-labels-'));
}

test('labels: fresh dir → empty workers, health ok', async () => {
  const dir = tmpDataDir();
  try {
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    assert.deepEqual(s.getWorkers(), {});
    assert.equal(s.labelsHealth, 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('labels: set + persist + reload', async () => {
  const dir = tmpDataDir();
  try {
    const s1 = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    await s1.setWorkerLabel(0, 'pixiechess');
    await s1.setWorkerLabel(3, 'upbit-bot');
    assert.deepEqual(s1.getWorkers(), { '0': 'pixiechess', '3': 'upbit-bot' });

    const raw = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.workers, { '0': 'pixiechess', '3': 'upbit-bot' });

    const s2 = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    assert.deepEqual(s2.getWorkers(), { '0': 'pixiechess', '3': 'upbit-bot' });
    assert.equal(s2.labelsHealth, 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('labels: empty string clears the key', async () => {
  const dir = tmpDataDir();
  try {
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    await s.setWorkerLabel(0, 'pixiechess');
    await s.setWorkerLabel(0, '');
    assert.deepEqual(s.getWorkers(), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('labels: corrupted main → restored from bak', async () => {
  const dir = tmpDataDir();
  try {
    const good = JSON.stringify({ version: 1, workers: { '2': 'kept' } });
    writeFileSync(join(dir, 'labels.json.bak'), good);
    writeFileSync(join(dir, 'labels.json'), '{not json');
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    assert.deepEqual(s.getWorkers(), { '2': 'kept' });
    assert.equal(s.labelsHealth, 'restored_from_bak');
    const restored = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
    assert.deepEqual(restored.workers, { '2': 'kept' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('labels: both corrupted → empty + corrupted file preserved', async () => {
  const dir = tmpDataDir();
  try {
    writeFileSync(join(dir, 'labels.json'), '{not json');
    writeFileSync(join(dir, 'labels.json.bak'), 'also broken');
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    assert.deepEqual(s.getWorkers(), {});
    assert.equal(s.labelsHealth, 'corrupted_reset');
    const files = require('node:fs').readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith('labels.json.corrupted-')), `expected corrupted-* file, got ${files.join(',')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('labels: keys outside [0..workersCount) are silently dropped on load', async () => {
  const dir = tmpDataDir();
  try {
    const bad = JSON.stringify({ version: 1, workers: { '0': 'a', '999': 'too-big', 'foo': 'not-int', '__proto__': 'evil' } });
    writeFileSync(join(dir, 'labels.json'), bad);
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    assert.deepEqual(s.getWorkers(), { '0': 'a' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('labels: concurrent sets are serialized (no lost writes)', async () => {
  const dir = tmpDataDir();
  try {
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    await Promise.all([
      s.setWorkerLabel(0, 'a'),
      s.setWorkerLabel(1, 'b'),
      s.setWorkerLabel(2, 'c'),
      s.setWorkerLabel(3, 'd'),
    ]);
    const raw = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
    assert.deepEqual(raw.workers, { '0': 'a', '1': 'b', '2': 'c', '3': 'd' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

Note the `require('node:fs').readdirSync` is intentional for inline readdir without re-importing — `import.meta` 환경에서 module-top import 가 깔끔하지만 테스트 inline 편의상 OK.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Tools/tabterm && node --test server/labels.test.js`
Expected: FAIL — `createLabelsStore is not a function`.

- [ ] **Step 3: Implement `createLabelsStore`**

Replace `C:/Tools/tabterm/server/labels.js` with:

```js
// labels.js — worker/session 라벨 검증 + 워커 라벨 영속 저장
// 세션 라벨은 sessions.js 의 PtySession.label in-memory mutate (이 모듈 책임 아님).

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readFile, writeFile, rename, unlink, mkdir, stat,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const CONTROL_RE = /[\x00-\x1f\x7f]/;
const SCHEMA_VERSION = 1;

export function validateLabel(input) {
  if (typeof input !== 'string') return { ok: false, error: 'type' };
  const value = input.trim();
  if (value === '') return { ok: true, value: '' };
  if (value.length > 32) return { ok: false, error: 'too_long' };
  if (CONTROL_RE.test(value)) return { ok: false, error: 'control_char' };
  return { ok: true, value };
}

function intKey(k) {
  // accept '0'..'9' style decimal integer strings only
  return /^(0|[1-9]\d*)$/.test(k);
}

function sanitizeLoaded(raw, workersCount) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  const workers = raw.workers;
  if (!workers || typeof workers !== 'object') return out;
  for (const k of Object.keys(workers)) {
    if (!intKey(k)) continue;
    const idx = Number(k);
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= workersCount) continue;
    const v = workers[k];
    const r = validateLabel(v);
    if (r.ok && r.value !== '') out[String(idx)] = r.value;
  }
  return out;
}

async function safeReadJson(p) {
  try {
    const buf = await readFile(p, 'utf8');
    return JSON.parse(buf);
  } catch {
    return null;
  }
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

export async function createLabelsStore({ dataDir, workersCount, logger }) {
  const log = logger || { warn() {}, info() {}, error() {} };
  await mkdir(dataDir, { recursive: true });
  const mainPath = join(dataDir, 'labels.json');
  const bakPath = join(dataDir, 'labels.json.bak');

  let workers = Object.create(null);
  let labelsHealth = 'ok';

  // load priority: main → bak → corrupted_reset
  const mainRaw = await safeReadJson(mainPath);
  if (mainRaw) {
    workers = sanitizeLoaded(mainRaw, workersCount);
  } else if (await pathExists(mainPath)) {
    // file exists but unreadable / invalid JSON
    const bakRaw = await safeReadJson(bakPath);
    if (bakRaw) {
      workers = sanitizeLoaded(bakRaw, workersCount);
      labelsHealth = 'restored_from_bak';
      log.warn('[labels] main corrupt — restored from .bak');
      // rewrite main from bak
      await writeMainAtomic({ version: SCHEMA_VERSION, workers: plain(workers) });
    } else {
      // preserve corrupted main, start empty
      const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      const corruptedName = `labels.json.corrupted-${ts}`;
      try { await rename(mainPath, join(dataDir, corruptedName)); } catch {}
      labelsHealth = 'corrupted_reset';
      log.error('[labels] main + bak corrupt — started empty, preserved as', corruptedName);
    }
  }

  // serialized write queue
  let writing = Promise.resolve();

  function plain(obj) {
    // Object.create(null) → plain object for JSON.stringify safety
    const out = {};
    for (const k of Object.keys(obj)) out[k] = obj[k];
    return out;
  }

  async function writeMainAtomic(payload) {
    const tmp = join(dataDir, `labels.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    // rotate current main → bak (if main exists)
    if (await pathExists(mainPath)) {
      try { await rename(mainPath, bakPath); }
      catch (e) { log.warn('[labels] bak rotate failed:', e?.message); }
    }
    try {
      await rename(tmp, mainPath);
    } catch (e) {
      // one retry
      try { await unlink(tmp); } catch {}
      throw e;
    }
  }

  function getWorkers() {
    // defensive copy as plain object
    return plain(workers);
  }

  function getWorkerLabel(idx) {
    const v = workers[String(idx)];
    return typeof v === 'string' ? v : null;
  }

  async function setWorkerLabel(idx, name) {
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= workersCount) {
      throw new Error('bad_idx');
    }
    const r = validateLabel(name);
    if (!r.ok) {
      const e = new Error(r.error);
      e.code = r.error;
      throw e;
    }
    // serialize disk writes
    const job = writing.then(async () => {
      const next = Object.create(null);
      for (const k of Object.keys(workers)) next[k] = workers[k];
      if (r.value === '') delete next[String(idx)];
      else next[String(idx)] = r.value;
      // disk first, then cache (5-spec compliance: cache update only after success)
      await writeMainAtomic({ version: SCHEMA_VERSION, workers: plain(next) });
      workers = next;
      return r.value === '' ? null : r.value;
    });
    writing = job.catch(() => {}); // queue continues even if a job throws
    return job;
  }

  return {
    getWorkers,
    getWorkerLabel,
    setWorkerLabel,
    get labelsHealth() { return labelsHealth; },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:/Tools/tabterm && node --test server/labels.test.js`
Expected: all tests (Task 1 + Task 2, total ~14) pass.

- [ ] **Step 5: Commit**

```bash
cd C:/Tools/tabterm
git add server/labels.js server/labels.test.js
git commit -m "feat(labels): add createLabelsStore with atomic write + bak recovery + write queue"
```

---

## Task 3: Backend — `SessionStore.setLabel`

**Files:**
- Modify: `C:/Tools/tabterm/server/sessions.js`

- [ ] **Step 1: Add `setLabel` to `SessionStore`**

Open `C:/Tools/tabterm/server/sessions.js`. Find the `class SessionStore { #map = new Map(); ... }` block (around line 125). Inside the class, after the existing `get(id)` method, add:

```js
  setLabel(id, name) {
    const s = this.#map.get(id);
    if (!s || !s.alive) return null;
    s.label = name;
    return s.summary();
  }
```

- [ ] **Step 2: Manually verify by reading the file**

Run: `cd C:/Tools/tabterm && node -e "import('./server/sessions.js').then(m => console.log(typeof m.sessions.setLabel))"`
Expected output: `function`

- [ ] **Step 3: Commit**

```bash
cd C:/Tools/tabterm
git add server/sessions.js
git commit -m "feat(sessions): add setLabel for in-memory session label mutation"
```

---

## Task 4: Backend — API routes + preflight extension

**Files:**
- Modify: `C:/Tools/tabterm/server/index.js`

- [ ] **Step 1: Import labels store and initialize at startup**

Open `C:/Tools/tabterm/server/index.js`. After the existing imports block (around line 21, just after `import { registerSystemRoutes } from './system.js';`), add:

```js
import { createLabelsStore, validateLabel } from './labels.js';
```

Find the section near the bottom (after `await auth.load();`, around line 314):

```js
await auth.load();
const issues = preflight();
```

Insert immediately after `await auth.load();`:

```js
const labelsStore = await createLabelsStore({
  dataDir: resolve(ROOT, 'data'),
  workersCount: WORKERS_COUNT,
  logger: app.log,
});
audit.log({ event: 'labels.load', health: labelsStore.labelsHealth });
```

- [ ] **Step 2: Extend `/api/preflight` response**

Find the `app.get('/api/preflight', ...)` handler (around line 138). Inside the returned object, add two new keys after `hydra`:

```js
return {
  issues: preflight(),
  workersRoot: WORKERS_ROOT,
  workersCount: WORKERS_COUNT,
  workerPrefix: WORKER_PREFIX,
  claudeCommand: inv.cmd,
  claudeArgs: inv.argsStr,
  anthropicBaseUrl: ANTHROPIC_BASE_URL,
  hydra: { enabled: HYDRA_ENABLED, ...hydraStatus() },
  workerLabels: labelsStore.getWorkers(),
  labelsHealth: labelsStore.labelsHealth,
};
```

- [ ] **Step 3: Add `GET /api/labels`**

Insert this route after the existing `app.get('/api/sessions', ...)` (around line 162). Auth only, no CSRF:

```js
app.get('/api/labels', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return { version: 1, workers: labelsStore.getWorkers() };
});
```

- [ ] **Step 4: Add `PUT /api/labels/worker/:idx`**

Add right below the previous route:

```js
app.put('/api/labels/worker/:idx', {
  config: { bodyLimit: 1024 },
}, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const raw = req.params.idx;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return reply.code(400).send({ error: 'bad_idx' });
  const idx = Number(raw);
  if (!Number.isSafeInteger(idx) || idx < 0 || idx >= WORKERS_COUNT) {
    return reply.code(400).send({ error: 'bad_idx' });
  }
  const v = validateLabel(req.body?.name);
  if (!v.ok) return reply.code(422).send({ error: 'validation', field: 'name', reason: v.error });

  const current = labelsStore.getWorkerLabel(idx);
  // idempotent no-op
  if ((current ?? '') === v.value) {
    return {
      ok: true,
      workerIndex: idx,
      label: v.value === '' ? null : v.value,
      workers: labelsStore.getWorkers(),
    };
  }
  try {
    const stored = await labelsStore.setWorkerLabel(idx, v.value);
    audit.log({
      event: 'label.set.worker',
      workerIndex: idx,
      length: v.value.length,
      cleared: v.value === '',
      ip: req.ip,
    });
    return {
      ok: true,
      workerIndex: idx,
      label: stored,
      workers: labelsStore.getWorkers(),
    };
  } catch (e) {
    app.log.error({ err: e?.message, workerIndex: idx }, '[labels] persist failed');
    audit.log({ event: 'labels.persist.failed', workerIndex: idx, errno: e?.code || e?.message });
    return reply.code(500).send({ error: 'labels_persist_failed' });
  }
});
```

- [ ] **Step 5: Add `PUT /api/sessions/:id/label`**

Add right below:

```js
app.put('/api/sessions/:id/label', {
  config: { bodyLimit: 1024 },
}, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const v = validateLabel(req.body?.name);
  if (!v.ok) return reply.code(422).send({ error: 'validation', field: 'name', reason: v.error });
  const id = req.params.id;
  // Empty string clears → for sessions the "cleared" state means revert to whatever
  // the session already had. We treat empty value as no-op-to-current, since session
  // labels have no persistent default to fall back to.
  const summary = sessions.setLabel(id, v.value === '' ? null : v.value);
  if (!summary) return reply.code(404).send({ error: 'session_not_found' });
  audit.log({
    event: 'label.set.session',
    id,
    length: v.value.length,
    cleared: v.value === '',
    ip: req.ip,
  });
  return { ok: true, id, label: summary.label, session: summary };
});
```

Wait — but `sessions.setLabel(id, null)` would set `s.label = null` which breaks downstream (label is rendered as string). Let me think… spec says session labels are ephemeral, so "empty string" for session means: do not change the label (the session has no default to revert to once renamed). Simpler: reject empty string for session PUT, or treat empty as 422.

Actually the cleanest spec compliance: for sessions, empty string ALSO means clear → but session has no default name, so what's "cleared" for session? The original `session-{ts}-{rand}` label was just the create-time default. To support clearing, we'd need to store the original. Easier: for session, empty string is not allowed (422 with reason `empty_not_allowed`).

Replace the above route with the corrected logic:

```js
app.put('/api/sessions/:id/label', {
  config: { bodyLimit: 1024 },
}, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const v = validateLabel(req.body?.name);
  if (!v.ok) return reply.code(422).send({ error: 'validation', field: 'name', reason: v.error });
  if (v.value === '') return reply.code(422).send({ error: 'validation', field: 'name', reason: 'empty_not_allowed' });
  const id = req.params.id;
  const summary = sessions.setLabel(id, v.value);
  if (!summary) return reply.code(404).send({ error: 'session_not_found' });
  audit.log({
    event: 'label.set.session',
    id,
    length: v.value.length,
    cleared: false,
    ip: req.ip,
  });
  return { ok: true, id, label: summary.label, session: summary };
});
```

(The spec §6.3 says empty value = label 해제 — that applies to workers. For sessions, since no default exists in-memory, clearing is meaningless. This is a spec interpretation refinement that should be flagged in the next session report.)

- [ ] **Step 6: Boot smoke test (manual)**

Run: `cd C:/Tools/tabterm && npm start` (or `node server/index.js`)
Expected: `tabterm listening on http://127.0.0.1:3007` with no errors. Audit log shows `labels.load` event with `health: "ok"`.

Kill the server (Ctrl+C in the window running it, or close the terminal).

- [ ] **Step 7: Commit**

```bash
cd C:/Tools/tabterm
git add server/index.js
git commit -m "feat(api): add labels routes (GET, PUT worker, PUT session) + preflight extension"
```

---

## Task 5: Backend — manual API verification (curl)

**Files:** none modified — verification only.

- [ ] **Step 1: Start the server in a background window**

```bash
cd C:/Tools/tabterm
npm start
```

Expected: listening on 3007. Leave running.

- [ ] **Step 2: Log in and capture cookies**

From a separate shell (the password should be whatever was set via `npm run setup-pass`):

```bash
curl -s -c C:/Tools/tabterm/data/_cookies.txt -X POST http://127.0.0.1:3007/api/auth/login \
  -H "content-type: application/json" \
  -d '{"password":"<your-password>"}'
```

Expected: `{"ok":true}`. The cookie jar now has `tabterm.sid` and `tabterm.sid.csrf`.

Read the CSRF cookie value:

```bash
grep tabterm.sid.csrf C:/Tools/tabterm/data/_cookies.txt | awk '{print $7}'
```

Copy the value into env var `CSRF` for subsequent commands.

- [ ] **Step 3: GET /api/labels (expect empty)**

```bash
curl -s -b C:/Tools/tabterm/data/_cookies.txt http://127.0.0.1:3007/api/labels
```

Expected: `{"version":1,"workers":{}}`

- [ ] **Step 4: PUT a worker label**

```bash
curl -s -b C:/Tools/tabterm/data/_cookies.txt \
  -X PUT http://127.0.0.1:3007/api/labels/worker/0 \
  -H "content-type: application/json" \
  -H "x-tabterm-csrf: $CSRF" \
  -d '{"name":"pixiechess"}'
```

Expected: `{"ok":true,"workerIndex":0,"label":"pixiechess","workers":{"0":"pixiechess"}}`

- [ ] **Step 5: Negative cases**

```bash
# CSRF missing → 403
curl -s -o /dev/null -w "%{http_code}\n" -b C:/Tools/tabterm/data/_cookies.txt \
  -X PUT http://127.0.0.1:3007/api/labels/worker/0 \
  -H "content-type: application/json" \
  -d '{"name":"x"}'
# Expected: 403

# Bad idx (regex fail) → 400
curl -s -b C:/Tools/tabterm/data/_cookies.txt \
  -X PUT http://127.0.0.1:3007/api/labels/worker/1abc \
  -H "content-type: application/json" -H "x-tabterm-csrf: $CSRF" -d '{"name":"x"}'
# Expected: {"error":"bad_idx"}

# Out-of-range idx → 400
curl -s -b C:/Tools/tabterm/data/_cookies.txt \
  -X PUT http://127.0.0.1:3007/api/labels/worker/999 \
  -H "content-type: application/json" -H "x-tabterm-csrf: $CSRF" -d '{"name":"x"}'
# Expected: {"error":"bad_idx"}

# Too long → 422 too_long
curl -s -b C:/Tools/tabterm/data/_cookies.txt \
  -X PUT http://127.0.0.1:3007/api/labels/worker/0 \
  -H "content-type: application/json" -H "x-tabterm-csrf: $CSRF" \
  -d "{\"name\":\"$(printf 'a%.0s' {1..33})\"}"
# Expected: {"error":"validation","field":"name","reason":"too_long"}

# Number name → 422 type
curl -s -b C:/Tools/tabterm/data/_cookies.txt \
  -X PUT http://127.0.0.1:3007/api/labels/worker/0 \
  -H "content-type: application/json" -H "x-tabterm-csrf: $CSRF" -d '{"name":123}'
# Expected: {"error":"validation","field":"name","reason":"type"}
```

- [ ] **Step 6: Clear label (empty string)**

```bash
curl -s -b C:/Tools/tabterm/data/_cookies.txt \
  -X PUT http://127.0.0.1:3007/api/labels/worker/0 \
  -H "content-type: application/json" -H "x-tabterm-csrf: $CSRF" -d '{"name":""}'
```

Expected: `{"ok":true,"workerIndex":0,"label":null,"workers":{}}`

- [ ] **Step 7: Persist across restart**

```bash
# set a label
curl -s -b C:/Tools/tabterm/data/_cookies.txt \
  -X PUT http://127.0.0.1:3007/api/labels/worker/0 \
  -H "content-type: application/json" -H "x-tabterm-csrf: $CSRF" -d '{"name":"persist-me"}'
```

Stop server (Ctrl+C in npm start window). Restart `npm start`. GET `/api/labels` again (re-login + new CSRF if cookie expired):

Expected: `{"version":1,"workers":{"0":"persist-me"}}`

Clean up cookie file: `rm C:/Tools/tabterm/data/_cookies.txt`.

- [ ] **Step 8: No commit needed (verification only).** If a problem is found, fix the relevant file and commit there with `fix(...)` scope.

---

## Task 6: Frontend — state, displayName, slot strip & title wiring

**Files:**
- Modify: `C:/Tools/tabterm/public/app.js`

- [ ] **Step 1: Extend `state`**

Open `C:/Tools/tabterm/public/app.js`. Find the `const state = { ... }` block (around line 102). Add two keys before the closing brace:

```js
const state = {
  panes: [],
  slots: [null, null],
  slotCursor: 0,
  activeSlot: 0,
  workersCount: 8,
  workerPrefix: 'worker-',
  workersRoot: 'C:/workspace',
  preflightIssues: [],
  hydra: { enabled: true, ready: false },
  split: null,
  workerLabels: {},        // { "0": "pixiechess", ... } from preflight + PUT responses
  editing: null,           // { kind: 'worker'|'session', key, originalValue, inputEl, cancelled }
};
```

- [ ] **Step 2: Wire `workerLabels` from preflight**

Find `async function init()` (around line 762). Inside the first `try`, after `state.hydra = pre.hydra || ...;`, add:

```js
    state.workerLabels = pre.workerLabels || {};
    if (pre.labelsHealth && pre.labelsHealth !== 'ok') {
      toast(`labels: ${pre.labelsHealth}`, pre.labelsHealth === 'corrupted_reset' ? 'err' : 'amber', 6000);
    }
```

- [ ] **Step 3: Add `displayName` helper**

After the `paneById` helper (around line 122), add:

```js
function displayName(p) {
  if (!p) return '';
  if (p.kind === 'worker') {
    const custom = state.workerLabels[p.workerIndex];
    return custom || p.label;
  }
  return p.label;
}
```

- [ ] **Step 4: Wire `displayName` into `renderSlotStrip`**

Find `renderSlotStrip()` (around line 244). Change the line:

```js
    chip.querySelector('.slot-label').textContent = p ? p.label : 'empty';
```

to:

```js
    chip.querySelector('.slot-label').textContent = p ? displayName(p) : 'empty';
```

- [ ] **Step 5: Wire `displayName` into window title in `buildLayout`**

Find the line near the end of `buildLayout()`:

```js
  $('#wc-title-text').textContent = activePane ? `tabterm — ${activePane.label}` : 'tabterm';
```

Replace with:

```js
  $('#wc-title-text').textContent = activePane ? `tabterm — ${displayName(activePane)}` : 'tabterm';
```

- [ ] **Step 6: Wire `displayName` into pane header**

Inside `paneHtml(p, slotLabel)` (around line 282), change:

```js
        <div class="session-name">${escapeHtml(p.label)} <span class="ver">${slotLabel}</span></div>
```

to:

```js
        <div class="session-name">${escapeHtml(displayName(p))} <span class="ver">${slotLabel}</span></div>
```

- [ ] **Step 7: Quick browser smoke**

Restart the server (`npm start` in `C:/Tools/tabterm`). Open `http://127.0.0.1:3007` in browser, log in. Should look unchanged at this point (no labels set). Window title shows `tabterm — worker-0` when worker-0 active.

- [ ] **Step 8: Commit**

```bash
cd C:/Tools/tabterm
git add public/app.js
git commit -m "feat(ui): state.workerLabels + displayName wiring into slot strip, title, pane header"
```

---

## Task 7: Frontend — pencil icon + meta change in sidebar renders

**Files:**
- Modify: `C:/Tools/tabterm/public/app.js`

- [ ] **Step 1: Pencil icon helper**

Add this helper near the existing `claudeMascotSvg` function (around line 306):

```js
function pencilSvg() {
  return `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5 L13.5 4.5 L5 13 L2.5 13.5 L3 11 Z"/><path d="M10 4 L12 6"/></svg>`;
}
```

- [ ] **Step 2: Update `renderRow` (sessions) with pencil + tweak meta**

Replace the entire `renderRow(p, kindLabel)` function with:

```js
function renderRow(p, kindLabel) {
  const el = document.createElement('div');
  const slot = slotOfPane(p.id);
  const isActive = slot >= 0 && slot === state.activeSlot;
  el.className = 'ws' + (isActive ? ' active' : '');
  el.dataset.paneId = p.id;
  el.dataset.kind = 'session';

  let glyph, gkind;
  if (p.dead) { glyph = '✗'; gkind = 'dead'; }
  else if (p.kind === 'session') { glyph = '◆'; gkind = 'session'; }
  else { glyph = '●'; gkind = 'run'; }

  const meta = p.dead ? `exit ${p.exitCode ?? '?'}` : (slot >= 0 ? (slot === 0 ? 'in slot L' : 'in slot R') : 'detached');
  const slotTag = slot >= 0 ? `<span class="ws-slot-tag">${slot === 0 ? 'L' : 'R'}</span>` : '';

  const name = displayName(p);
  // sessions: no separate "default" to suffix — original label is the random session-… string,
  // which would just be noise. Skip suffix.

  el.innerHTML = `
    <span class="ws-glyph ${gkind}">${glyph}</span>
    ${slotTag}
    <span class="ws-rename-btn" data-act="rename" data-kind="session" data-key="${p.id}" title="Rename">${pencilSvg()}</span>
    <div class="ws-name">${escapeHtml(name)}</div>
    <div class="ws-meta">${escapeHtml(meta)}</div>
    <div class="ws-path">${escapeHtml(p.cwd || '')}</div>
  `;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.ws-rename-btn') || e.target.closest('.ws-rename-input')) return;
    assignToSlot(p.id);
  });
  el.querySelector('.ws-rename-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    startRename(el, 'session', p.id, p.label, p.label);
  });
  return el;
}
```

- [ ] **Step 3: Update `renderWorkerRow` with pencil + meta suffix**

Replace `renderWorkerRow(i, p)` with:

```js
function renderWorkerRow(i, p) {
  const el = document.createElement('div');
  const slot = p ? slotOfPane(p.id) : -1;
  const isActive = slot >= 0 && slot === state.activeSlot;
  el.className = 'ws' + (isActive ? ' active' : '');
  el.dataset.workerIndex = String(i);
  el.dataset.kind = 'worker';

  const dirMissing = state.preflightIssues.some((s) => s.includes(`${state.workerPrefix}${i}`));
  let glyph = '*', gkind = 'idle', meta = 'idle';
  if (dirMissing) { glyph = '!'; gkind = 'dead'; meta = 'worker dir missing'; }
  else if (p && p.dead) { glyph = '✗'; gkind = 'dead'; meta = `exit ${p.exitCode ?? '?'}`; }
  else if (p) {
    glyph = '●'; gkind = 'run';
    meta = slot >= 0 ? (slot === 0 ? 'in slot L' : 'in slot R') : 'detached';
  }
  const slotTag = (p && slot >= 0) ? `<span class="ws-slot-tag">${slot === 0 ? 'L' : 'R'}</span>` : '';

  const defaultName = state.workerPrefix + i;
  const customLabel = state.workerLabels[i];
  const name = customLabel || defaultName;
  const metaText = customLabel ? `${meta} · ${defaultName}` : meta;

  el.innerHTML = `
    <span class="ws-glyph ${gkind}">${glyph}</span>
    ${slotTag}
    <span class="ws-rename-btn" data-act="rename" data-kind="worker" data-key="${i}" title="Rename">${pencilSvg()}</span>
    <div class="ws-name">${escapeHtml(name)}</div>
    <div class="ws-meta">${escapeHtml(metaText)}</div>
    <div class="ws-path">${escapeHtml(state.workersRoot + '/' + defaultName)}</div>
  `;
  el.addEventListener('click', async (e) => {
    if (e.target.closest('.ws-rename-btn') || e.target.closest('.ws-rename-input')) return;
    if (p) { assignToSlot(p.id); return; }
    try {
      const r = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ kind: 'worker', workerIndex: i, cols: 120, rows: 32 }),
      });
      addPaneFromServer(r.session);
      assignToSlot(r.session.id);
    } catch (err) { toast(`spawn failed: ${err.message || err}`, 'err'); }
  });
  el.querySelector('.ws-rename-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    startRename(el, 'worker', i, customLabel || '', defaultName);
  });
  return el;
}
```

Note: `startRename` is implemented in Task 8 — clicking now will throw `ReferenceError`. That's fine; the function reference is resolved lazily at click time.

- [ ] **Step 4: Browser smoke (visual only)**

Reload page. Each row should show a pencil icon. Clicking it should throw a console error (`startRename is not defined`) — that's expected until Task 8.

- [ ] **Step 5: Commit**

```bash
cd C:/Tools/tabterm
git add public/app.js
git commit -m "feat(ui): pencil icon + custom label rendering in sidebar rows"
```

---

## Task 8: Frontend — startRename / commitRename / cancelRename

**Files:**
- Modify: `C:/Tools/tabterm/public/app.js`

- [ ] **Step 1: Add rename module functions**

Add this block immediately after the `displayName` helper (from Task 6, Step 3):

```js
/* ---------- inline rename ---------- */
const RENAME_MAX = 32;

function startRename(rowEl, kind, key, currentValue, defaultName) {
  // If a rename is in progress somewhere else, cancel it first.
  if (state.editing) cancelRename();

  const nameEl = rowEl.querySelector('.ws-name');
  if (!nameEl) return;

  const wrap = document.createElement('div');
  wrap.className = 'ws-rename-input';
  wrap.innerHTML = `
    <input type="text" maxlength="${RENAME_MAX}" />
    <span class="ws-rename-counter">0/${RENAME_MAX}</span>
  `;
  const input = wrap.querySelector('input');
  const counter = wrap.querySelector('.ws-rename-counter');
  const initial = currentValue || '';
  input.value = initial;
  counter.textContent = `${input.value.length}/${RENAME_MAX}`;

  // Prevent row click and xterm focus stealing.
  for (const evtName of ['pointerdown', 'click', 'mousedown']) {
    wrap.addEventListener(evtName, (e) => e.stopPropagation());
  }
  input.addEventListener('input', () => {
    counter.textContent = `${input.value.length}/${RENAME_MAX}`;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  });
  input.addEventListener('blur', () => {
    // Allow the keydown handler to run first.
    setTimeout(() => {
      if (state.editing && !state.editing.cancelled) commitRename();
    }, 0);
  });

  nameEl.replaceWith(wrap);
  state.editing = { kind, key, originalValue: initial, defaultName, inputEl: input, wrapEl: wrap, rowEl, nameElHtml: nameEl.outerHTML, cancelled: false };
  input.focus();
  input.select();
}

async function commitRename() {
  const ed = state.editing;
  if (!ed) return;
  const input = ed.inputEl;
  input.disabled = true;
  ed.wrapEl.style.opacity = '0.6';

  const name = input.value;
  try {
    if (ed.kind === 'worker') {
      const r = await api(`/api/labels/worker/${ed.key}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });
      state.workerLabels = r.workers || {};
    } else {
      // session
      if (name.trim() === '') {
        // sessions don't support clearing → treat as cancel.
        cancelRename();
        return;
      }
      const r = await api(`/api/sessions/${encodeURIComponent(ed.key)}/label`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });
      const pane = paneById(ed.key);
      if (pane) pane.label = r.label;
    }
    state.editing = null;
    renderSidebar();
    renderSlotStrip();
    const activePane = paneById(state.slots[state.activeSlot]);
    $('#wc-title-text').textContent = activePane ? `tabterm — ${displayName(activePane)}` : 'tabterm';
    // also update the pane header if the active pane was renamed
    for (const p of state.panes) {
      if (!p.cellEl) continue;
      const nameSpan = p.cellEl.querySelector('.session-name');
      if (nameSpan) {
        const slot = slotOfPane(p.id);
        const slotLabel = slot === 0 ? 'slot L' : slot === 1 ? 'slot R' : '';
        nameSpan.innerHTML = `${escapeHtml(displayName(p))} <span class="ver">${escapeHtml(slotLabel)}</span>`;
      }
    }
  } catch (e) {
    const msg = e?.body?.reason || e?.body?.error || e?.message || 'rename failed';
    toast(`rename: ${msg}`, 'err');
    input.disabled = false;
    ed.wrapEl.style.opacity = '';
    input.focus();
    input.select();
  }
}

function cancelRename() {
  const ed = state.editing;
  if (!ed) return;
  ed.cancelled = true;
  // restore the original .ws-name element by re-rendering the sidebar
  state.editing = null;
  renderSidebar();
}
```

- [ ] **Step 2: Browser smoke**

Reload page.
- Click pencil on a worker → input appears with empty value (no custom label yet), counter shows `0/32`.
- Type `pixiechess`, press Enter → row re-renders showing `pixiechess`, with `· worker-0` in meta.
- Click pencil again → input prefilled with `pixiechess`. Press Esc → no change, row restored.
- Empty value + Enter on worker → label cleared, row shows `worker-0`, no meta suffix.

Spawn a session via "New session" button. Click pencil on the new session row, type `myproject`, Enter → row + slot strip + window title + pane header all update to `myproject`.

- [ ] **Step 3: Commit**

```bash
cd C:/Tools/tabterm
git add public/app.js
git commit -m "feat(ui): inline rename interaction (startRename/commitRename/cancelRename)"
```

---

## Task 9: Frontend — editing protection in renderSidebar + iOS IME guard

**Files:**
- Modify: `C:/Tools/tabterm/public/app.js`

- [ ] **Step 1: Guard input destruction during external re-renders**

Find `renderSidebar()` (around line 152). Wrap the body so that if an edit is active, we re-attach the live input into the freshly rendered row instead of letting it disappear. Replace `renderSidebar` with:

```js
function renderSidebar() {
  const ed = state.editing;
  const list = $('#sidebar-list');
  list.innerHTML = '';

  const sessions = state.panes.filter((p) => p.kind === 'session');
  if (sessions.length) {
    const h = document.createElement('div');
    h.className = 'ws-section';
    h.textContent = 'sessions';
    list.appendChild(h);
    for (const p of sessions) list.appendChild(renderRow(p, 'session'));
  }

  const wh = document.createElement('div');
  wh.className = 'ws-section';
  wh.textContent = 'workers (ccx)';
  list.appendChild(wh);

  for (let i = 0; i < state.workersCount; i++) {
    const p = paneByWorker(i);
    list.appendChild(renderWorkerRow(i, p));
  }

  // Preserve in-progress edit across re-render: find the freshly rendered row
  // matching state.editing and swap the .ws-name placeholder for the live input.
  if (ed && !ed.cancelled) {
    let freshRow = null;
    if (ed.kind === 'worker') {
      freshRow = list.querySelector(`.ws[data-worker-index="${ed.key}"]`);
    } else {
      freshRow = list.querySelector(`.ws[data-pane-id="${CSS.escape(ed.key)}"]`);
    }
    if (freshRow) {
      const placeholder = freshRow.querySelector('.ws-name');
      if (placeholder) {
        placeholder.replaceWith(ed.wrapEl);
        // refresh row reference + restore focus if it was lost
        ed.rowEl = freshRow;
        if (document.activeElement !== ed.inputEl) {
          // Re-focus only if the user is still editing (avoid stealing focus during a confirm in commitRename).
          if (!ed.inputEl.disabled) ed.inputEl.focus();
        }
      }
    }
    // If the editing target disappeared from the sidebar (worker exited and was hidden, etc.),
    // the input simply has no DOM parent — cancelRename next time the user interacts.
  }
}
```

- [ ] **Step 2: Guard iOS IME focus redirect**

Find `focusActivePane(pane)` (around line 387). Replace with:

```js
function focusActivePane(pane) {
  if (state.editing && !state.editing.cancelled) return; // do not steal focus from rename input
  if (document.body.classList.contains('ios-ime')) {
    document.getElementById('ime-input')?.focus();
    return;
  }
  pane?.term?.focus();
}
```

- [ ] **Step 3: Browser smoke**

Reload. Spawn worker-0. Click pencil to start renaming worker-0 → while input has focus, programmatically trigger renderSidebar from the DevTools console:

```js
renderSidebar();
```

(`renderSidebar` is not exported by default — instead, manually trigger a re-render by spawning/killing another worker pane in another tab, or simulate by calling `state.preflightIssues = state.preflightIssues.slice(); renderSidebar();` if exposed. Practical check: open a new browser tab, log in, kill the pane there — the original tab's renderSidebar should fire via the WS `exit` event, and the input should remain alive in the original tab.)

Simpler smoke: while editing, click another worker row in the same tab — its click handler will run, but the rename input should remain present (we guarded with `e.target.closest('.ws-rename-input')` in row click handlers from Task 7).

Manual: while editing, on iPad PWA (or Chrome devtools touch emulation), confirm the rename `<input>` keeps focus and Hangul typing goes into it (not the `ime-input` rail).

- [ ] **Step 4: Commit**

```bash
cd C:/Tools/tabterm
git add public/app.js
git commit -m "feat(ui): preserve rename input across renderSidebar + iOS IME focus guard"
```

---

## Task 10: Frontend — CSS for rename UI

**Files:**
- Modify: `C:/Tools/tabterm/public/styles.css`

- [ ] **Step 1: Append rename styles**

Append to `C:/Tools/tabterm/public/styles.css` (after the existing `.ws-slot-tag` block around line 162):

```css
/* ─── rename ─── */
.ws { padding-right: 36px; } /* room for pencil */
.ws-rename-btn {
  position: absolute;
  right: 10px; top: 9px;
  width: 18px; height: 18px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--muted);
  cursor: pointer;
  border-radius: 4px;
  opacity: 0.7;
}
.ws-rename-btn:hover { color: var(--text); background: rgba(255,255,255,0.05); opacity: 1; }
.ws.active .ws-rename-btn { color: #c7d6f5; opacity: 0.85; }
.ws.active .ws-rename-btn:hover { color: #fff; background: rgba(255,255,255,0.15); opacity: 1; }
.ws-slot-tag + .ws-rename-btn { right: 36px; } /* shift left when slot tag present */

.ws-rename-input {
  display: flex; align-items: center; gap: 6px;
  margin-top: 0;
}
.ws-rename-input input {
  flex: 1; min-width: 0;
  padding: 2px 6px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--accent);
  border-radius: 4px;
  font-family: "Geist", system-ui, sans-serif;
  font-size: 12.5px;
  outline: none;
}
.ws-rename-input input:disabled { opacity: 0.6; }
.ws-rename-counter {
  font-family: "Geist Mono", monospace;
  font-size: 10px;
  color: var(--muted);
  user-select: none;
}
.ws.active .ws-rename-counter { color: #c7d6f5 !important; }
```

- [ ] **Step 2: Browser smoke**

Hard-reload (Ctrl+Shift+R) to bust CSS cache. Click pencil → input + counter visible inside the row, no layout shift breaking neighboring rows. Active (selected) row pencil stays legible on blue background.

- [ ] **Step 3: Commit**

```bash
cd C:/Tools/tabterm
git add public/styles.css
git commit -m "feat(ui): rename input + pencil + counter styling"
```

---

## Task 11: gitignore + CHANGELOG + manual regression run

**Files:**
- Modify: `C:/Tools/tabterm/.gitignore`
- Modify: `C:/Tools/tabterm/CHANGELOG.md`

- [ ] **Step 1: Inspect existing `.gitignore`**

Read `C:/Tools/tabterm/.gitignore`. If `data/` is already ignored wholesale, skip Step 2. Otherwise append the labels artifacts.

- [ ] **Step 2: Add labels artifacts to `.gitignore` if needed**

Append (only the lines not already present):

```
# labels store + recovery artifacts
data/labels.json
data/labels.json.bak
data/labels.json.tmp-*
data/labels.json.corrupted-*
```

- [ ] **Step 3: Run the full manual regression checklist from spec §8**

Walk through each box below. Mark `[x]` only after observing the expected behavior.

Worker labels:
- [ ] Empty worker row → pencil → name → Enter → ws-name updated, meta shows ` · worker-0`.
- [ ] Existing label → empty string → Enter → label cleared.
- [ ] 32 chars input shows counter `32/32`; 33rd key blocked by `maxlength`.
- [ ] New browser tab, hard-reload, and full server restart → label persists.
- [ ] Force-corrupt `data/labels.json` (write `{not json` and remove `.bak`) → restart → empty + corrupted file preserved + `labels.json.corrupted-*` exists.
- [ ] With `.bak` valid → corrupt main → restart → labels recovered from bak.

Session labels:
- [ ] Spawn session → rename → slot chip + window title + pane header all update.
- [ ] Close session (✕) → label disappears (next session gets fresh default).
- [ ] PUT a label on a non-existent session ID → 404.

Security:
- [ ] PUT without CSRF header → 403.
- [ ] PUT without login → 401.
- [ ] `name` with control char (e.g. `a\x01b` via curl `--data-binary`) → 422 `control_char`.
- [ ] 1.1 KB body → 413 (Fastify bodyLimit).
- [ ] idx `-1`, `1e9`, `1abc`, `__proto__` → 400 `bad_idx`.
- [ ] `name: 123` → 422 `type`.

UX:
- [ ] Esc cancels without saving.
- [ ] While editing, kill the same worker via DevTools-issued WS close (or close the session pane in a 2nd browser tab) → rename input stays alive, value preserved.
- [ ] Disk-write failure path (rename `data/` to read-only briefly, or pull permissions) → PUT 500 + UI toast "rename: labels_persist_failed" + edit mode preserved + cache unchanged.
- [ ] Same label PUT (no-op) → 200 + audit log line absent.

iPad PWA (skip if no iPad available, mark `[n/a]`):
- [ ] Pencil always visible on touch.
- [ ] Hangul typed into rename input goes there, not the IME rail.
- [ ] After commit/cancel, normal ios-ime rail returns.

- [ ] **Step 4: Update CHANGELOG**

Open `C:/Tools/tabterm/CHANGELOG.md`. Replace the "Unreleased — design spec only (no code)" header block with:

```markdown
## 0.5.3 — 2026-05-20

Inline rename for worker/session rows (ccx peer-reviewed: spec v2 + implementation diff).

### Feature
- Sidebar rows now show a pencil icon (always visible, iPad-friendly). Click to rename inline.
- Worker labels persist to `data/labels.json` with atomic write + `.bak` recovery + corrupted-file preservation.
- Session labels mutate in-memory only — vanish on session exit.
- Custom label becomes the primary text; original default (`worker-0`, etc.) shifts to meta line as ` · worker-0`.

### API
- `GET /api/labels` — list worker labels (auth only).
- `PUT /api/labels/worker/:idx` — set/clear worker label (auth + CSRF, 1 KB body limit).
- `PUT /api/sessions/:id/label` — set session label (auth + CSRF, 1 KB body limit).
- `/api/preflight` extended with `workerLabels` and `labelsHealth`.

### Internals
- New `server/labels.js`: validateLabel + load/save with write-queue mutex + atomic tmpfile rename.
- `SessionStore.setLabel(id, name)`.
- Idempotent no-op: same label → no disk write, no audit log line.

### Tests
- `server/labels.test.js` — `node:test` unit + integration tests for validateLabel and store roundtrip, recovery, concurrency, prototype-pollution defense.
```

- [ ] **Step 5: Commit**

```bash
cd C:/Tools/tabterm
git add .gitignore CHANGELOG.md
git commit -m "chore: gitignore labels artifacts + CHANGELOG 0.5.3"
```

---

## Task 12: Codex peer review on full implementation diff (user mandate)

**Files:** none modified — review step.

- [ ] **Step 1: Generate the diff range**

```bash
cd C:/Tools/tabterm
git log --oneline HEAD~12..HEAD
```

Expected: 11 commits from Tasks 1–11 (test/labels, store, sessions.setLabel, routes, ui state, pencil, rename, edit-protection, css, gitignore+changelog) plus the earlier spec commit (already in master).

```bash
git diff HEAD~11..HEAD -- server/ public/ > /tmp/tabterm-rename-impl.diff
wc -l /tmp/tabterm-rename-impl.diff
```

- [ ] **Step 2: Invoke Codex MCP with the diff**

From within Claude Code session (NOT inside a teammate prompt — Codex is `mcp__codex__codex`):

```
mcp__codex__codex({
  prompt: """
You are doing an independent code review of a feature implementation. The spec is at C:/Tools/tabterm/docs/superpowers/specs/2026-05-20-tabterm-rename-design.md (v2). Review the diff at /tmp/tabterm-rename-impl.diff against the spec.

Look for:
1) Spec deviations (anything in the diff that contradicts the spec)
2) Security: idx parsing, CSRF gating, body limit application, label sanitation, prototype pollution
3) Concurrency: write-queue correctness, race between commitRename and external renderSidebar
4) Edge cases: dead session PATCH/PUT, empty string session, blur+Esc double-fire
5) UI: iOS IME guard correctness (state.editing not steal focus, but commitRename also not stuck), input preservation across renderSidebar (Task 9), pencil hit area collisions with slot-tag
6) Test coverage adequacy

Output RED / YELLOW / BLUE severity buckets, terse Korean, one-line cause + one-line fix per finding.
""",
  approval-policy: "never",
  sandbox: "read-only",
})
```

- [ ] **Step 3: Apply any RED findings as fix commits**

For each RED, find the matching file/line and apply a `fix(...)` commit with a one-line message tying it to the Codex finding. Re-run `node --test server/labels.test.js` after any backend change. Browser smoke any frontend change.

- [ ] **Step 4: Mark review complete**

If Codex returns no RED, append to CHANGELOG under `## 0.5.3 — 2026-05-20`:

```
### Review
- Codex peer-reviewed implementation diff: no RED findings (YELLOW/BLUE addressed inline or documented).
```

If Codex returns RED and you address them, list the addressed items concisely.

```bash
cd C:/Tools/tabterm
git add CHANGELOG.md
git commit -m "docs: record Codex implementation diff review outcome"
```

---

## Self-review check (run before declaring done)

- Spec §3 (UX): Tasks 7 (pencil + meta), 8 (start/commit/cancel + maxlength counter + Esc/blur), 9 (renderSidebar protection + iOS IME), 10 (CSS) cover all UX rules.
- Spec §4.1–4.2 (labels.json + recovery): Task 2.
- Spec §4.3 (session label in-memory): Task 3.
- Spec §5.1 (createLabelsStore API): Task 2.
- Spec §5.2 (sessions.setLabel): Task 3.
- Spec §5.3 (validateLabel): Task 1.
- Spec §5.4 (API routes + preflight): Tasks 4–5.
- Spec §5.5 (audit events): Task 4 routes emit `label.set.worker`, `label.set.session`, `labels.persist.failed`; Task 4 boot emits `labels.load`.
- Spec §6 (frontend state, displayName, renders, interaction, CSS): Tasks 6–10.
- Spec §7 (security & concurrency): Task 4 (CSRF, bodyLimit, idx guard), Task 2 (write queue, prototype pollution).
- Spec §8 (manual regression): Task 11.
- Spec §9 (migration): no env change needed; `.gitignore` updates in Task 11.
- Spec §10 (work decomposition): mirrored in task ordering.
- User mandate (Codex peer review): Task 12.

**Known minor deviation flagged for review**: Spec §6.3 step 5 implies empty string clears any label (worker or session). For sessions, the implementation rejects empty string with `422 empty_not_allowed` because sessions have no default to revert to. This is intentional and documented in the Task 4 Step 5 prose; surface in Task 12 Codex prompt explicitly.
