# tabterm session folder persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote `kind=session` 폴더를 워커 폴더처럼 영속 entity 로 만들어, 사용자가 명시적으로 삭제하기 전까지 디스크에 남고, tabterm 재시작/새로고침 시 사이드바에 그대로 나타나며, 라벨로 식별되고, Kill(PTY 종료) 와 Delete(폴더 자체 삭제) 가 분리된 액션으로 제공된다.

**Architecture:**
- **Backend**: 각 세션 폴더 안 `tabterm.json` 에 메타(label, createdAt, lastUsedAt, version) 영속. 신규 helper `server/session-folder.js` 가 atomic read/write 담당. 신규/확장 API 4개 (GET enumerate, POST cwd 분기, PUT label, DELETE).
- **Frontend**: `state.folders` 추가 (디스크 enumerate 결과), `state.panes` (alive PTY) 와 join 하여 사이드바 렌더. 펜 아이콘 = 라벨 편집 (워커 컴포넌트 재사용, API 만 분기), 케밥 메뉴(⋮) = Kill/Delete 신규.
- **Backward compat**: `tabterm.json` 없는 기존 폴더는 fs.stat 의 birthtimeMs/mtimeMs 로 inferred 메타, 첫 라벨 편집 또는 PTY spawn 시 lazy migration.
- **보안**: path traversal 거부, `worker-` prefix 폴더 DELETE 403 보호.

**Tech Stack:** Node 22 (`node:test`, `node:fs/promises`), Fastify 5, vanilla JS frontend, ESM modules.

**선행 spec:** `docs/superpowers/specs/2026-05-21-tabterm-session-folder-persistence-design.md`

**Branch:** `feat/session-folder-persistence` (이미 분기 + spec commit `c3e4e6e` 완료)

---

## Task 1: tabterm.json helper 모듈 (`server/session-folder.js`)

**목적:** 각 세션 폴더 안 `tabterm.json` read/write/inferred fallback 담당. 모든 영속화의 single point.

**Files:**
- Create: `C:/Tools/tabterm/server/session-folder.js`
- Test: `C:/Tools/tabterm/server/session-folder.test.js`

### Step 1.1: 실패하는 테스트 작성

- [ ] **Step 1.1** Test 파일 작성

Create `C:/Tools/tabterm/server/session-folder.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readMeta, writeMeta, ensureMeta, touchLastUsed,
  SCHEMA_VERSION,
} from './session-folder.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'tabterm-sf-'));
}

test('readMeta: missing tabterm.json → inferred from fs.stat', async () => {
  const dir = tmp();
  try {
    const meta = await readMeta(dir);
    assert.equal(meta.hasTabtermJson, false);
    assert.equal(meta.schemaVersion, null);
    assert.equal(meta.label, '');
    assert.equal(typeof meta.createdAt, 'number');
    assert.equal(typeof meta.lastUsedAt, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMeta: valid tabterm.json → parsed', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'tabterm.json'), JSON.stringify({
      version: 1, label: 'my work', createdAt: 1000, lastUsedAt: 2000,
    }));
    const meta = await readMeta(dir);
    assert.equal(meta.hasTabtermJson, true);
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.label, 'my work');
    assert.equal(meta.createdAt, 1000);
    assert.equal(meta.lastUsedAt, 2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMeta: corrupt JSON → fallback to inferred + hasTabtermJson true', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'tabterm.json'), '{ not json');
    const meta = await readMeta(dir);
    assert.equal(meta.hasTabtermJson, true);
    assert.equal(meta.schemaVersion, null);
    assert.equal(meta.label, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMeta: unknown schema version → read-only mode (label preserved, version null)', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'tabterm.json'), JSON.stringify({
      version: 99, label: 'future', createdAt: 1, lastUsedAt: 2,
    }));
    const meta = await readMeta(dir);
    assert.equal(meta.hasTabtermJson, true);
    assert.equal(meta.schemaVersion, null);
    assert.equal(meta.label, 'future');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMeta: atomic write produces parseable JSON', async () => {
  const dir = tmp();
  try {
    await writeMeta(dir, { label: 'hello', createdAt: 100, lastUsedAt: 200 });
    const meta = await readMeta(dir);
    assert.equal(meta.label, 'hello');
    assert.equal(meta.createdAt, 100);
    assert.equal(meta.lastUsedAt, 200);
    assert.equal(meta.schemaVersion, SCHEMA_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMeta: rejects non-existent dir', async () => {
  await assert.rejects(
    writeMeta('/nonexistent/path/xyz', { label: '', createdAt: 1, lastUsedAt: 1 })
  );
});

test('ensureMeta: creates tabterm.json if missing', async () => {
  const dir = tmp();
  try {
    const before = await readMeta(dir);
    assert.equal(before.hasTabtermJson, false);
    const result = await ensureMeta(dir, { label: 'init' });
    assert.equal(result.created, true);
    const after = await readMeta(dir);
    assert.equal(after.hasTabtermJson, true);
    assert.equal(after.label, 'init');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureMeta: preserves existing tabterm.json (no-op)', async () => {
  const dir = tmp();
  try {
    await writeMeta(dir, { label: 'existing', createdAt: 50, lastUsedAt: 60 });
    const result = await ensureMeta(dir, { label: 'new' });
    assert.equal(result.created, false);
    const meta = await readMeta(dir);
    assert.equal(meta.label, 'existing');
    assert.equal(meta.createdAt, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('touchLastUsed: updates lastUsedAt without touching other fields', async () => {
  const dir = tmp();
  try {
    await writeMeta(dir, { label: 'lbl', createdAt: 100, lastUsedAt: 200 });
    await new Promise((r) => setTimeout(r, 10));
    await touchLastUsed(dir);
    const meta = await readMeta(dir);
    assert.equal(meta.label, 'lbl');
    assert.equal(meta.createdAt, 100);
    assert.ok(meta.lastUsedAt > 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 1.2** 테스트가 실패하는지 확인

Run: `cd C:/Tools/tabterm && node --test server/session-folder.test.js`
Expected: FAIL with `Cannot find module './session-folder.js'` 또는 비슷한 import 에러

- [ ] **Step 1.3** 구현 작성

Create `C:/Tools/tabterm/server/session-folder.js`:

```js
// session-folder.js — 일반 세션 폴더의 tabterm.json 메타 read/write
// 각 폴더가 자체 라벨 / 타임스탬프 영속. 워커 라벨(중앙 labels.json) 과 분리.

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  readFile, writeFile, rename, stat, unlink,
} from 'node:fs/promises';

export const SCHEMA_VERSION = 1;
const META_FILENAME = 'tabterm.json';

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function parseSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function clampLabel(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (t.length > 32) return t.slice(0, 32);
  return t;
}

function clampTimestamp(v, fallback) {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export async function readMeta(cwd) {
  const metaPath = join(cwd, META_FILENAME);
  const dirStat = await stat(cwd);
  const inferredCreated = Math.floor(dirStat.birthtimeMs || dirStat.ctimeMs || Date.now());
  const inferredUsed = Math.floor(dirStat.mtimeMs || Date.now());

  let hasTabtermJson = false;
  let raw = null;
  try {
    const buf = await readFile(metaPath, 'utf8');
    hasTabtermJson = true;
    raw = parseSafe(buf);
  } catch (e) {
    if (e.code !== 'ENOENT') hasTabtermJson = true;
  }

  if (!isPlainObject(raw)) {
    return {
      hasTabtermJson,
      schemaVersion: null,
      label: '',
      createdAt: inferredCreated,
      lastUsedAt: inferredUsed,
    };
  }

  const schemaVersion = raw.version === SCHEMA_VERSION ? SCHEMA_VERSION : null;
  return {
    hasTabtermJson: true,
    schemaVersion,
    label: clampLabel(raw.label),
    createdAt: clampTimestamp(raw.createdAt, inferredCreated),
    lastUsedAt: clampTimestamp(raw.lastUsedAt, inferredUsed),
  };
}

export async function writeMeta(cwd, { label, createdAt, lastUsedAt }) {
  const metaPath = join(cwd, META_FILENAME);
  const tmpPath = `${metaPath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const body = JSON.stringify({
    version: SCHEMA_VERSION,
    label: clampLabel(label),
    createdAt: clampTimestamp(createdAt, Date.now()),
    lastUsedAt: clampTimestamp(lastUsedAt, Date.now()),
  }, null, 2);
  await writeFile(tmpPath, body, 'utf8');
  try {
    await rename(tmpPath, metaPath);
  } catch (e) {
    try { await unlink(tmpPath); } catch {}
    throw e;
  }
}

// 폴더에 tabterm.json 이 없으면 작성. 있으면 no-op. label 은 신규 작성 시에만 사용.
export async function ensureMeta(cwd, { label = '' } = {}) {
  const existing = await readMeta(cwd);
  if (existing.hasTabtermJson) return { created: false, meta: existing };
  const now = Date.now();
  await writeMeta(cwd, { label, createdAt: now, lastUsedAt: now });
  return { created: true, meta: await readMeta(cwd) };
}

// lastUsedAt 만 갱신. 폴더에 tabterm.json 이 없으면 lazy migration.
export async function touchLastUsed(cwd) {
  const meta = await readMeta(cwd);
  await writeMeta(cwd, {
    label: meta.label,
    createdAt: meta.createdAt,
    lastUsedAt: Date.now(),
  });
}

// 라벨만 갱신, 다른 필드 보존. 폴더에 tabterm.json 이 없으면 lazy migration.
export async function setLabel(cwd, label) {
  const meta = await readMeta(cwd);
  await writeMeta(cwd, {
    label,
    createdAt: meta.createdAt,
    lastUsedAt: meta.lastUsedAt,
  });
}
```

- [ ] **Step 1.4** 테스트 통과 확인

Run: `cd C:/Tools/tabterm && node --test server/session-folder.test.js`
Expected: PASS 9/9

- [ ] **Step 1.5** Commit

```bash
cd C:/Tools/tabterm
git add server/session-folder.js server/session-folder.test.js
git commit -m "feat: tabterm.json helper for session folder metadata

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: GET /api/sessions/folders — enumerate

**목적:** workspace 의 `session-*` 디스크 폴더를 enumerate. alive PTY 정보는 클라이언트가 `/api/sessions` 와 join.

**Files:**
- Modify: `C:/Tools/tabterm/server/index.js` (POST /api/sessions 라우트 근처에 추가)
- Test: `C:/Tools/tabterm/server/folders-api.test.js` (신규)

### Step 2.1: 신규 enumerate helper 작성 + 테스트

- [ ] **Step 2.1** Test 파일 작성

Create `C:/Tools/tabterm/server/folders-api.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessionFolders } from './session-folder.js';

function setupRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tabterm-root-'));
  // 워커 폴더 (제외돼야 함)
  mkdirSync(join(root, 'worker-0'));
  mkdirSync(join(root, 'worker-7'));
  // 세션 폴더 (포함돼야 함)
  mkdirSync(join(root, 'session-20260521140000-aaaa'));
  writeFileSync(join(root, 'session-20260521140000-aaaa', 'tabterm.json'), JSON.stringify({
    version: 1, label: 'labeled', createdAt: 100, lastUsedAt: 200,
  }));
  mkdirSync(join(root, 'session-20260521141000-bbbb'));
  // legacy (no tabterm.json)
  mkdirSync(join(root, 'session-legacy'));
  // 무관 폴더 (제외돼야 함)
  mkdirSync(join(root, 'random-folder'));
  return root;
}

test('listSessionFolders: filters worker- and non-session- prefixes', async () => {
  const root = setupRoot();
  try {
    const folders = await listSessionFolders(root, {
      workerPrefix: 'worker-',
      sessionPrefix: 'session-',
    });
    const names = folders.map((f) => f.name).sort();
    assert.deepEqual(names, [
      'session-20260521140000-aaaa',
      'session-20260521141000-bbbb',
      'session-legacy',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listSessionFolders: includes meta fields per folder', async () => {
  const root = setupRoot();
  try {
    const folders = await listSessionFolders(root, {
      workerPrefix: 'worker-',
      sessionPrefix: 'session-',
    });
    const labeled = folders.find((f) => f.name === 'session-20260521140000-aaaa');
    assert.equal(labeled.label, 'labeled');
    assert.equal(labeled.hasTabtermJson, true);
    assert.equal(labeled.schemaVersion, 1);
    assert.equal(labeled.createdAt, 100);
    assert.equal(labeled.lastUsedAt, 200);

    const legacy = folders.find((f) => f.name === 'session-legacy');
    assert.equal(legacy.hasTabtermJson, false);
    assert.equal(legacy.label, '');
    assert.equal(legacy.schemaVersion, null);
    assert.ok(typeof legacy.createdAt === 'number');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listSessionFolders: returns [] when root missing', async () => {
  const folders = await listSessionFolders('/nonexistent/path/xyz', {
    workerPrefix: 'worker-',
    sessionPrefix: 'session-',
  });
  assert.deepEqual(folders, []);
});
```

- [ ] **Step 2.2** 테스트 실패 확인

Run: `cd C:/Tools/tabterm && node --test server/folders-api.test.js`
Expected: FAIL — `listSessionFolders is not exported`

- [ ] **Step 2.3** session-folder.js 에 listSessionFolders 추가

Edit `C:/Tools/tabterm/server/session-folder.js` — 파일 끝에 추가:

```js
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// 주어진 root 의 모든 세션 폴더 enumerate. 워커/무관 폴더 제외.
// 폴더별 메타 read 실패는 skip + 빈 결과로 처리 (warn 은 caller 책임).
export async function listSessionFolders(root, { workerPrefix, sessionPrefix }) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(workerPrefix)) continue;
    if (!ent.name.startsWith(sessionPrefix)) continue;
    const cwd = resolve(root, ent.name);
    try {
      const meta = await readMeta(cwd);
      out.push({ name: ent.name, cwd, ...meta });
    } catch {
      // ENOENT race (폴더 삭제됨) 등 skip
    }
  }
  return out;
}
```

(주의: 기존 file 의 import 절에 `readdir, resolve` 가 이미 있는지 확인 후 중복 import 방지)

- [ ] **Step 2.4** 테스트 통과 확인

Run: `cd C:/Tools/tabterm && node --test server/folders-api.test.js server/session-folder.test.js`
Expected: PASS 12/12 (3 신규 + 9 기존)

### Step 2.5: GET /api/sessions/folders 라우트 추가

- [ ] **Step 2.5** server/index.js 수정

Edit `C:/Tools/tabterm/server/index.js`:

1. Import 절에 추가 (line 19 의 `./config.js` 옆):
```js
import { listSessionFolders } from './session-folder.js';
```

2. `app.get('/api/sessions', ...)` (line 166) 바로 아래에 추가:

```js
app.get('/api/sessions/folders', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  try {
    const folders = await listSessionFolders(WORKERS_ROOT, {
      workerPrefix: WORKER_PREFIX,
      sessionPrefix: NEW_SESSION_PREFIX,
    });
    return { folders };
  } catch (e) {
    app.log.error({ err: e?.message }, '[folders] enumerate failed');
    return reply.code(500).send({ error: 'folders-enumerate-failed' });
  }
});
```

- [ ] **Step 2.6** 서버 구동 + manual smoke test

Run (별도 PowerShell):
```
cd C:/Tools/tabterm
npm start
```

다른 PowerShell 에서:
```
# 로그인 후 csrf 토큰 받아서 (또는 인증 거치고)
curl http://127.0.0.1:3007/api/sessions/folders
```

Expected: `{"folders":[...]}` JSON 응답. workspace 의 기존 session-* 폴더가 보이거나 빈 배열.

- [ ] **Step 2.7** Commit

```bash
cd C:/Tools/tabterm
git add server/session-folder.js server/folders-api.test.js server/index.js
git commit -m "feat: GET /api/sessions/folders enumerate session dirs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: POST /api/sessions 에 cwd 옵션 + 신규 세션 시 tabterm.json 작성

**목적:** 사용자가 기존 폴더에 attach 가능하게 + 신규 세션 생성 시 tabterm.json 즉시 작성.

**Files:**
- Modify: `C:/Tools/tabterm/server/index.js` line 332 부근 (POST /api/sessions session 분기)

### Step 3.1: 경로 검증 helper 추가 + 테스트

- [ ] **Step 3.1** Test 파일 작성

Append to `C:/Tools/tabterm/server/folders-api.test.js`:

```js
import { validateSessionFolderName } from './session-folder.js';

test('validateSessionFolderName: rejects path separators', () => {
  for (const v of ['../escape', 'a/b', 'a\\b', './rel']) {
    const r = validateSessionFolderName(v, { workerPrefix: 'worker-', sessionPrefix: 'session-' });
    assert.equal(r.ok, false, `should reject: ${v}`);
  }
});

test('validateSessionFolderName: rejects worker- prefix', () => {
  const r = validateSessionFolderName('worker-0', { workerPrefix: 'worker-', sessionPrefix: 'session-' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'worker-protected');
});

test('validateSessionFolderName: rejects non-session- prefix', () => {
  const r = validateSessionFolderName('random-folder', { workerPrefix: 'worker-', sessionPrefix: 'session-' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad-prefix');
});

test('validateSessionFolderName: accepts valid session name', () => {
  const r = validateSessionFolderName('session-20260521140000-aaaa', {
    workerPrefix: 'worker-', sessionPrefix: 'session-',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 'session-20260521140000-aaaa');
});

test('validateSessionFolderName: rejects empty/non-string', () => {
  for (const v of ['', null, undefined, 123, {}]) {
    const r = validateSessionFolderName(v, { workerPrefix: 'worker-', sessionPrefix: 'session-' });
    assert.equal(r.ok, false);
  }
});
```

- [ ] **Step 3.2** 테스트 실패 확인

Run: `cd C:/Tools/tabterm && node --test server/folders-api.test.js`
Expected: FAIL — `validateSessionFolderName is not exported`

- [ ] **Step 3.3** session-folder.js 에 validate 추가

Append to `C:/Tools/tabterm/server/session-folder.js`:

```js
const FOLDER_NAME_BAD_CHARS = /[\\/]|^\.{1,2}$|\.\.[\\/]|[\\/]\.\.[\\/]|^\.\.|\.\.$/;

export function validateSessionFolderName(name, { workerPrefix, sessionPrefix }) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'type' };
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, error: 'bad-path' };
  }
  if (name.startsWith(workerPrefix)) {
    return { ok: false, error: 'worker-protected' };
  }
  if (!name.startsWith(sessionPrefix)) {
    return { ok: false, error: 'bad-prefix' };
  }
  return { ok: true, value: name };
}
```

- [ ] **Step 3.4** 테스트 통과 확인

Run: `cd C:/Tools/tabterm && node --test server/folders-api.test.js`
Expected: PASS 8/8 (3 기존 enumerate + 5 신규 validate)

### Step 3.5: POST 라우트 cwd 분기 + tabterm.json 작성

- [ ] **Step 3.5** server/index.js 수정

Edit `C:/Tools/tabterm/server/index.js`:

1. Import 절 확장 (Task 2 에서 추가한 `listSessionFolders` 라인을 다음으로 교체):
```js
import {
  listSessionFolders,
  validateSessionFolderName,
  ensureMeta,
  touchLastUsed,
} from './session-folder.js';
```

2. POST /api/sessions 의 session 분기 (line 344~383) 를 다음으로 교체:

```js
  // general session — no ccx env. 두 모드:
  //   1) cwd 미지정 → 새 폴더 mkdir + tabterm.json 작성 (legacy POST 동작)
  //   2) cwd 지정 → 기존 폴더에 attach (validate 후), tabterm.json touch
  const inv = buildClaudeInvocation();
  const claudeArgs = process.env.SESSION_CLAUDE_ARGS || '';

  let cwd;
  let folderName;
  let createdNow = false;

  if (req.body && typeof req.body.cwd === 'string') {
    // Mode 2: attach to existing folder
    const proposedPath = normalize(req.body.cwd);
    folderName = proposedPath.split(/[\\/]+/).pop() || '';
    const v = validateSessionFolderName(folderName, {
      workerPrefix: WORKER_PREFIX,
      sessionPrefix: NEW_SESSION_PREFIX,
    });
    if (!v.ok) return reply.code(400).send({ error: 'bad-cwd', reason: v.error });
    cwd = resolve(WORKERS_ROOT, folderName);
    if (resolve(proposedPath) !== cwd) {
      return reply.code(400).send({ error: 'bad-cwd', reason: 'not-in-workspace' });
    }
    if (!existsSync(cwd)) {
      return reply.code(400).send({ error: 'bad-cwd', reason: 'missing', cwd });
    }
    // 동일 cwd alive PTY 검사
    const existing = sessions.list().filter(
      (s) => s.kind === 'session' && s.cwd === cwd && s.alive,
    );
    if (existing.length > 0 && !req.body.force) {
      return reply.code(409).send({
        error: 'session-folder-busy',
        cwd,
        existing: existing.map((s) => ({ id: s.id, createdAt: s.createdAt })),
      });
    }
    if (req.body.force && existing.length > 0) {
      for (const s of existing) {
        sessions.kill(s.id);
        audit.log({ event: 'session.folder.evict', id: s.id, cwd, ip: req.ip });
      }
    }
  } else {
    // Mode 1: 신규 폴더
    const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const rand = randomBytes(2).toString('hex');
    folderName = `${NEW_SESSION_PREFIX}${ts}-${rand}`;
    cwd = resolve(WORKERS_ROOT, folderName);
    try {
      await mkdir(cwd, { recursive: true });
      createdNow = true;
    } catch (e) {
      return reply.code(500).send({ error: 'mkdir-failed', message: String(e?.message || e) });
    }
  }

  // tabterm.json 자동 작성 (Mode 1) 또는 touch (Mode 2)
  try {
    if (createdNow) {
      await ensureMeta(cwd, { label: typeof label === 'string' ? label : '' });
    } else {
      await touchLastUsed(cwd);
    }
  } catch (e) {
    app.log.warn({ err: e?.message, cwd }, '[session] tabterm.json write failed');
    audit.log({ event: 'session.folder.meta.write.failed', cwd, err: String(e?.message || e), ip: req.ip });
    // 메타 실패는 PTY spawn 까지 막지 않음
  }

  const sessionLabel = label || folderName;
  try {
    const s = sessions.create({
      label: sessionLabel,
      cwd,
      command: inv.cmd,
      claudeArgs,
      cols: Math.min(Math.max(Number(cols) || 120, 20), 400),
      rows: Math.min(Math.max(Number(rows) || 32, 8), 200),
      extraEnv: {},
      meta: { kind: 'session', workerIndex: null },
      onExit: ({ id, exitCode }) => audit.log({ event: 'session.exit', id, exitCode, kind: 'session' }),
    });
    audit.log({
      event: createdNow ? 'session.folder.create' : 'session.folder.attach',
      id: s.id,
      cwd,
      kind: 'session',
      ip: req.ip,
    });
    return { session: s.summary(), envSource: 'none', envWarnings: [], cwd, folderName };
  } catch (e) {
    app.log.error(e);
    return reply.code(500).send({ error: 'spawn-failed', message: String(e?.message || e) });
  }
});
```

3. `normalize` import 확인 (line 8 의 `import { resolve, dirname, normalize } from 'node:path';` 에 이미 있음).

- [ ] **Step 3.6** Manual smoke test

서버 재시작 후 (Ctrl+C → `npm start`):

```
# Mode 1 (신규)
curl -X POST http://127.0.0.1:3007/api/sessions \
  -H "Content-Type: application/json" \
  -H "x-tabterm-csrf: <csrf>" \
  -d '{"kind":"session","cols":120,"rows":32}'
# → cwd 에 session-<ts>-<hex> + tabterm.json 작성 확인

# Mode 2 (attach 기존)
curl -X POST http://127.0.0.1:3007/api/sessions \
  -H "Content-Type: application/json" \
  -H "x-tabterm-csrf: <csrf>" \
  -d '{"kind":"session","cwd":"C:/workspace/session-<ts>-<hex>"}'
# → 같은 폴더에 attach, lastUsedAt 갱신 확인 (tabterm.json mtime 갱신)
```

- [ ] **Step 3.7** Commit

```bash
cd C:/Tools/tabterm
git add server/index.js server/session-folder.js server/folders-api.test.js
git commit -m "feat: POST /api/sessions supports cwd attach + writes tabterm.json

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: PUT /api/sessions/folders/:name/label

**목적:** 라벨만 영속 변경. alive PTY 가 있으면 메모리 label 도 동기화.

**Files:**
- Modify: `C:/Tools/tabterm/server/index.js`

### Step 4.1: 라우트 추가

- [ ] **Step 4.1** server/index.js 수정

Import 확장 (`setLabel` 추가):
```js
import {
  listSessionFolders,
  validateSessionFolderName,
  ensureMeta,
  touchLastUsed,
  setLabel as setFolderLabel,
} from './session-folder.js';
```

라우트 추가 (PUT /api/sessions/:id/label 옆에):

```js
app.put('/api/sessions/folders/:name/label', {
  config: { rateLimit: false },
  bodyLimit: 1024,
}, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const v = validateSessionFolderName(req.params.name, {
    workerPrefix: WORKER_PREFIX,
    sessionPrefix: NEW_SESSION_PREFIX,
  });
  if (!v.ok) return reply.code(400).send({ error: 'bad-name', reason: v.error });
  const labelV = validateLabel(req.body?.name);
  if (!labelV.ok) return reply.code(422).send({ error: 'validation', field: 'name', reason: labelV.error });

  const cwd = resolve(WORKERS_ROOT, v.value);
  if (!existsSync(cwd)) return reply.code(404).send({ error: 'folder-not-found', cwd });

  try {
    await setFolderLabel(cwd, labelV.value);
  } catch (e) {
    app.log.error({ err: e?.message, cwd }, '[folder-label] persist failed');
    audit.log({ event: 'session.folder.label.set.failed', cwd, err: String(e?.message || e), ip: req.ip });
    return reply.code(500).send({ error: 'persist-failed' });
  }

  // 동일 cwd alive PTY 가 있으면 메모리 라벨 동기화
  const matched = sessions.list().filter((s) => s.kind === 'session' && s.cwd === cwd && s.alive);
  for (const s of matched) sessions.setLabel(s.id, labelV.value || v.value);

  audit.log({
    event: 'session.folder.label.set',
    cwd,
    length: labelV.value.length,
    cleared: labelV.value === '',
    matchedSessions: matched.length,
    ip: req.ip,
  });
  return { ok: true, folder: { name: v.value, cwd, label: labelV.value } };
});
```

(주의: `validateLabel` import 가 이미 line 23 에 있음.)

- [ ] **Step 4.2** Manual smoke test

```
# 폴더 라벨 변경
curl -X PUT http://127.0.0.1:3007/api/sessions/folders/session-<ts>-<hex>/label \
  -H "Content-Type: application/json" \
  -H "x-tabterm-csrf: <csrf>" \
  -d '{"name":"내 임시 작업"}'

# tabterm.json 확인
type C:/workspace/session-<ts>-<hex>/tabterm.json
# → label 필드가 "내 임시 작업"
```

- [ ] **Step 4.3** Commit

```bash
cd C:/Tools/tabterm
git add server/index.js
git commit -m "feat: PUT /api/sessions/folders/:name/label persists session label

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: DELETE /api/sessions/folders/:name

**목적:** 폴더 자체 삭제 (PTY kill → rm -rf). 워커 폴더 보호 + path traversal 거부.

**Files:**
- Modify: `C:/Tools/tabterm/server/index.js`

### Step 5.1: 라우트 추가

- [ ] **Step 5.1** server/index.js 수정

`rm` import 추가:
```js
import { mkdir, rm } from 'node:fs/promises';
```
(기존 `import { mkdir } from 'node:fs/promises';` 를 위 줄로 교체)

라우트 추가 (DELETE /api/sessions/:id 옆에):

```js
app.delete('/api/sessions/folders/:name', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const v = validateSessionFolderName(req.params.name, {
    workerPrefix: WORKER_PREFIX,
    sessionPrefix: NEW_SESSION_PREFIX,
  });
  if (v.error === 'worker-protected') {
    return reply.code(403).send({ error: 'worker-folder-protected' });
  }
  if (!v.ok) return reply.code(400).send({ error: 'bad-name', reason: v.error });

  const cwd = resolve(WORKERS_ROOT, v.value);
  // 한 번 더 path containment 검증 (Defence in depth)
  if (!cwd.startsWith(resolve(WORKERS_ROOT) + (cwd.includes('\\') ? '\\' : '/'))) {
    return reply.code(400).send({ error: 'bad-path' });
  }
  if (!existsSync(cwd)) return reply.code(404).send({ error: 'folder-not-found' });

  // 1) alive PTY kill
  const matched = sessions.list().filter((s) => s.kind === 'session' && s.cwd === cwd && s.alive);
  for (const s of matched) sessions.kill(s.id);

  // 2) 폴더 자체 rm
  try {
    await rm(cwd, { recursive: true, force: true });
  } catch (e) {
    app.log.error({ err: e?.message, cwd }, '[folder-delete] rm failed');
    audit.log({ event: 'session.folder.delete.failed', cwd, err: String(e?.message || e), ip: req.ip });
    return reply.code(500).send({ error: 'rm-failed', message: String(e?.message || e) });
  }

  audit.log({
    event: 'session.folder.delete',
    cwd,
    killedSessions: matched.length,
    ip: req.ip,
  });
  return { ok: true, deleted: v.value };
});
```

- [ ] **Step 5.2** Manual smoke test (path traversal 시도)

```
# 정상 삭제
curl -X DELETE http://127.0.0.1:3007/api/sessions/folders/session-<ts>-<hex> \
  -H "x-tabterm-csrf: <csrf>"
# → {"ok":true}, 폴더 사라짐 확인

# 워커 보호
curl -X DELETE http://127.0.0.1:3007/api/sessions/folders/worker-0 \
  -H "x-tabterm-csrf: <csrf>"
# → 403 worker-folder-protected

# path traversal
curl -X DELETE "http://127.0.0.1:3007/api/sessions/folders/..%2Fworker-0" \
  -H "x-tabterm-csrf: <csrf>"
# → 400 bad-name
```

- [ ] **Step 5.3** Commit

```bash
cd C:/Tools/tabterm
git add server/index.js
git commit -m "feat: DELETE /api/sessions/folders/:name removes session dir

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Frontend state.folders + fetch 흐름

**목적:** `state.folders` 도입, `/api/sessions/folders` 주기적 fetch, alive PTY 와 join.

**Files:**
- Modify: `C:/Tools/tabterm/public/app.js`

### Step 6.1: state 확장 + fetch 함수 추가

- [ ] **Step 6.1** public/app.js 수정

`state` 객체 정의 부근 (검색: `const state = `):
```js
// 기존 state 에 추가:
folders: [],          // GET /api/sessions/folders 결과 (디스크 enumerate)
foldersLoadedAt: 0,
```

기존 sessions fetch 함수 (검색: `function fetchSessions` 또는 `/api/sessions` 호출 위치) 근처에 추가:

```js
async function fetchFolders() {
  try {
    const r = await fetch('/api/sessions/folders', { credentials: 'include' });
    if (!r.ok) throw new Error(`folders fetch ${r.status}`);
    const j = await r.json();
    state.folders = j.folders || [];
    state.foldersLoadedAt = Date.now();
  } catch (e) {
    console.warn('[folders] fetch failed', e);
  }
}
```

기존 sessions 갱신 흐름 (검색: `fetchSessions()` 호출되는 곳) 에 fetchFolders 추가 — 보통 polling 또는 WebSocket 이벤트 후:

```js
async function refreshAll() {
  await Promise.all([fetchSessions(), fetchFolders()]);
  renderSidebar();
}
```

(기존 fetchSessions + renderSidebar 흐름 자리에 refreshAll 로 교체)

- [ ] **Step 6.2** Browser DevTools 에서 manual 확인

```
1. tabterm 열어서 DevTools 열기
2. 콘솔에서: state.folders
3. workspace 의 session-* 폴더가 객체 배열로 나오는지 확인
```

- [ ] **Step 6.3** Commit

```bash
cd C:/Tools/tabterm
git add public/app.js
git commit -m "feat(ui): fetch /api/sessions/folders into state.folders

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 사이드바 sessions 섹션을 디스크 폴더 기반으로 렌더

**목적:** `state.panes.filter(kind===session)` 가 아니라 `state.folders` 를 source 로 사용 + alive PTY join + lastUsedAt DESC 정렬.

**Files:**
- Modify: `C:/Tools/tabterm/public/app.js` line 286-298 (renderSidebar 의 sessions 섹션)

### Step 7.1: renderSidebar 수정

- [ ] **Step 7.1** public/app.js 의 renderSidebar 의 sessions 섹션 교체

기존 (line 291-299):
```js
  // dynamic sessions (kind=session)
  const sessions = state.panes.filter((p) => p.kind === 'session');
  if (sessions.length) {
    const h = document.createElement('div');
    h.className = 'ws-section';
    h.textContent = 'sessions';
    list.appendChild(h);
    for (const p of sessions) list.appendChild(renderRow(p, 'session'));
  }
```

→ 다음으로 교체:
```js
  // dynamic sessions: 디스크 폴더 source + alive PTY join
  const sessionPanes = state.panes.filter((p) => p.kind === 'session');
  const paneByCwd = new Map();
  for (const p of sessionPanes) paneByCwd.set(p.cwd, p);

  const folderRows = state.folders
    .map((f) => ({
      folder: f,
      pane: paneByCwd.get(f.cwd) || null,
    }))
    .sort((a, b) => (b.folder.lastUsedAt || 0) - (a.folder.lastUsedAt || 0));

  if (folderRows.length) {
    const h = document.createElement('div');
    h.className = 'ws-section';
    h.textContent = 'sessions';
    list.appendChild(h);
    for (const { folder, pane } of folderRows) {
      list.appendChild(renderSessionFolderRow(folder, pane));
    }
  }
```

기존 `renderRow` 옆에 `renderSessionFolderRow` 신규 추가:

```js
function renderSessionFolderRow(folder, pane) {
  const el = document.createElement('div');
  const slot = pane ? slotOfPane(pane.id) : -1;
  const isActive = slot >= 0 && slot === state.activeSlot;
  el.className = 'ws' + (isActive ? ' active' : '');
  el.dataset.folderName = folder.name;
  el.dataset.kind = 'session-folder';
  if (pane) el.dataset.paneId = pane.id;

  let glyph, gkind, metaText;
  if (!pane) { glyph = '◇'; gkind = 'idle'; metaText = 'no PTY'; }
  else if (pane.dead) { glyph = '✗'; gkind = 'dead'; metaText = `exit ${pane.exitCode ?? '?'}`; }
  else { glyph = '◆'; gkind = 'session'; metaText = slot >= 0 ? (slot === 0 ? 'in slot L' : 'in slot R') : 'detached'; }

  const slotTag = slot >= 0 ? `<span class="ws-slot-tag">${slot === 0 ? 'L' : 'R'}</span>` : '';
  const name = folder.label || folder.name;
  const ageText = relativeTime(folder.lastUsedAt);

  el.innerHTML = `
    <span class="ws-glyph ${gkind}">${glyph}</span>
    ${slotTag}
    <span class="ws-rename-btn" data-act="rename" data-kind="session-folder" data-key="${escapeHtml(folder.name)}" title="Rename">${pencilSvg()}</span>
    <span class="ws-kebab-btn" data-act="kebab" data-key="${escapeHtml(folder.name)}" title="Actions">⋮</span>
    <div class="ws-name">${escapeHtml(name)}</div>
    <div class="ws-meta">${escapeHtml(metaText)}${folder.label ? ' · ' + escapeHtml(folder.name) : ''} · ${escapeHtml(ageText)}</div>
    <div class="ws-path">${escapeHtml(folder.cwd)}</div>
  `;

  el.addEventListener('click', async (e) => {
    if (e.target.closest('.ws-rename-btn') || e.target.closest('.ws-kebab-btn') || e.target.closest('.ws-rename-input')) return;
    if (pane && !pane.dead) {
      assignToSlot(pane.id);
    } else {
      // dead 폴더 클릭 → 새 PTY spawn
      await spawnSessionToFolder(folder.cwd);
    }
  });
  el.querySelector('.ws-rename-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    startRename(el, 'session-folder', folder.name, folder.label, folder.name);
  });
  el.querySelector('.ws-kebab-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openKebabMenu(folder, pane, el);
  });
  return el;
}

function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
```

(`spawnSessionToFolder`, `openKebabMenu` 는 Task 8/9 에서 정의 — 임시 stub 으로 console.log 만 작성)

```js
async function spawnSessionToFolder(cwd) {
  console.log('TODO: spawn session', cwd);
}
function openKebabMenu(folder, pane, anchorEl) {
  console.log('TODO: kebab menu', folder, pane);
}
```

- [ ] **Step 7.2** 서버 재시작 + 브라우저 새로고침 + manual 확인

```
1. workspace 에 session-* 폴더 몇 개 만들기 (이전 task 에서 만든 거 OK)
2. 사이드바 sessions 섹션에 폴더들이 라벨/메타와 함께 나타나는지 확인
3. 정렬: 최근 lastUsedAt 순 (위가 최근)
4. alive PTY 없는 폴더는 ◇ glyph + "no PTY" 메타
5. 클릭 시 spawn (현재 console.log 만)
```

- [ ] **Step 7.3** Commit

```bash
cd C:/Tools/tabterm
git add public/app.js
git commit -m "feat(ui): sidebar sessions renders disk folders with alive PTY join

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: dead 폴더 클릭 → POST cwd 흐름 완성 + 라벨 편집 분기

**목적:** Task 7 의 stub `spawnSessionToFolder` 실제 구현 + `startRename` 의 session-folder 분기 (API 만 다름).

**Files:**
- Modify: `C:/Tools/tabterm/public/app.js`

### Step 8.1: spawnSessionToFolder 구현

- [ ] **Step 8.1** stub 교체

```js
async function spawnSessionToFolder(cwd) {
  try {
    const r = await fetch('/api/sessions', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-tabterm-csrf': getCsrf(),
      },
      body: JSON.stringify({ kind: 'session', cwd, cols: 120, rows: 32 }),
    });
    if (r.status === 409) {
      const data = await r.json();
      const ok = window.confirm(`이 폴더에 다른 세션이 살아있습니다. 종료하고 새로 시작할까요?\n(${data.existing?.length || 0}개)`);
      if (!ok) return;
      const r2 = await fetch('/api/sessions', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-tabterm-csrf': getCsrf() },
        body: JSON.stringify({ kind: 'session', cwd, cols: 120, rows: 32, force: true }),
      });
      if (!r2.ok) throw new Error(`spawn force failed ${r2.status}`);
    } else if (!r.ok) {
      throw new Error(`spawn failed ${r.status}`);
    }
    await refreshAll();
  } catch (e) {
    console.error('[spawn] folder attach failed', e);
    alert(`세션 spawn 실패: ${e.message}`);
  }
}
```

(`getCsrf()` 가 기존 코드에 있는지 확인 — 보통 `document.cookie` 에서 추출. 없으면 기존 POST 요청 코드 패턴 그대로 차용.)

### Step 8.2: startRename 의 session-folder 분기

- [ ] **Step 8.2** 기존 startRename 함수 찾아서 (검색: `function startRename` 또는 `async function commitRename`) API 호출 분기 추가

기존 코드 (worker / session 분기):
```js
if (kind === 'worker') {
  url = `/api/labels/worker/${key}`;
  ...
} else {
  url = `/api/sessions/${key}/label`;
  ...
}
```

다음으로 확장 (session-folder 추가):
```js
let url, body;
if (kind === 'worker') {
  url = `/api/labels/worker/${key}`;
  body = JSON.stringify({ name: newLabel });
} else if (kind === 'session-folder') {
  url = `/api/sessions/folders/${encodeURIComponent(key)}/label`;
  body = JSON.stringify({ name: newLabel });
} else {
  // session (legacy: in-memory PtySession 라벨)
  url = `/api/sessions/${key}/label`;
  body = JSON.stringify({ name: newLabel });
}
```

- [ ] **Step 8.3** Manual 확인

```
1. 사이드바 sessions 섹션 폴더의 펜 아이콘 클릭 → 인라인 입력 나타남
2. "내 작업" 타이핑 후 Enter
3. tabterm.json 의 label 필드 갱신 확인
4. 페이지 새로고침 후 라벨 유지 확인
5. dead 폴더 (◇) 클릭 → 새 PTY spawn, 폴더 attach 확인
```

- [ ] **Step 8.4** Commit

```bash
cd C:/Tools/tabterm
git add public/app.js
git commit -m "feat(ui): folder click spawn + pencil edit for session folders

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 케밥 메뉴 + Kill / Delete 액션

**목적:** Task 7 의 stub `openKebabMenu` 실제 구현. Kill = 단일 confirm + PTY kill, Delete = 2단계 confirm + folder DELETE.

**Files:**
- Modify: `C:/Tools/tabterm/public/app.js`
- Modify: `C:/Tools/tabterm/public/styles.css`

### Step 9.1: 케밥 메뉴 스타일 추가

- [ ] **Step 9.1** styles.css 에 추가

```css
.ws-kebab-btn {
  cursor: pointer;
  user-select: none;
  font-size: 16px;
  line-height: 1;
  padding: 2px 4px;
  margin-left: 4px;
  opacity: 0.6;
}
.ws-kebab-btn:hover { opacity: 1; }
.ws-kebab-menu {
  position: absolute;
  background: var(--bg-2, #1e1e1e);
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 120px;
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.ws-kebab-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: none;
  color: var(--fg, #ddd);
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.ws-kebab-item:hover { background: var(--bg-3, #2a2a2a); }
.ws-kebab-item.danger { color: #e85a5a; }
.ws-kebab-item:disabled { opacity: 0.4; cursor: not-allowed; }
```

### Step 9.2: openKebabMenu 구현

- [ ] **Step 9.2** stub 교체

```js
function openKebabMenu(folder, pane, anchorEl) {
  // 기존 메뉴 있으면 닫기
  closeKebabMenu();
  const menu = document.createElement('div');
  menu.className = 'ws-kebab-menu';
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 2}px`;
  menu.style.left = `${rect.right - 120}px`;

  const killBtn = document.createElement('button');
  killBtn.className = 'ws-kebab-item';
  killBtn.textContent = 'Kill PTY';
  killBtn.disabled = !pane || pane.dead;
  killBtn.addEventListener('click', async () => {
    closeKebabMenu();
    if (!confirm('이 세션 PTY 를 종료할까요? 폴더와 라벨은 유지됩니다.')) return;
    await killSessionFolder(pane.id);
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'ws-kebab-item danger';
  delBtn.textContent = 'Delete folder…';
  delBtn.addEventListener('click', async () => {
    closeKebabMenu();
    await deleteSessionFolder(folder);
  });

  menu.appendChild(killBtn);
  menu.appendChild(delBtn);
  document.body.appendChild(menu);
  state.kebabMenu = menu;

  // 외부 클릭 시 닫기
  setTimeout(() => {
    document.addEventListener('click', closeKebabMenuOnce, { once: true, capture: true });
  }, 0);
}

function closeKebabMenuOnce(e) {
  if (state.kebabMenu && !state.kebabMenu.contains(e.target)) {
    closeKebabMenu();
  } else {
    // 메뉴 안 클릭 = 재등록
    document.addEventListener('click', closeKebabMenuOnce, { once: true, capture: true });
  }
}

function closeKebabMenu() {
  if (state.kebabMenu) {
    state.kebabMenu.remove();
    state.kebabMenu = null;
  }
}

async function killSessionFolder(paneId) {
  try {
    const r = await fetch(`/api/sessions/${paneId}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'x-tabterm-csrf': getCsrf() },
    });
    if (!r.ok) throw new Error(`kill failed ${r.status}`);
    await refreshAll();
  } catch (e) {
    alert(`PTY kill 실패: ${e.message}`);
  }
}

async function deleteSessionFolder(folder) {
  // 1차 alert
  const name = folder.label || folder.name;
  if (!confirm(`"${name}" 폴더를 완전히 삭제합니다.\n복구 불가. 폴더 안 모든 파일이 사라집니다.\n계속할까요?`)) return;
  // 2차 typing 검증
  const typed = window.prompt(`확인을 위해 폴더명을 정확히 입력하세요:\n${folder.name}`);
  if (typed !== folder.name) {
    alert('입력이 일치하지 않습니다. 삭제 취소.');
    return;
  }
  try {
    const r = await fetch(`/api/sessions/folders/${encodeURIComponent(folder.name)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'x-tabterm-csrf': getCsrf() },
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `delete failed ${r.status}`);
    }
    await refreshAll();
  } catch (e) {
    alert(`폴더 삭제 실패: ${e.message}`);
  }
}
```

- [ ] **Step 9.3** state.kebabMenu 초기화

state 객체에 추가:
```js
kebabMenu: null,
```

- [ ] **Step 9.4** Manual 확인

```
1. 사이드바 세션 행 ⋮ 클릭 → 메뉴 표시
2. Kill PTY: alive 일 때만 활성, 클릭 시 confirm → 폴더 행은 ◇ 로 변경
3. Delete folder…: 클릭 → 1차 confirm → 2차 prompt (폴더명 정확히 입력) → 폴더 자체 사라짐
4. 워커 행에는 ⋮ 안 나타남 확인
5. 폴더명 다르게 입력 시 삭제 취소 확인
```

- [ ] **Step 9.5** Commit

```bash
cd C:/Tools/tabterm
git add public/app.js public/styles.css
git commit -m "feat(ui): kebab menu with Kill / Delete actions for session folders

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 통합 시나리오 manual 검증

**목적:** spec §3, §4 의 모든 흐름이 end-to-end 동작 확인.

- [ ] **Step 10.1** 시나리오 1: 신규 세션 → 라벨 → 재시작 → 영속

```
1. + New session 클릭 → 폴더 생성 + ◆ alive
2. 펜 아이콘 → "my work" 라벨 → Enter
3. tabterm 서버 Ctrl+C → npm start 재시작
4. 브라우저 새로고침
5. 사이드바에 "my work" 라벨 + ◇ no PTY 로 나타남 확인
6. 클릭 → 같은 폴더 PTY spawn, ◆ alive
```

- [ ] **Step 10.2** 시나리오 2: legacy 폴더 (tabterm.json 없음) lazy migration

```
1. 수동으로 폴더 생성: mkdir C:/workspace/session-legacy-test
2. 브라우저 새로고침 → 사이드바에 "session-legacy-test" ◇ 로 나타남
3. 펜 아이콘 → "legacy" 라벨 → Enter
4. dir C:/workspace/session-legacy-test/tabterm.json → 파일 존재 확인
5. 또는 클릭으로 PTY spawn → tabterm.json 자동 작성 확인
```

- [ ] **Step 10.3** 시나리오 3: Kill / Delete 분리

```
1. 세션 ⋮ → Kill PTY → 행이 ◇ 로 변경, 폴더는 그대로
2. 같은 폴더 클릭 → 새 PTY spawn, ◆
3. ⋮ → Delete folder… → 1차 confirm 통과 → 2차 입력 정확
4. 사이드바에서 행 사라짐 + workspace 에 폴더 사라짐 확인
```

- [ ] **Step 10.4** 시나리오 4: 보안 (workers 보호)

```
1. DevTools 콘솔에서:
   fetch('/api/sessions/folders/worker-0', {
     method: 'DELETE', credentials: 'include',
     headers: { 'x-tabterm-csrf': document.cookie.match(/tabterm\.sid\.csrf=([^;]+)/)?.[1] }
   }).then(r => r.json()).then(console.log)
2. → {"error":"worker-folder-protected"} 응답 확인
3. C:/workspace/worker-0 그대로 존재 확인
```

- [ ] **Step 10.5** 시나리오 5: race condition (force=true)

```
1. 같은 폴더에 alive PTY 가 있는 상태에서 다른 탭/창에서 같은 cwd POST
2. 409 session-folder-busy 응답 확인
3. force: true 로 재시도 → 기존 PTY kill + 새 PTY spawn 확인
```

- [ ] **Step 10.6** 모든 시나리오 통과 시 Commit (검증 보고서)

```bash
cd C:/Tools/tabterm
# 검증 보고서를 docs 또는 session-reports 에 작성 후
git commit -m "test: manual verification of session folder persistence end-to-end

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: CHANGELOG + SW cache version bump

**Files:**
- Modify: `C:/Tools/tabterm/CHANGELOG.md`
- Modify: `C:/Tools/tabterm/package.json` (version)
- Modify: `C:/Tools/tabterm/public/sw.js` (VERSION 상수)

### Step 11.1: package.json version bump

- [ ] **Step 11.1** Edit `C:/Tools/tabterm/package.json` line 3:

```json
"version": "0.6.0",
```

### Step 11.2: CHANGELOG entry

- [ ] **Step 11.2** Prepend to `C:/Tools/tabterm/CHANGELOG.md`:

```markdown
## 0.6.0 — 2026-05-21

### Added
- `kind=session` 폴더를 영속 entity 로 승격
  - 각 폴더에 `tabterm.json` (label, createdAt, lastUsedAt, version) 영속
  - `GET /api/sessions/folders` — 디스크 폴더 enumerate
  - `POST /api/sessions { cwd }` — 기존 폴더에 attach (force 옵션 지원)
  - `PUT /api/sessions/folders/:name/label` — 라벨 영속 변경
  - `DELETE /api/sessions/folders/:name` — 폴더 자체 rm -rf
- 사이드바 sessions 섹션이 디스크 폴더 기반으로 렌더
  - lastUsedAt 내림차순 정렬
  - alive PTY 유무에 따라 ◆/◇/✗ glyph
  - 케밥(⋮) 메뉴: Kill PTY / Delete folder
- 폴더 라벨 인라인 편집 (워커 라벨 UX 와 동일 패턴)
- Legacy 폴더(`tabterm.json` 없는 session-*) 자동 인식 + 첫 라벨 편집/spawn 시 lazy migration

### Security
- `DELETE /api/sessions/folders/:name`:
  - path traversal 거부 (separator, `..`)
  - `worker-` prefix 폴더 403 보호
  - WORKERS_ROOT 하위 1단계만 허용

### Tests
- `server/session-folder.test.js` (helper unit)
- `server/folders-api.test.js` (enumerate + validate)
```

### Step 11.3: sw.js cache bump

- [ ] **Step 11.3** Edit `C:/Tools/tabterm/public/sw.js` — `VERSION` 상수를 다음으로 교체:

```js
const VERSION = 'tabterm-v11-session-folders';
```

(기존 값이 `tabterm-v10-rename-labels` 같은 패턴)

### Step 11.4: 최종 commit

- [ ] **Step 11.4** Commit

```bash
cd C:/Tools/tabterm
git add CHANGELOG.md package.json public/sw.js
git commit -m "chore: bump to 0.6.0, sw cache v11-session-folders, CHANGELOG

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final: Master merge 준비

- [ ] **모든 task 통과 + manual 검증 완료**
- [ ] git log 확인 — 11개 commit + spec commit = 12개 commit 정상
- [ ] 사용자에게 master merge 진행 의사 확인
  - `git checkout master && git merge --no-ff feat/session-folder-persistence`
  - 충돌 가능성: 거의 없음 (CHANGELOG 만 worker2 branch 작업 재개 시 잠재 risk, 본 PR 단독 merge 는 깨끗)
