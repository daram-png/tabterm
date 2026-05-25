/* global Terminal, FitAddon, Split */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let COOKIE_NAME = 'tabterm.sid';
function getCookie(name) {
  return document.cookie.split('; ').find((c) => c.startsWith(name + '='))?.slice(name.length + 1);
}
function csrfHeader() {
  const csrf = getCookie(`${COOKIE_NAME}.csrf`);
  return csrf ? { 'x-tabterm-csrf': csrf } : {};
}

async function api(path, init = {}) {
  const r = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(init.method && init.method !== 'GET' ? csrfHeader() : {}),
      ...(init.headers || {}),
    },
    ...init,
  });
  if (r.status === 401) { showAuth(); throw new Error('unauthorized'); }
  if (!r.ok) {
    let body = {};
    try { body = await r.json(); } catch {}
    const e = new Error(body.error || `${r.status}`);
    e.body = body;
    throw e;
  }
  return r.json();
}

/* ---------- auth ---------- */
async function checkAuth() {
  const s = await fetch('/api/auth/status').then((r) => r.json());
  if (s.cookieName) COOKIE_NAME = s.cookieName;
  if (!s.setup) {
    $('#auth-mode').textContent = 'setup (12+ chars)';
    $('#pw2').classList.remove('hidden');
    showAuth();
    return;
  }
  try {
    await api('/api/sessions');
    showApp();
  } catch {
    $('#auth-mode').textContent = 'login';
    $('#pw2').classList.add('hidden');
    showAuth();
  }
}
function showAuth() { $('#auth').classList.remove('hidden'); $('#app').classList.add('hidden'); }
function showApp() { $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden'); init(); }

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#auth-msg'); msg.textContent = '';
  const pw = $('#pw').value;
  try {
    const s = await fetch('/api/auth/status').then((r) => r.json());
    if (s.cookieName) COOKIE_NAME = s.cookieName;
    if (!s.setup) {
      if (pw !== $('#pw2').value) { msg.textContent = 'mismatch'; return; }
      const setupRes = await fetch('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      if (!setupRes.ok) {
        const body = await setupRes.json().catch(() => ({}));
        msg.textContent = `setup failed: ${body.error || setupRes.status}`;
        return;
      }
    }
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ password: pw }) });
    if (!r.ok) { msg.textContent = 'invalid or rate-limited'; return; }
    $('#pw').value = ''; $('#pw2').value = '';
    showApp();
  } catch (err) { msg.textContent = String(err.message || err); }
});

$('#btn-logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: csrfHeader() }).catch(() => {});
  location.reload();
});

/* ---------- toast ---------- */
function toast(text, kind = 'amber', autoDismiss = 5000) {
  const el = $('#toast');
  $('#toast-text').textContent = text;
  const p = $('#toast-pulse');
  p.classList.remove('ok', 'err');
  if (kind === 'ok') p.classList.add('ok');
  if (kind === 'err') p.classList.add('err');
  el.classList.remove('hidden');
  if (autoDismiss > 0) {
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), autoDismiss);
  }
}
$('#toast-dismiss').addEventListener('click', () => $('#toast').classList.add('hidden'));

/* ---------- state ---------- */
const state = {
  panes: [],            // all live PtySessions {id, sessionId, kind, workerIndex, label, cwd, term, fit, ws, cellEl, dead, exitCode}
  slots: [null, null],  // paneId shown in left / right slot
  slotCursor: 0,        // next slot for incoming pane (0 or 1)
  activeSlot: 0,
  workersCount: 8,
  workerPrefix: 'worker-',
  workersRoot: 'C:/workspace',
  preflightIssues: [],
  hydra: { enabled: true, ready: false },
  split: null,
  workerLabels: {},      // { "0": "pixiechess", ... } — from preflight + PUT responses
  editing: null,         // { kind, key, originalValue, defaultName, inputEl, wrapEl, rowEl, cancelled }
  folders: [],           // GET /api/sessions/folders 결과 (디스크 enumerate)
  foldersLoadedAt: 0,
  kebabMenu: null,
};

/* ---------- helpers ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function paneByWorker(idx) {
  return state.panes.find((p) => p.kind === 'worker' && p.workerIndex === idx);
}
function paneById(id) {
  return state.panes.find((p) => p.id === id);
}
function slotOfPane(id) {
  if (state.slots[0] === id) return 0;
  if (state.slots[1] === id) return 1;
  return -1;
}
function displayName(p) {
  if (!p) return '';
  if (p.kind === 'worker') {
    const custom = state.workerLabels[p.workerIndex];
    return custom || p.label;
  }
  return p.label;
}

/* ---------- inline rename ---------- */
const RENAME_MAX = 32;

function startRename(rowEl, kind, key, currentValue, defaultName) {
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
    setTimeout(() => {
      if (state.editing && !state.editing.cancelled) commitRename();
    }, 0);
  });

  nameEl.replaceWith(wrap);
  state.editing = {
    kind, key, originalValue: initial, defaultName,
    inputEl: input, wrapEl: wrap, rowEl, cancelled: false,
  };
  input.focus();
  input.select();
}

async function commitRename() {
  const ed = state.editing;
  if (!ed) return;
  if (ed.committing) return; // in-flight guard (Enter + blur double-fire)
  ed.committing = true;
  const input = ed.inputEl;
  input.disabled = true;
  ed.wrapEl.style.opacity = '0.6';

  let name = input.value;
  // Worker: if the value matches the default name (e.g. "worker-0"), treat as clear.
  // The prefill seeds the default to make minor edits easy; hitting Enter unchanged
  // should not persist the default as a custom label.
  const isWorkerNoop = ed.kind === 'worker' && name.trim() === ed.defaultName;
  if (isWorkerNoop) name = '';
  try {
    if (ed.kind === 'worker') {
      const r = await api(`/api/labels/worker/${ed.key}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });
      state.workerLabels = r.workers || {};
    } else if (ed.kind === 'session-folder') {
      if (name.trim() === '') {
        toast('rename: empty label not allowed for session folders', 'err');
        input.disabled = false;
        ed.wrapEl.style.opacity = '';
        ed.committing = false;
        input.focus();
        input.select();
        return;
      }
      await api(`/api/sessions/folders/${encodeURIComponent(ed.key)}/label`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });
      // Sync folder label into local state so sidebar reflects change immediately,
      // then refreshAll to pull authoritative server state.
      const folder = (state.folders || []).find((f) => f.name === ed.key);
      if (folder) folder.label = name;
    } else {
      if (name.trim() === '') {
        // Sessions don't support clearing → surface to the user instead of silent cancel.
        toast('rename: empty label not allowed for sessions', 'err');
        input.disabled = false;
        ed.wrapEl.style.opacity = '';
        ed.committing = false;
        input.focus();
        input.select();
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
    for (const p of state.panes) {
      if (!p.cellEl) continue;
      const nameSpan = p.cellEl.querySelector('.session-name');
      if (nameSpan) {
        const slot = slotOfPane(p.id);
        const slotLabel = slot === 0 ? 'slot L' : slot === 1 ? 'slot R' : '';
        nameSpan.innerHTML = `${escapeHtml(displayName(p))} <span class="ver">${escapeHtml(slotLabel)}</span>`;
      }
    }
    // session-folder: pull authoritative state from server (label persisted to tabterm.json)
    if (ed.kind === 'session-folder') refreshAll();
  } catch (e) {
    const msg = e?.body?.reason || e?.body?.error || e?.message || 'rename failed';
    toast(`rename: ${msg}`, 'err');
    input.disabled = false;
    ed.wrapEl.style.opacity = '';
    ed.committing = false;
    input.focus();
    input.select();
  }
}

function cancelRename() {
  const ed = state.editing;
  if (!ed) return;
  ed.cancelled = true;
  state.editing = null;
  renderSidebar();
}

/* ---------- slot routing ---------- */
function assignToSlot(paneId) {
  const existing = slotOfPane(paneId);
  if (existing >= 0) {
    state.activeSlot = existing;
  } else {
    const target = state.slotCursor;
    state.slots[target] = paneId;
    state.activeSlot = target;
    state.slotCursor = (state.slotCursor + 1) % 2;
  }
  buildLayout();
  renderSidebar();
  renderSlotStrip();
}

function detachFromSlots(paneId) {
  for (let i = 0; i < 2; i++) if (state.slots[i] === paneId) state.slots[i] = null;
}

/* ---------- sidebar ---------- */
function renderSidebar() {
  const ed = state.editing;
  const list = $('#sidebar-list');
  list.innerHTML = '';

  // dynamic sessions: 디스크 폴더 source + alive PTY join
  const sessionPanes = state.panes.filter((p) => p.kind === 'session');
  const paneByCwd = new Map();
  for (const p of sessionPanes) paneByCwd.set(p.cwd, p);

  const folderRows = (state.folders || [])
    .map((f) => ({
      folder: f,
      pane: paneByCwd.get(f.cwd) || null,
    }))
    .sort((a, b) => (b.folder.lastUsedAt || 0) - (a.folder.lastUsedAt || 0));

  if (folderRows.length) {
    const groups = { claude: [], opencode: [] };
    for (const row of folderRows) {
      const eng = row.folder.engine === 'opencode' ? 'opencode' : 'claude';
      groups[eng].push(row);
    }
    for (const eng of ['claude', 'opencode']) {
      if (groups[eng].length === 0) continue;
      const h = document.createElement('div');
      h.className = `ws-section ws-section-engine-${eng}`;
      h.textContent = `sessions · ${eng}`;
      list.appendChild(h);
      for (const { folder, pane } of groups[eng]) {
        list.appendChild(renderSessionFolderRow(folder, pane));
      }
    }
  }

  // header for workers
  const wh = document.createElement('div');
  wh.className = 'ws-section';
  wh.textContent = 'workers (ccx)';
  list.appendChild(wh);

  // workers (fixed 0..N)
  for (let i = 0; i < state.workersCount; i++) {
    const p = paneByWorker(i);
    list.appendChild(renderWorkerRow(i, p));
  }

  // Preserve in-progress rename across re-renders: re-attach live input to the
  // freshly rendered row so the user's input isn't destroyed.
  if (ed && !ed.cancelled) {
    let freshRow = null;
    if (ed.kind === 'worker') {
      freshRow = list.querySelector(`.ws[data-worker-index="${ed.key}"]`);
    } else {
      freshRow = list.querySelector(`.ws[data-pane-id="${CSS.escape(String(ed.key))}"]`);
    }
    if (freshRow) {
      const placeholder = freshRow.querySelector('.ws-name');
      if (placeholder) {
        placeholder.replaceWith(ed.wrapEl);
        ed.rowEl = freshRow;
        if (!ed.inputEl.disabled && document.activeElement !== ed.inputEl) {
          ed.inputEl.focus();
        }
      }
    }
  }
}

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
  const agePart = ageText ? ' · ' + escapeHtml(ageText) : '';

  el.title = folder.cwd;
  el.innerHTML = `
    <span class="ws-glyph ${gkind}">${glyph}</span>
    ${slotTag}
    <span class="ws-rename-btn" data-act="rename" data-kind="session-folder" data-key="${escapeHtml(folder.name)}" title="Rename">${pencilSvg()}</span>
    <span class="ws-kebab-btn" data-act="kebab" data-key="${escapeHtml(folder.name)}" title="Actions">⋮</span>
    <div class="ws-name">${escapeHtml(name)}</div>
    <div class="ws-meta">${escapeHtml(metaText)}${folder.label ? ' · ' + escapeHtml(folder.name) : ''}${agePart}</div>
  `;

  el.addEventListener('click', async (e) => {
    if (e.target.closest('.ws-rename-btn') || e.target.closest('.ws-kebab-btn') || e.target.closest('.ws-rename-input')) return;
    if (pane && !pane.dead) {
      assignToSlot(pane.id);
    } else {
      // dead 폴더 클릭 → 새 PTY spawn (Task 8 에서 실구현)
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

// POST /api/sessions, transparently handling 409 worker-session-exists.
// On 409 the user sees a confirm explaining that the telegram bot pairing
// will move to the new tab, and on accept we retry with force=true so the
// server evicts the old worker session + taskkill /F /T the stale bot.pid
// tree before spawning. Used by sidebar worker click and restartPane.
async function postNewSessionWithForceConfirm(body) {
  try {
    return await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e?.body?.error !== 'worker-session-exists') throw e;
    const count = e.body.existingCount || 0;
    const wIdx = e.body.workerIndex;
    const ok = window.confirm(
      `worker-${wIdx} 에 다른 세션이 ${count}개 살아있습니다.\n` +
      `텔레그램 봇 짝을 이 탭으로 옮기려면 기존 세션을 강제 종료해야 합니다.\n\n` +
      `종료하고 새로 시작할까요?`,
    );
    if (!ok) throw e;
    return await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ ...body, force: true }),
    });
  }
}

// POST /api/sessions for general (kind:'session') with cwd, handling 409
// session-folder-busy. Mirrors postNewSessionWithForceConfirm shape.
// Returns null on user-decline; throws on real failure. The evictedIds list
// surfaces the IDs the server told us it would kill so the caller can prune
// matching local panes — silent eviction otherwise leaks WS + xterm instances.
async function postSessionFolderWithBusyConfirm(body) {
  try {
    const response = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { response, evictedIds: [] };
  } catch (e) {
    if (e?.body?.error !== 'session-folder-busy') throw e;
    const existing = e.body.existing || [];
    const evictedIds = existing.map((s) => s.id).filter(Boolean);
    const ok = window.confirm(`이 폴더에 다른 세션이 ${existing.length}개 살아있습니다. 종료하고 진행할까요?`);
    if (!ok) return null;
    const response = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ ...body, force: true }),
    });
    return { response, evictedIds };
  }
}

// Drop local pane state (WS, xterm instance, slot) for the given session IDs.
// Called after the server force-evicts sessions so we don't leak orphan panes.
// Returns true if anything was pruned. Caller decides whether to re-render.
function prunePanesById(ids) {
  if (!ids?.length) return false;
  const stale = new Set(ids);
  let pruned = false;
  for (const p of state.panes) {
    if (!stale.has(p.sessionId)) continue;
    try { p.ws?.close(); } catch {}
    try { p.term?.dispose?.(); } catch {}
    detachFromSlots(p.id);
    pruned = true;
  }
  if (pruned) state.panes = state.panes.filter((p) => !stale.has(p.sessionId));
  return pruned;
}

async function spawnSessionToFolder(cwd) {
  try {
    const result = await postSessionFolderWithBusyConfirm({
      kind: 'session', cwd, cols: 120, rows: 32,
    });
    if (!result) return; // user declined the busy-folder confirm
    const { response, evictedIds } = result;
    // Drop local pane state for sessions the server just killed, otherwise
    // their dead WS + xterm linger and renderSidebar matches them by cwd.
    prunePanesById(evictedIds);
    // Promote the new session straight into a slot so user sees the terminal
    // immediately — one click attaches + spawns. fetchFolders refreshes
    // lastUsedAt so sidebar order reflects the activity.
    const newId = response?.session?.id;
    if (newId && !paneById(newId)) addPaneFromServer(response.session);
    await fetchFolders();
    if (newId) assignToSlot(newId);
    else renderSidebar();
  } catch (e) {
    console.error('[spawn] folder attach failed', e);
    alert(`세션 spawn 실패: ${e.message}`);
  }
}

function openKebabMenu(folder, pane, anchorEl) {
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

  const filesBtn = document.createElement('button');
  filesBtn.className = 'ws-kebab-item';
  filesBtn.textContent = 'Open files…';
  filesBtn.addEventListener('click', () => {
    closeKebabMenu();
    openFileExplorer(folder);
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'ws-kebab-item danger';
  delBtn.textContent = 'Delete folder…';
  delBtn.addEventListener('click', async () => {
    closeKebabMenu();
    await deleteSessionFolder(folder);
  });

  menu.appendChild(killBtn);
  menu.appendChild(filesBtn);
  menu.appendChild(delBtn);
  document.body.appendChild(menu);
  state.kebabMenu = menu;

  setTimeout(() => {
    document.addEventListener('click', closeKebabMenuOnce, { once: true, capture: true });
  }, 0);
}

function closeKebabMenuOnce(e) {
  if (state.kebabMenu && !state.kebabMenu.contains(e.target)) {
    closeKebabMenu();
  } else {
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
      credentials: 'same-origin',
      headers: csrfHeader(),
    });
    if (!r.ok) throw new Error(`kill failed ${r.status}`);
    await refreshAll();
  } catch (e) {
    alert(`PTY kill 실패: ${e.message}`);
  }
}

async function deleteSessionFolder(folder) {
  const name = folder.label || folder.name;
  if (!confirm(`"${name}" 폴더를 완전히 삭제합니다.\n복구 불가. 폴더 안 모든 파일이 사라집니다.\n계속할까요?`)) return;
  const typed = window.prompt(`확인을 위해 폴더명을 정확히 입력하세요:\n${folder.name}`);
  if (typed !== folder.name) {
    alert('입력이 일치하지 않습니다. 삭제 취소.');
    return;
  }
  try {
    const r = await fetch(`/api/sessions/folders/${encodeURIComponent(folder.name)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: csrfHeader(),
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
      const r = await postNewSessionWithForceConfirm({
        kind: 'worker', workerIndex: i, cols: 120, rows: 32,
      });
      addPaneFromServer(r.session);
      assignToSlot(r.session.id);
    } catch (err) {
      if (err?.body?.error === 'worker-session-exists') return; // user declined confirm
      toast(`spawn failed: ${err.message || err}`, 'err');
    }
  });
  el.querySelector('.ws-rename-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    // Spec §3.3: prefill with current custom label, or fall back to the default name.
    startRename(el, 'worker', i, customLabel || defaultName, defaultName);
  });
  return el;
}

/* ---------- slot strip (toolbar) ---------- */
function renderSlotStrip() {
  for (let i = 0; i < 2; i++) {
    const chip = $(`#slot-chip-${i}`);
    const pid = state.slots[i];
    const p = pid ? paneById(pid) : null;
    chip.classList.toggle('focused', i === state.activeSlot && !!pid);
    chip.classList.toggle('empty', !pid);
    chip.querySelector('.slot-label').textContent = p ? displayName(p) : 'empty';
    chip.onclick = pid ? () => { state.activeSlot = i; renderSidebar(); renderSlotStrip(); focusActivePane(paneById(pid)); } : null;
  }
}

/* ---------- terminal ---------- */
function makeTerm() {
  const term = new Terminal({
    fontFamily: '"Geist Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: '#0a0a0a', foreground: '#ededed', cursor: '#5b8ef7', cursorAccent: '#0a0a0a',
      selectionBackground: '#1d4ed8',
      black: '#0a0a0a', red: '#f87171', green: '#4ade80', yellow: '#f59e0b',
      blue: '#5b8ef7', magenta: '#c084fc', cyan: '#67e8f9', white: '#ededed',
      brightBlack: '#737373', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fcd34d',
      brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#a5f3fc', brightWhite: '#ffffff',
    },
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

function paneHtml(p, slotLabel) {
  return `
    <div class="pane-focus-bar"></div>
    <div class="session-header">
      <div class="session-icon">${claudeMascotSvg(32)}</div>
      <div class="session-meta">
        <div class="session-name">${escapeHtml(displayName(p))} <span class="ver">${slotLabel}</span></div>
        <div class="session-sub">${p.kind === 'worker' ? 'ccx hybrid' : 'general session'}<span class="sep">·</span><span class="session-path">${escapeHtml(p.cwd || '')}</span></div>
      </div>
      <div class="session-tools">
        <div class="btn" title="Soft stop (Ctrl+C)" data-act="soft">⏸</div>
        <div class="btn" title="Restart" data-act="restart">↻</div>
        <div class="btn" title="Detach (keep PTY alive)" data-act="detach">⤓</div>
        <div class="btn" title="Close session" data-act="close">✕</div>
      </div>
    </div>
    <div class="terminal"></div>
    <div class="statusbar">
      <span class="sb-path">${escapeHtml(p.cwd || '')}</span>
      <span class="pipe">|</span>
      <span class="sb-model">${p.kind === 'worker' ? 'ccx · Opus 4.7' : 'general'}</span>
      <span class="sb-spacer"></span>
      <span class="sb-right"><span class="dot ${p.dead ? 'dead' : ''}"></span>${p.dead ? `exit ${p.exitCode ?? '?'}` : 'attached'}</span>
    </div>
  `;
}

function pencilSvg() {
  return `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5 L13.5 4.5 L5 13 L2.5 13.5 L3 11 Z"/><path d="M10 4 L12 6"/></svg>`;
}

function claudeMascotSvg(size) {
  const grid = ['00011000001100','00111110011110','00111110011110','01111111111111',
    '11111111111111','11111111111111','11122111112211','11122111112211',
    '11111111111111','11111111111111','11111111111111','01101011001100'];
  const COLORS = { 1: '#e87a52', 2: '#0b0b0b' };
  const cols = grid[0].length, rows = grid.length;
  let cells = '';
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const v = grid[y][x];
    if (v === '0') continue;
    cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="${COLORS[v]}"/>`;
  }
  return `<svg width="${size}" height="${size * rows / cols}" viewBox="0 0 ${cols} ${rows}" shape-rendering="crispEdges">${cells}</svg>`;
}

/* ---------- layout ---------- */
function buildLayout() {
  if (state.split) { try { state.split.destroy(); } catch {} state.split = null; }
  const root = $('#workspace');
  root.innerHTML = '';

  const filled = state.slots.map((id, i) => id ? { id, idx: i, pane: paneById(id) } : null).filter(Boolean);
  if (!filled.length) {
    root.innerHTML = '<div class="empty-state" style="margin:auto; color:var(--muted); font-family:Geist Mono, monospace; font-size:12px;">no session in any slot — click a worker on the left, or "New session"</div>';
    renderSlotStrip();
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'split row';
  root.appendChild(wrap);

  for (const { id, idx, pane } of filled) {
    if (!pane) continue;
    const cell = document.createElement('div');
    cell.className = 'pane' + (idx === state.activeSlot ? ' focused' : '');
    cell.dataset.paneId = id;
    cell.innerHTML = paneHtml(pane, idx === 0 ? 'slot L' : 'slot R');
    cell.addEventListener('mousedown', () => {
      state.activeSlot = idx;
      renderSidebar();
      renderSlotStrip();
      for (const c of root.querySelectorAll('.pane')) c.classList.toggle('focused', c.dataset.paneId === id);
    });
    cell.querySelectorAll('.session-tools .btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'soft') sendWs(pane, { type: 'signal', name: 'SIGINT' });
        else if (act === 'restart') restartPane(pane.id);
        else if (act === 'detach') { detachFromSlots(pane.id); buildLayout(); renderSidebar(); renderSlotStrip(); }
        else if (act === 'close') closePane(pane.id);
      });
    });
    wrap.appendChild(cell);
    pane.cellEl = cell;
  }

  if (filled.length > 1) {
    state.split = Split([...wrap.children], {
      sizes: [50, 50], minSize: 200, gutterSize: 1, direction: 'horizontal',
      onDragEnd: () => filled.forEach(({ pane }) => fitPane(pane)),
    });
  }

  for (const { pane } of filled) {
    const host = pane.cellEl.querySelector('.terminal');
    if (!pane.term._opened) { pane.term.open(host); pane.term._opened = true; }
    else { host.appendChild(pane.term.element); }
    fitPane(pane);
  }

  renderSlotStrip();
  const activePane = paneById(state.slots[state.activeSlot]);
  focusActivePane(activePane);
  $('#wc-title-text').textContent = activePane ? `tabterm — ${displayName(activePane)}` : 'tabterm';
}

// On iOS we never want focus on xterm's helper textarea (broken IME path);
// redirect to the rail textarea so Hangul composition stays inside it.
function focusActivePane(pane) {
  // Do not steal focus from an in-progress rename input.
  if (state.editing && !state.editing.cancelled) return;
  if (document.body.classList.contains('ios-ime')) {
    document.getElementById('ime-input')?.focus();
    return;
  }
  pane?.term?.focus();
}

function fitPane(p) {
  if (!p?.fit || !p.cellEl?.isConnected) return;
  try { p.fit.fit(); } catch {}
  const { cols, rows } = p.term;
  sendWs(p, { type: 'resize', cols, rows });
}

/* ---------- ws ---------- */
function sendWs(p, obj) {
  if (p?.ws?.readyState === 1) p.ws.send(JSON.stringify(obj));
}

function openWs(p) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/pty?sessionId=${encodeURIComponent(p.sessionId)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  p.ws = ws;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  ws.addEventListener('open', () => fitPane(p));
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'exit') {
          p.dead = true;
          p.exitCode = msg.code;
          p.term.write(`\r\n\x1b[33m[exit ${msg.code ?? '?'}]  ↻ to restart\x1b[0m\r\n`);
          renderSidebar();
          if (p.cellEl) {
            const sb = p.cellEl.querySelector('.statusbar .sb-right');
            if (sb) sb.innerHTML = `<span class="dot dead"></span>exit ${msg.code ?? '?'}`;
          }
        }
      } catch {}
    } else {
      try { p.term.write(decoder.decode(new Uint8Array(ev.data), { stream: true })); } catch {}
    }
  });
  ws.addEventListener('close', () => {
    try {
      const tail = decoder.decode();
      if (tail) p.term.write(tail);
    } catch {}
    p.term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');
  });
  p.term.onData((d) => sendWs(p, { type: 'input', data: d }));
}

/* ---------- pane lifecycle ---------- */
function addPaneFromServer(session) {
  const { term, fit } = makeTerm();
  const p = {
    id: session.id,
    sessionId: session.id,
    kind: session.kind || 'worker',
    workerIndex: session.workerIndex ?? null,
    engine: session.engine || null,
    label: session.label,
    cwd: session.cwd,
    term, fit,
    ws: null, cellEl: null,
    dead: !session.alive,
    exitCode: session.exitCode,
  };
  state.panes.push(p);
  openWs(p);
  return p;
}

async function closePane(id) {
  const p = paneById(id);
  if (!p) return;
  try { p.ws?.close(); } catch {}
  try { await api(`/api/sessions/${id}`, { method: 'DELETE' }); } catch {}
  detachFromSlots(id);
  state.panes = state.panes.filter((x) => x.id !== id);
  buildLayout();
  renderSidebar();
  renderSlotStrip();
}

async function restartPane(id) {
  const p = paneById(id);
  if (!p) return;
  const kind = p.kind;
  const idx = p.workerIndex;
  // Preserve engine across restart so OpenCode session re-launches as OpenCode.
  // Session restart re-attaches to the SAME folder (cwd preserved). Default
  // body has no force=true — closePane awaits PTY exit, so the common path
  // succeeds without prompt. If the server returns 409 session-folder-busy,
  // that means an unrelated alive session exists at the same cwd (other browser,
  // stale client, external trigger): the helper surfaces a confirm before
  // force-evicting, avoiding silent eviction.
  const engine = p.engine || undefined;
  const cwd = p.cwd;
  await closePane(id);
  try {
    const body = kind === 'worker'
      ? { kind: 'worker', workerIndex: idx, cols: 120, rows: 32 }
      : { kind: 'session', engine, cwd, cols: 120, rows: 32 };
    let response;
    let evictedIds = [];
    if (kind === 'worker') {
      response = await postNewSessionWithForceConfirm(body);
    } else {
      const result = await postSessionFolderWithBusyConfirm(body);
      if (!result) return; // user declined the busy-folder confirm
      ({ response, evictedIds } = result);
      prunePanesById(evictedIds);
    }
    addPaneFromServer(response.session);
    assignToSlot(response.session.id);
    if (kind === 'session') {
      // lastUsedAt bumped on the server; pull fresh folder list so sidebar
      // order/timestamp reflects the restart.
      await fetchFolders();
      renderSidebar();
    }
  } catch (err) {
    if (err?.body?.error === 'worker-session-exists') return; // user declined confirm
    toast(`restart failed: ${err.message || err}`, 'err');
  }
}

/* ---------- new session (engine = claude | opencode) ---------- */
async function createSession(engine) {
  try {
    const r = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ kind: 'session', engine, cols: 120, rows: 32 }),
    });
    addPaneFromServer(r.session);
    assignToSlot(r.session.id);
    // The server creates a new folder on disk; pull it into state.folders so
    // the sidebar shows the new session immediately instead of waiting for a
    // page reload. renderSidebar must run after fetchFolders to pick it up.
    await fetchFolders();
    renderSidebar();
    toast(`new ${engine} session: ${r.session.label}`, 'ok', 3000);
  } catch (err) {
    toast(`new ${engine} session failed: ${err.message || err}`, 'err');
  }
}
$('#btn-new-claude').addEventListener('click', () => createSession('claude'));
$('#btn-new-opencode').addEventListener('click', () => createSession('opencode'));

/* ---------- top buttons ---------- */
$('#btn-soft-stop').addEventListener('click', () => {
  const id = state.slots[state.activeSlot];
  sendWs(paneById(id), { type: 'signal', name: 'SIGINT' });
});
$('#btn-kill').addEventListener('click', () => {
  const id = state.slots[state.activeSlot];
  if (id && confirm('현재 슬롯의 세션을 강제 종료할까요?')) closePane(id);
});
$('#btn-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('collapsed'));
$('#btn-hydra-recheck').addEventListener('click', async () => {
  toast('checking HydraTeams...', 'amber', 2000);
  try {
    const r = await api('/api/hydra/ensure', { method: 'POST' });
    if (r.skipped) toast('hydra disabled', 'amber');
    else if (r.ready) toast('HydraTeams ready', 'ok');
    else toast('HydraTeams NOT ready', 'err', 8000);
  } catch (e) { toast(`hydra check failed: ${e.message || e}`, 'err'); }
});

/* ---------- system actions (boot-all / cleanup / watchdog status) ---------- */
$('#btn-boot-all').addEventListener('click', async () => {
  if (!confirm(`Boot all ${state.workersCount} workers? Already-running slots are skipped.`)) return;
  toast(`booting ${state.workersCount} workers...`, 'amber', 0);
  try {
    const r = await api('/api/system/boot-all', { method: 'POST', body: JSON.stringify({}) });
    const msg = `boot-all: spawned ${r.spawned.length}, skipped ${r.skipped.length}, failed ${r.failed.length}`;
    toast(msg, r.failed.length ? 'err' : 'ok', 6000);
    // Refresh session list so new workers appear in sidebar/slots
    try {
      const cur = await api('/api/sessions');
      for (const s of (cur.sessions || [])) {
        if (!paneById(s.id)) addPaneFromServer(s);
      }
      renderSidebar();
    } catch (e) {
      console.warn('session refresh after boot-all failed:', e);
      toast('boot-all succeeded but session list refresh failed — reload to see new workers', 'amber', 6000);
    }
  } catch (e) {
    toast(`boot-all failed: ${e.message || e}`, 'err');
  }
});

$('#btn-cleanup-zombies').addEventListener('click', async () => {
  if (!confirm(
    'Kill all stale bun/claude/node processes outside tabterm/watchdog/active PTYs?\n\n' +
    '보호: 현재 tabterm 인스턴스 + 자식 와치독 + 살아있는 세션 PTY 트리 전체.\n' +
    '주의 1: 이전 tabterm 세션이 남긴 claude.exe (이번 인스턴스에 attach 안 된 것) 는 보호 대상 아님 — 같이 죽음.\n' +
    '주의 2: 외부 node/bun 프로세스 (e.g. dev server, 다른 도구) 도 트리 밖이면 죽음.'
  )) return;
  toast('cleaning zombies...', 'amber', 2000);
  try {
    const r = await api('/api/system/cleanup-zombies', { method: 'POST', body: JSON.stringify({}) });
    const msg = `killed ${r.killed.length}, failed ${r.failed.length}, protected ${r.protectedPids.length}`;
    toast(msg, r.failed.length ? 'err' : 'ok', 6000);
  } catch (e) {
    toast(`cleanup failed: ${e.message || e}`, 'err');
  }
});

$('#btn-wd-status').addEventListener('click', async () => {
  await refreshWatchdog({ openModal: true });
});
$('#btn-wd-modal-close').addEventListener('click', () => $('#wd-modal').classList.add('hidden'));
$('#wd-modal').addEventListener('click', (e) => {
  if (e.target.id === 'wd-modal') $('#wd-modal').classList.add('hidden');
});

function paintWatchdogDot(dotState) {
  // dotState shadowed the module-level `state` object before; renamed to
  // prevent future edits from accidentally reading the parameter.
  const dot = $('#wd-dot');
  if (!dot) return;
  dot.dataset.state = dotState || 'unknown';
}

function fmtAge(ms) {
  if (ms == null || !isFinite(ms)) return '–';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

async function refreshWatchdog({ openModal = false } = {}) {
  try {
    const r = await api('/api/system/watchdog-status');
    const wd = r.watchdog || {};
    const health = wd.health || {};
    paintWatchdogDot(health.status);

    if (openModal) {
      const hydraLive = r.hydra?.live;
      const summary = $('#wd-summary');
      const rows = [
        ['status', health.status || 'unknown', stateClass(health.status)],
        ['log age', fmtAge(health.ageMs), health.ageMs != null && health.ageMs > 90_000 ? 'warn' : 'ok'],
        ['pid (child)', wd.pid != null ? String(wd.pid) : 'not running', wd.pid ? 'ok' : 'warn'],
        ['autostart', String(wd.autostart), 'v'],
        ['script', wd.scriptPath || '', 'v'],
        ['config', wd.configPath || '', 'v'],
        ['log', wd.logPath || '', 'v'],
        ['hydra', hydraLive ? (hydraLive.ok ? 'ok' : 'down') : 'unknown', hydraLive?.ok ? 'ok' : 'err'],
      ];
      summary.innerHTML = rows.map(([k, v, klass]) =>
        `<div class="k">${escapeHtml(k)}</div><div class="v ${klass === 'ok' ? 'ok' : klass === 'warn' ? 'warn' : klass === 'err' ? 'err' : ''}">${escapeHtml(String(v))}</div>`
      ).join('');
      $('#wd-log').textContent = (r.logTail || []).join('\n') || '(empty)';
      $('#wd-modal').classList.remove('hidden');
    }
  } catch (e) {
    paintWatchdogDot('unknown');
    if (openModal) {
      $('#wd-summary').innerHTML = `<div class="k">error</div><div class="v err">${escapeHtml(String(e.message || e))}</div>`;
      $('#wd-log').textContent = '';
      $('#wd-modal').classList.remove('hidden');
    }
  }
}

function stateClass(s) {
  if (s === 'healthy') return 'ok';
  if (s === 'degraded') return 'warn';
  if (s === 'dead') return 'err';
  return '';
}

/* ---------- resize ---------- */
let resizeTimer;
function scheduleFitAll() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const id of state.slots) {
      const p = id && paneById(id);
      if (p) fitPane(p);
    }
  }, 100);
}
window.addEventListener('resize', scheduleFitAll);
if (window.visualViewport) {
  const vv = window.visualViewport;
  vv.addEventListener('resize', () => {
    // Desktop pinch/page zoom also fires visualViewport.resize and would
    // otherwise mutate kbd-spacer/--kbd-offset for non-iOS users. Gate to iOS.
    if (document.body.classList.contains('ios-ime')) {
      const offset = window.innerHeight - vv.height;
      $('#kbd-spacer').style.height = offset > 0 ? `${offset}px` : '0';
      document.documentElement.style.setProperty('--kbd-offset', offset > 0 ? `${offset}px` : '0px');
    }
    scheduleFitAll();
  });
}

/* ---------- iOS IME input rail ---------- */
function isIPadLike() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports MacIntel + maxTouchPoints > 1
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

// Pane locked in at composition start so a mid-typing slot click does not
// re-route the buffered Hangul to the newly focused pane.
let imeTargetPaneId = null;

function getActivePane() {
  return paneById(state.slots[state.activeSlot]);
}

function rememberImeTarget() {
  const p = getActivePane();
  if (p) imeTargetPaneId = p.id;
}

function imeSendData(data) {
  if (!data) return;
  const p = (imeTargetPaneId && paneById(imeTargetPaneId)) || getActivePane();
  if (!p) return;
  sendWs(p, { type: 'input', data });
}

const IME_KEYMAP = {
  esc: '\x1b',
  tab: '\t',
  'ctrl-c': '\x03',
  bs: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
};

function initImeBar() {
  if (!isIPadLike()) return;
  if (document.body.classList.contains('ios-ime')) return; // idempotent
  document.body.classList.add('ios-ime');

  const input = $('#ime-input');
  const send = $('#ime-send');
  if (!input || !send) return;

  // flush() is the safer default — commits textarea contents to PTY without
  // submitting. flushImeText(true) is the explicit-submit path (Enter key,
  // Send button): it appends \r so the PTY's claude/opencode prompt actually
  // submits instead of just receiving the text and waiting. Empty textarea +
  // withEnter sends a bare \r so the user can submit an already-populated
  // native prompt with just the rail's Send button.
  function flush() {
    return flushImeText(false);
  }

  function flushImeText(withEnter = false) {
    const v = input.value;
    if (!v && !withEnter) return;
    if (v) imeSendData(v);
    if (withEnter) imeSendData('\r');
    input.value = '';
    imeTargetPaneId = null;
  }

  // Lock the target pane the moment the user starts interacting with the rail.
  input.addEventListener('focus', rememberImeTarget);
  input.addEventListener('compositionstart', rememberImeTarget);
  input.addEventListener('input', () => {
    if (!imeTargetPaneId) rememberImeTarget();
  });

  // Enter (no shift) -> flush text + \r; Shift+Enter -> textarea newline.
  // Guard against IME composition: e.isComposing or keyCode 229 means the
  // Korean keyboard is still committing — let it commit first, then user
  // can press Enter again.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    flushImeText(true);
  });
  // Safety net: if compositionend never fires (rare iOS keyboards), blur flushes
  // text only — no \r, since blur is not an explicit submit signal.
  input.addEventListener('blur', () => {
    if (input.value) flush();
  });

  send.addEventListener('click', () => {
    rememberImeTarget();
    flushImeText(true);
  });

  // Auxiliary key buttons
  $$('.ime-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      const seq = IME_KEYMAP[btn.dataset.key];
      if (!seq) return;
      // Flush any pending textarea content (to the locked target) first,
      // then send the control sequence to the *current* active pane.
      if (input.value) flush();
      const cur = getActivePane();
      if (cur) sendWs(cur, { type: 'input', data: seq });
    });
  });

  // Tapping anywhere in workspace re-focuses the input (xterm helper is blocked)
  document.getElementById('workspace')?.addEventListener('click', (e) => {
    if (e.target.closest('.ime-bar')) return;
    input.focus();
  });
}

/* ---------- folders fetch ---------- */
async function fetchFolders() {
  try {
    const r = await fetch('/api/sessions/folders', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`folders fetch ${r.status}`);
    const j = await r.json();
    state.folders = j.folders || [];
    state.foldersLoadedAt = Date.now();
  } catch (e) {
    console.warn('[folders] fetch failed', e);
  }
}

async function refreshAll() {
  // Fetch live sessions and disk folders in parallel, then re-render sidebar.
  // Sessions are fetched inline in init(); this helper is for subsequent refreshes
  // triggered by folder mutations (POST/PUT/DELETE folder) in Tasks 7-9.
  //
  // Also reconciles state.panes against the server: session-kind panes whose
  // server session disappeared (e.g. after folder delete) are pruned. Without
  // this the WebSocket and xterm instances stay alive and leak memory.
  let prunedSlots = false;
  await Promise.all([
    (async () => {
      try {
        const cur = await api('/api/sessions');
        const serverIds = new Set((cur.sessions || []).map((s) => s.id));
        for (const s of (cur.sessions || [])) {
          if (!paneById(s.id)) addPaneFromServer(s);
        }
        // Prune only 'session' kind. worker/general kinds use restart UX so
        // their dead panes stay visible for user-initiated respawn.
        const stale = state.panes.filter(
          (p) => p.kind === 'session' && !serverIds.has(p.sessionId),
        );
        for (const p of stale) {
          try { p.ws?.close(); } catch {}
          try { p.term?.dispose?.(); } catch {}
          detachFromSlots(p.id);
          prunedSlots = true;
        }
        if (stale.length) {
          const staleIds = new Set(stale.map((p) => p.id));
          state.panes = state.panes.filter((p) => !staleIds.has(p.id));
        }
      } catch (e) { console.warn('[refreshAll] sessions fetch failed', e); }
    })(),
    fetchFolders(),
  ]);
  if (prunedSlots) { buildLayout(); renderSlotStrip(); }
  renderSidebar();
}

/* ---------- init ---------- */
async function init() {
  try {
    const pre = await api('/api/preflight');
    state.workersCount = pre.workersCount || 8;
    state.workerPrefix = pre.workerPrefix || 'worker-';
    state.workersRoot = pre.workersRoot || 'C:/workspace';
    state.preflightIssues = pre.issues || [];
    state.hydra = pre.hydra || { enabled: false, ready: false };
    if (state.hydra.enabled) {
      if (state.hydra.ready) toast('HydraTeams ready', 'ok', 3000);
      else toast('HydraTeams NOT ready — workers may fail', 'err', 0);
    }
    state.workerLabels = pre.workerLabels || {};
    if (pre.labelsHealth && pre.labelsHealth !== 'ok') {
      toast(`labels: ${pre.labelsHealth}`, pre.labelsHealth === 'corrupted_reset' ? 'err' : 'amber', 6000);
    }
  } catch (e) { console.error(e); }

  await Promise.all([
    (async () => {
      try {
        const cur = await api('/api/sessions');
        if (cur.sessions?.length) {
          for (const s of cur.sessions) addPaneFromServer(s);
          // restore first up to 2 into slots
          const live = state.panes.slice(0, 2);
          if (live[0]) { state.slots[0] = live[0].id; state.activeSlot = 0; state.slotCursor = 1; }
          if (live[1]) { state.slots[1] = live[1].id; state.slotCursor = 0; }
        }
      } catch (e) { console.error(e); }
    })(),
    fetchFolders(),
  ]);

  buildLayout();
  renderSidebar();
  renderSlotStrip();

  // watchdog status: initial fetch + 30s polling
  refreshWatchdog();
  setInterval(refreshWatchdog, 30_000);

  // iOS IME rail (no-op on non-iPad)
  initImeBar();
}

/* ---------- file explorer (Phase 1: read-only viewer) ---------- */

const fxState = {
  open: false,
  folderName: null,
  rootPath: '',
  currentPath: '',
  entriesByPath: new Map(),
  expanded: new Set(),
  selected: null,
  detail: { kind: 'empty' },
  loading: false,
  error: null,
  previewUrl: null,
};

function openFileExplorer(folder) {
  fxState.open = true;
  fxState.folderName = folder.name;
  fxState.rootPath = folder.cwd || '';
  fxState.currentPath = '';
  fxState.entriesByPath = new Map();
  fxState.expanded = new Set();
  fxState.selected = null;
  fxState.detail = { kind: 'empty' };
  fxState.error = null;
  fxRevokePreviewUrl();
  const modal = $('#fx-modal');
  modal.hidden = false;
  modal.classList.remove('hidden');
  document.addEventListener('keydown', fxOnKeyDown);
  $('#fx-close').onclick = closeFileExplorer;
  fxRender();
  void fxLoadList('');
}

function closeFileExplorer() {
  fxState.open = false;
  fxRevokePreviewUrl();
  document.removeEventListener('keydown', fxOnKeyDown);
  const modal = $('#fx-modal');
  modal.classList.add('hidden');
  modal.hidden = true;
}

function fxOnKeyDown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFileExplorer();
  }
}

function fxRevokePreviewUrl() {
  if (fxState.previewUrl) {
    URL.revokeObjectURL(fxState.previewUrl);
    fxState.previewUrl = null;
  }
}

async function fxApiGet(op, path) {
  const url = `/api/sessions/folders/${encodeURIComponent(fxState.folderName)}/fs/${op}` +
    (path != null ? `?path=${encodeURIComponent(path)}` : '');
  return api(url);
}

async function fxLoadList(path) {
  fxState.loading = true;
  fxState.error = null;
  fxRender();
  try {
    const r = await fxApiGet('list', path);
    fxState.entriesByPath.set(r.path, r.entries);
    if (r.truncated) {
      fxState.error = `listing truncated (more than ${r.entries.length} entries)`;
    }
    fxState.currentPath = r.path;
    if (r.rootPath) fxState.rootPath = r.rootPath;
  } catch (e) {
    fxState.error = `list failed: ${e.message}`;
  } finally {
    fxState.loading = false;
    fxRender();
  }
}

async function fxLoadRead(file) {
  fxState.loading = true;
  fxState.error = null;
  fxRevokePreviewUrl();
  fxRender();
  try {
    const r = await fxApiGet('read', file.path);
    fxState.detail = { kind: 'text', file, content: r.content, language: r.language, version: r.version };
  } catch (e) {
    fxState.error = `read failed: ${e.message}`;
    fxState.detail = { kind: 'empty' };
  } finally {
    fxState.loading = false;
    fxRender();
  }
}

async function fxLoadPreview(file, previewKind) {
  fxState.loading = true;
  fxState.error = null;
  fxRevokePreviewUrl();
  fxRender();
  try {
    const url = `/api/sessions/folders/${encodeURIComponent(fxState.folderName)}/fs/preview?path=${encodeURIComponent(file.path)}`;
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) {
      let body = {};
      try { body = await r.json(); } catch {}
      throw new Error(body.error || `${r.status}`);
    }
    const blob = await r.blob();
    fxState.previewUrl = URL.createObjectURL(blob);
    fxState.detail = { kind: 'preview', file, previewKind, url: fxState.previewUrl };
  } catch (e) {
    fxState.error = `preview failed: ${e.message}`;
    fxState.detail = { kind: 'empty' };
  } finally {
    fxState.loading = false;
    fxRender();
  }
}

async function fxSelectEntry(file) {
  fxState.selected = file.path;
  fxState.error = null;
  if (file.kind === 'directory') {
    if (fxState.expanded.has(file.path)) {
      fxState.expanded.delete(file.path);
      fxRender();
    } else {
      fxState.expanded.add(file.path);
      fxRender();
      if (!fxState.entriesByPath.has(file.path)) {
        await fxLoadList(file.path);
      }
    }
    return;
  }
  if (file.editable) {
    await fxLoadRead(file);
    return;
  }
  if (file.previewKind !== 'none') {
    await fxLoadPreview(file, file.previewKind);
  }
}

function fxRender() {
  if (!fxState.open) return;
  const pathEl = $('#fx-path');
  pathEl.textContent = fxState.rootPath || '';
  pathEl.title = fxState.rootPath || '';

  const tree = $('#fx-tree');
  tree.innerHTML = '';
  const rootEntries = fxState.entriesByPath.get('') || [];
  for (const entry of rootEntries) {
    tree.appendChild(fxRenderEntry(entry, 0));
  }
  if (fxState.loading && rootEntries.length === 0) {
    const ph = document.createElement('div');
    ph.className = 'fx-empty';
    ph.textContent = 'loading…';
    tree.appendChild(ph);
  }

  const detail = $('#fx-detail');
  detail.innerHTML = '';
  if (fxState.error) {
    const err = document.createElement('div');
    err.className = 'fx-error';
    err.textContent = fxState.error;
    detail.appendChild(err);
  }
  if (fxState.detail.kind === 'empty') {
    const ph = document.createElement('div');
    ph.className = 'fx-empty';
    ph.textContent = fxState.loading ? 'loading…' : 'select a file';
    detail.appendChild(ph);
  } else if (fxState.detail.kind === 'text') {
    const head = document.createElement('div');
    head.className = 'fx-detail-head';
    head.textContent = fxState.detail.file.path;
    detail.appendChild(head);
    const pre = document.createElement('pre');
    pre.className = 'fx-text';
    pre.textContent = fxState.detail.content;
    detail.appendChild(pre);
  } else if (fxState.detail.kind === 'preview') {
    const head = document.createElement('div');
    head.className = 'fx-detail-head';
    head.textContent = fxState.detail.file.path;
    detail.appendChild(head);
    const frame = document.createElement('div');
    frame.className = 'fx-preview-frame';
    if (fxState.detail.previewKind === 'image') {
      const img = document.createElement('img');
      img.src = fxState.detail.url;
      img.alt = fxState.detail.file.name;
      frame.appendChild(img);
    } else if (fxState.detail.previewKind === 'pdf') {
      const iframe = document.createElement('iframe');
      iframe.src = fxState.detail.url;
      iframe.title = fxState.detail.file.name;
      frame.appendChild(iframe);
    }
    detail.appendChild(frame);
  }
}

function fxRenderEntry(entry, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'fx-row-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fx-row';
  btn.dataset.kind = entry.kind;
  btn.dataset.active = String(fxState.selected === entry.path);
  btn.disabled = !fxCanSelect(entry);
  btn.style.setProperty('--fx-depth', String(depth));
  const expanded = entry.kind === 'directory' && fxState.expanded.has(entry.path);
  btn.setAttribute('aria-expanded', entry.kind === 'directory' ? String(expanded) : 'false');
  const glyph = entry.kind === 'directory' ? (expanded ? '▾' : '▸') : ' ';
  const badge = fxEntryBadge(entry);
  btn.innerHTML = `
    <span class="fx-row-glyph">${glyph}</span>
    <span class="fx-row-name">${escapeHtml(entry.name)}</span>
    <span class="fx-row-badge">${escapeHtml(badge)}</span>
  `;
  btn.addEventListener('click', () => void fxSelectEntry(entry));
  wrap.appendChild(btn);
  if (expanded) {
    const children = fxState.entriesByPath.get(entry.path) || [];
    const childWrap = document.createElement('div');
    childWrap.className = 'fx-children';
    for (const child of children) {
      childWrap.appendChild(fxRenderEntry(child, depth + 1));
    }
    wrap.appendChild(childWrap);
  }
  return wrap;
}

function fxCanSelect(entry) {
  if (entry.kind === 'directory') return true;
  return entry.editable || entry.previewKind !== 'none';
}

function fxEntryBadge(entry) {
  if (entry.kind === 'directory') return 'dir';
  if (entry.kind === 'symlink') return 'link';
  if (entry.editable) return entry.previewKind === 'none' ? 'txt' : entry.previewKind;
  if (entry.previewKind !== 'none') return entry.previewKind;
  return 'bin';
}

checkAuth();
