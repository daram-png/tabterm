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

/* ---------- mobile mode ----------
 * Phase-1 mobile UX: convert to single-pane fullscreen + drawer sidebar when
 * vw <= 720 (matches CSS media query). Desktop UX is untouched — every change
 * is gated on body.mobile, which this module toggles + the CSS keys off.
 *
 * No native shell, no separate codebase. Same DOM, same xterm instance, same
 * WebSocket. Term elements are moved/hidden via display:none for non-active
 * slot; fit-pane is skipped for hidden ones (fit on a 0-width host crashes).
 */
const MOBILE_MQ = window.matchMedia('(max-width: 720px)');
function isMobile() { return MOBILE_MQ.matches; }

let _applyMobileModeRaf = 0;
function applyMobileMode() {
  const mobile = isMobile();
  const prev = document.body.classList.contains('mobile');
  document.body.classList.toggle('mobile', mobile);
  // leaving mobile -> close drawer so collapsed/open state doesn't leak
  if (!mobile) {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('open');
    // also dismiss any open bottom sheet (Phase 2) since they have no desktop UX
    if (typeof bsState !== 'undefined' && bsState.open) closeBottomSheet();
  }
  // Phase 2: sync bottom-nav visibility on every mode change.
  try { syncBottomNavVisibility(); } catch {}
  // only rebuild if the mode actually changed (avoid thrashing xterm on every resize tick)
  if (prev !== mobile) {
    try { buildLayout(); } catch (e) { console.error('applyMobileMode rebuild failed', e); }
  }
}
function scheduleApplyMobileMode() {
  if (_applyMobileModeRaf) cancelAnimationFrame(_applyMobileModeRaf);
  _applyMobileModeRaf = requestAnimationFrame(() => { _applyMobileModeRaf = 0; applyMobileMode(); });
}
window.addEventListener('resize', scheduleApplyMobileMode);
// matchMedia change is more reliable for orientation flips than resize alone
if (MOBILE_MQ.addEventListener) MOBILE_MQ.addEventListener('change', scheduleApplyMobileMode);
else if (MOBILE_MQ.addListener) MOBILE_MQ.addListener(scheduleApplyMobileMode); // legacy Safari

/* ---------- haptic feedback ----------
 * navigator.vibrate is only present on Android/Chromium (iOS Safari does not
 * implement it; calls become no-ops with no error). that's fine — we treat
 * haptics as a progressive enhancement, never a required interaction signal.
 * passive-low intensity (8-12ms) only — long buzzes are intrusive on mobile.
 */
function haptic(pattern = 10) {
  try { navigator.vibrate?.(pattern); } catch {}
}

/* ---------- bottom sheet (mobile, single instance reusable) ----------
 * one sheet DOM lives in index.html; openBottomSheet({...}) refills its content
 * and animates in. closeBottomSheet() animates out. exclusive — opening a new
 * sheet first closes the current. backdrop tap / handle tap / close button all
 * dismiss. Esc key works too (desktop dev only — no escape on iOS keyboard).
 *
 * not used on desktop. opening on desktop is a no-op (safety guard).
 */
// bsState.version: monotonic open-token. closeBottomSheet captures the version
// at close-time; the post-transition hide only runs if the version matches
// (i.e., no subsequent open happened in the meantime). prevents the race where
// close→open→close-2 in rapid succession lets close-1's timer hide the now-open
// sheet. (Peer review Y1.)
const bsState = { open: false, version: 0, onClose: null, _previousActive: null, _hideTimer: 0 };

function openBottomSheet({ title, body, actions, onClose }) {
  if (!isMobile()) return; // safety
  const sheet = document.getElementById('bottom-sheet');
  if (!sheet) return;
  // bump version + cancel any pending hide timer from a previous close
  bsState.version += 1;
  if (bsState._hideTimer) {
    clearTimeout(bsState._hideTimer);
    bsState._hideTimer = 0;
  }
  // Replace contents
  const titleEl = document.getElementById('bs-title');
  const bodyEl = document.getElementById('bs-body');
  const actionsEl = document.getElementById('bs-actions');
  if (titleEl) titleEl.textContent = title || '';
  if (bodyEl) {
    bodyEl.innerHTML = '';
    // Peer review R2: only accept DOM nodes for body. String inputs are treated
    // as plain text (textContent) — never innerHTML — so future callers can't
    // accidentally introduce HTML injection sinks. If a future feature needs
    // formatted markup, the caller must build the DOM tree explicitly.
    if (body instanceof Node) bodyEl.appendChild(body);
    else if (typeof body === 'string') bodyEl.textContent = body;
  }
  if (actionsEl) {
    actionsEl.innerHTML = '';
    if (Array.isArray(actions) && actions.length) {
      actionsEl.hidden = false;
      for (const a of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-sheet' + (a.secondary ? ' secondary' : '');
        btn.textContent = a.label;
        btn.addEventListener('click', () => {
          haptic(8);
          try { a.onClick?.(); } finally { if (a.dismiss !== false) closeBottomSheet(); }
        });
        actionsEl.appendChild(btn);
      }
    } else {
      actionsEl.hidden = true;
    }
  }
  bsState.onClose = onClose || null;
  bsState._previousActive = document.activeElement;
  // show
  sheet.hidden = false;
  sheet.setAttribute('aria-hidden', 'false');
  // force layout so the transform transition kicks in
  // eslint-disable-next-line no-unused-expressions
  sheet.offsetHeight;
  sheet.classList.add('open');
  bsState.open = true;
  haptic(6);
  // Y4 lite: move initial focus into the sheet so keyboard users land inside.
  // Full focus-trap (Tab/Shift+Tab cycling) is deferred to a Phase 3 a11y pass.
  try {
    const closeBtn = sheet.querySelector('.bottom-sheet-close');
    closeBtn?.focus?.({ preventScroll: true });
  } catch {}
}

function closeBottomSheet() {
  const sheet = document.getElementById('bottom-sheet');
  if (!sheet || !bsState.open) return;
  const closingVersion = bsState.version;
  sheet.classList.remove('open');
  bsState.open = false;
  if (bsState._hideTimer) clearTimeout(bsState._hideTimer);
  // wait for transition (matches CSS 240ms) before hiding to keep the slide-out
  // animation visible. The version check guards against a reopen happening
  // mid-transition: if openBottomSheet bumped version since we closed, skip
  // hiding (the new sheet content is already visible).
  bsState._hideTimer = setTimeout(() => {
    bsState._hideTimer = 0;
    if (bsState.open) return;  // reopened before timeout — leave visible
    if (bsState.version !== closingVersion) return;  // newer open happened
    sheet.hidden = true;
    sheet.setAttribute('aria-hidden', 'true');
    const onClose = bsState.onClose;
    bsState.onClose = null;
    const prev = bsState._previousActive;
    bsState._previousActive = null;
    try { prev?.focus?.(); } catch {}
    try { onClose?.(); } catch (e) { console.warn('[bottom-sheet] onClose error', e); }
  }, 260);
}

// global delegated handler for backdrop / handle / X / data-bs-close="1" elements
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-bs-close]');
  if (closer && bsState.open) {
    e.preventDefault();
    closeBottomSheet();
  }
});
// Esc closes (mostly for desktop debugging — iOS keyboard has no Esc key).
// Peer review Y2: don't fight other modals. Skip if another modal/dialog is open
// or if the event was already handled by something else. We also stopPropagation
// after handling so other listeners (e.g., a future global Esc hook) don't see it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (e.defaultPrevented) return;
  if (!bsState.open) return;
  // skip if another modal is visible — let it own Escape
  const otherModal = document.querySelector('.fx-modal:not(.hidden), .wd-modal:not(.hidden), .prompt-overlay:not(.hidden)');
  if (otherModal) return;
  e.preventDefault();
  e.stopPropagation();
  closeBottomSheet();
});

/* ---------- command history (ime-bar send ring buffer) ----------
 * Stored in localStorage as JSON array (most-recent first), capped at 50.
 * Source: every ime-bar flushImeText(true) commit with non-empty text.
 *
 * Why send-only (not xterm onData stdin):
 *   - PTY stdin includes password prompts + arrow keys + every keypress; capturing
 *     it would leak secrets into client localStorage. ime-bar text is user-typed
 *     and already plaintext.
 *   - Mobile users primarily compose commands via the rail bar (hangul IME needs
 *     it; English typing on phone keyboards too — onscreen kbd autocorrect mangles
 *     direct xterm input). So this captures ~all mobile inputs in practice.
 *
 * The history sheet shows entries with a one-tap "fill" action that drops the
 * text back into ime-bar (user can edit before send) — never auto-sends.
 */
const CMD_HISTORY_KEY = 'tabterm.mobile.cmdHistory';
const CMD_HISTORY_MAX = 50;
const CMD_HISTORY_ENTRY_MAX_CHARS = 4096;  // peer review B3: per-entry cap, ~4KB
function cmdHistoryLoad() {
  try {
    const raw = localStorage.getItem(CMD_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.length).slice(0, CMD_HISTORY_MAX) : [];
  } catch { return []; }
}
function cmdHistorySave(list) {
  try { localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(list.slice(0, CMD_HISTORY_MAX))); } catch {}
}
function cmdHistoryPush(text) {
  if (!text || typeof text !== 'string') return;
  const trimmed = text.trim();
  if (!trimmed) return;
  // B3: a pasted megabyte can blow out localStorage and slow the sheet render.
  // Truncate with a tail marker so the user can tell it was clipped.
  const stored = trimmed.length > CMD_HISTORY_ENTRY_MAX_CHARS
    ? trimmed.slice(0, CMD_HISTORY_ENTRY_MAX_CHARS) + ' …[truncated]'
    : trimmed;
  let list = cmdHistoryLoad();
  // dedupe: if previous entry is identical, skip (no double-push on retries)
  if (list[0] === stored) return;
  list.unshift(stored);
  list = list.slice(0, CMD_HISTORY_MAX);
  cmdHistorySave(list);
}
function cmdHistoryClear() {
  try { localStorage.removeItem(CMD_HISTORY_KEY); } catch {}
}

/* ---------- WS reconnect indicator ----------
 * Per-pane WS lifecycle already exists (openWs in pane lifecycle). This module
 * aggregates: any pane in reconnecting state -> 'reconnecting'; all closed -> 'offline';
 * else 'online'. UI is a small color dot in the winchrome title bar.
 *
 * State source of truth is per-pane (pane.wsStatus). renderWsStatus() reads all
 * panes and picks the worst state. Phase 2 also adds an auto-reconnect attempt
 * on unexpected close (graceful exit code messages keep their existing path —
 * we only fight true network drops).
 */
const WS_RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
function renderWsStatus() {
  const el = document.getElementById('ws-status');
  if (!el) return;
  // panes that own a WS (skip file panes and dead panes)
  const wsP = state.panes.filter((p) => p.kind !== 'file' && !p.dead);
  if (!wsP.length) {
    el.dataset.state = 'online';
    el.title = 'WebSocket online';
    return;
  }
  let worst = 'online';
  for (const p of wsP) {
    const s = p.wsStatus || 'online';
    if (s === 'offline') { worst = 'offline'; break; }
    if (s === 'reconnecting' && worst !== 'offline') worst = 'reconnecting';
  }
  el.dataset.state = worst;
  el.title = worst === 'online' ? 'WebSocket online'
    : worst === 'reconnecting' ? 'Reconnecting…'
    : 'Disconnected — tap a pane to retry';
}

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
  if (p.kind === 'subagent') {
    const custom = state.subagentLabels[p.subagentIndex];
    return custom || p.label;
  }
  if (p.kind === 'file') return p.fileName;
  return p.label;
}
function paneByFilePath(absPath) {
  return state.panes.find((p) => p.kind === 'file' && p.filePath === absPath);
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
    chip.onclick = pid ? () => {
      state.activeSlot = i;
      // mobile: swap which slot's cell is visible — needs buildLayout. desktop
      // shows both panes side by side so no rebuild needed.
      if (isMobile()) buildLayout();
      renderSidebar();
      renderSlotStrip();
      renderBottomNav();
      focusActivePane(paneById(pid));
    } : null;
  }
  // Phase 2: mirror slot state to mobile bottom nav (no-op on desktop)
  renderBottomNav();
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
  if (p.kind === 'file') {
    const kindLabel = p.contentKind === 'text' ? (p.language || 'text') : p.contentKind || 'file';
    return `
      <div class="pane-focus-bar"></div>
      <div class="session-header">
        <div class="session-icon file-icon">${fileIconSvg(32)}</div>
        <div class="session-meta">
          <div class="session-name">${escapeHtml(displayName(p))} <span class="ver">${slotLabel}</span></div>
          <div class="session-sub">${escapeHtml(kindLabel)}<span class="sep">·</span><span class="session-path">${escapeHtml(p.filePath || '')}</span></div>
        </div>
        <div class="session-tools">
          <div class="btn" title="Close file" data-act="close">✕</div>
        </div>
      </div>
      <div class="file-body"></div>
      <div class="statusbar">
        <span class="sb-path">${escapeHtml(p.filePath || '')}</span>
        <span class="pipe">|</span>
        <span class="sb-model">${escapeHtml(kindLabel)} · read-only</span>
        <span class="sb-spacer"></span>
        <span class="sb-right">${p.loading ? 'loading…' : (p.error ? 'error' : 'loaded')}</span>
      </div>
    `;
  }
  return `
    <div class="pane-focus-bar"></div>
    <div class="session-header">
      <div class="session-icon">${claudeMascotSvg(32)}</div>
      <div class="session-meta">
        <div class="session-name">${escapeHtml(displayName(p))} <span class="ver">${slotLabel}</span></div>
        <div class="session-sub">${p.kind === 'subagent' ? 'ccx hybrid' : 'general session'}<span class="sep">·</span><span class="session-path">${escapeHtml(p.cwd || '')}</span></div>
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
      <span class="sb-model">${p.kind === 'subagent' ? 'ccx · Opus 4.7' : 'general'}</span>
      <span class="sb-spacer"></span>
      <span class="sb-right"><span class="dot ${p.dead ? 'dead' : ''}"></span>${p.dead ? `exit ${p.exitCode ?? '?'}` : 'attached'}</span>
    </div>
  `;
}

function fileIconSvg(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2 H10 L13 5 V14 H4 Z"/><path d="M10 2 V5 H13"/><path d="M6 8 H11 M6 10.5 H11 M6 13 H9"/></svg>`;
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
  const mobile = isMobile();
  if (state.split) { try { state.split.destroy(); } catch {} state.split = null; }
  const root = $('#workspace');
  root.innerHTML = '';

  // mobile: auto-close drawer whenever layout (re)builds. user-initiated layout
  // changes typically come from sidebar/slot-strip taps, where closing the
  // drawer is the desired next step. on init the drawer is already closed.
  if (mobile) {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('open');
  }

  const filled = state.slots.map((id, i) => id ? { id, idx: i, pane: paneById(id) } : null).filter(Boolean);
  if (!filled.length) {
    root.innerHTML = '<div class="empty-state" style="margin:auto; color:var(--muted); font-family:Geist Mono, monospace; font-size:12px;">no session in any slot — click a subagent on the left, or "New session"</div>';
    renderSlotStrip();
    renderBottomNav();
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
    // mobile: hide non-active slot cell. element still in DOM so xterm
    // term.element + WS + ring-buffer stay alive; switching the slot-chip
    // just toggles display.
    if (mobile && idx !== state.activeSlot) {
      cell.style.display = 'none';
      cell.dataset.mobileHidden = 'true';
    }
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

  // desktop only: Split.js gutter for 2-pane layout. mobile shows one pane at a time.
  if (!mobile && filled.length > 1) {
    state.split = Split([...wrap.children], {
      sizes: [50, 50], minSize: 200, gutterSize: 1, direction: 'horizontal',
      onDragEnd: () => filled.forEach(({ pane }) => fitPane(pane)),
    });
  }

  for (const { pane } of filled) {
    if (pane.kind === 'file') {
      renderFilePaneBody(pane);
      continue;
    }
    const host = pane.cellEl.querySelector('.terminal');
    const hidden = pane.cellEl.style.display === 'none';
    // mobile defer: don't term.open() on a hidden host — xterm measures the
    // cell glyph via getBoundingClientRect which returns 0 on display:none,
    // producing a broken cursor / wrong size. instead, leave _opened=false
    // and let the next buildLayout (triggered by slot-chip tap) open it
    // once the host is visible.
    if (hidden && !pane.term._opened) continue;
    if (!pane.term._opened) { pane.term.open(host); pane.term._opened = true; }
    else { host.appendChild(pane.term.element); }
    // skip fit for already-opened hidden pane — fit needs visible host.
    if (hidden) continue;
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
  // Peer review R3 — defensive lifecycle:
  //  1) Cancel any pending retry timer so a delayed reconnect doesn't fight us.
  //  2) Close any existing socket (CONNECTING or OPEN) before opening a new one.
  //     Otherwise the old socket's close handler can schedule a NEW retry on top
  //     of our manual reopen, producing duplicate sockets writing the same PTY.
  //  3) Mint a generation token; every handler captures the token at attach time
  //     and bails out if the pane has moved past it. Guards against late events
  //     from old sockets corrupting state assigned to the new one.
  //  4) term.onData is attached ONCE per pane (guard p._dataPiped). Re-attaching
  //     on every reconnect would duplicate every keystroke send.
  if (p._wsRetryTimer) {
    clearTimeout(p._wsRetryTimer);
    p._wsRetryTimer = 0;
  }
  if (p.ws) {
    try {
      // mark old socket as superseded so its close handler doesn't trigger retry
      p.ws._tabterm_superseded = true;
      if (p.ws.readyState === 0 || p.ws.readyState === 1) p.ws.close();
    } catch {}
  }
  const gen = (p._wsGen || 0) + 1;
  p._wsGen = gen;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/pty?sessionId=${encodeURIComponent(p.sessionId)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws._tabterm_gen = gen;
  p.ws = ws;
  // Phase 2: WS lifecycle status for the winchrome reconnect indicator.
  // 'online' = open, 'reconnecting' = retry scheduled, 'offline' = retries
  // exhausted or PTY exited cleanly. Aggregated by renderWsStatus().
  p.wsStatus = 'reconnecting';
  renderWsStatus();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const stale = () => ws._tabterm_gen !== p._wsGen;  // capture is by closure on ws
  ws.addEventListener('open', () => {
    if (stale()) return;
    p.wsStatus = 'online';
    p._wsRetry = 0;  // reset backoff cursor on successful connect
    renderWsStatus();
    fitPane(p);
  });
  ws.addEventListener('message', (ev) => {
    if (stale()) return;
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'exit') {
          p.dead = true;
          p.exitCode = msg.code;
          p._wsExitedCleanly = true;  // suppresses reconnect on close
          p.wsStatus = 'offline';
          p.term.write(`\r\n\x1b[33m[exit ${msg.code ?? '?'}]  ↻ to restart\x1b[0m\r\n`);
          renderSidebar();
          renderWsStatus();
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
    if (stale() || ws._tabterm_superseded) {
      // a newer socket has taken over; let it manage retry state
      return;
    }
    try {
      const tail = decoder.decode();
      if (tail) p.term.write(tail);
    } catch {}
    // Two close paths:
    //   1) Server sent {type:'exit'} -> _wsExitedCleanly=true -> stay offline, user restarts via UI.
    //   2) Network drop / server crash -> auto-reconnect with exponential backoff.
    // We cap at 5 attempts (~30s total). After that the pane stays 'offline'.
    if (p._wsExitedCleanly || p.dead) {
      p.wsStatus = 'offline';
      p.term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');
      renderWsStatus();
      return;
    }
    const attempt = (p._wsRetry || 0);
    if (attempt >= WS_RECONNECT_BACKOFF_MS.length) {
      p.wsStatus = 'offline';
      // Y11: message matches actual behavior. We don't have a tap-to-retry path
      // yet — exhaustion is terminal; user closes the pane and reopens.
      p.term.write('\r\n\x1b[31m[disconnected — reconnect attempts exhausted; close pane and reopen]\x1b[0m\r\n');
      renderWsStatus();
      return;
    }
    const delay = WS_RECONNECT_BACKOFF_MS[attempt];
    p._wsRetry = attempt + 1;
    p.wsStatus = 'reconnecting';
    p.term.write(`\r\n\x1b[33m[reconnecting in ${Math.round(delay / 1000)}s... ${attempt + 1}/${WS_RECONNECT_BACKOFF_MS.length}]\x1b[0m\r\n`);
    renderWsStatus();
    clearTimeout(p._wsRetryTimer);
    p._wsRetryTimer = setTimeout(() => {
      p._wsRetryTimer = 0;
      // pane might've been closed during the wait window; guard
      if (p.dead || !paneById(p.id)) return;
      // someone called openWs manually in the meantime -> different gen, bail
      if (p._wsGen !== gen) return;
      try { openWs(p); } catch (e) { console.error('[ws-reconnect] open failed', e); }
    }, delay);
  });
  // Peer review R3 / Y12: attach term.onData exactly ONCE per pane. The handler
  // closes over `p`, not over `ws`, so it always sends to the current socket.
  if (!p._dataPiped) {
    p._dataPiped = true;
    p.term.onData((d) => sendWs(p, { type: 'input', data: d }));
  }
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
  if (p.kind === 'file') {
    if (p.previewUrl) { try { URL.revokeObjectURL(p.previewUrl); } catch {} }
  } else {
    try { p.ws?.close(); } catch {}
    try { await api(`/api/sessions/${id}`, { method: 'DELETE' }); } catch {}
  }
  detachFromSlots(id);
  state.panes = state.panes.filter((x) => x.id !== id);
  buildLayout();
  renderSidebar();
  renderSlotStrip();
}

async function openFileInSlot(entry) {
  if (!entry || entry.kind === 'directory') return;
  if (entry.kind !== 'file') {
    const reason = entry.isBroken ? 'broken symlink' : `not a regular file (${entry.kind})`;
    toast(`${entry.name}: ${reason}`, 'err');
    return;
  }
  const existing = paneByFilePath(entry.path);
  if (existing) {
    const slot = slotOfPane(existing.id);
    if (slot >= 0) {
      state.activeSlot = slot;
      renderSidebar();
      renderSlotStrip();
      return;
    }
    assignToSlot(existing.id);
    return;
  }
  const isText = !!entry.editable;
  const isPreview = !isText && entry.previewKind && entry.previewKind !== 'none';
  if (!isText && !isPreview) {
    toast(`${entry.name}: binary file not previewable`, 'err');
    return;
  }
  const p = {
    id: `file:${(crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2))}`,
    kind: 'file',
    filePath: entry.path,
    fileName: entry.name,
    contentKind: isText ? 'text' : entry.previewKind,
    content: null,
    previewUrl: null,
    language: null,
    error: null,
    loading: true,
    cellEl: null,
  };
  state.panes.push(p);
  const target = state.slotCursor;
  const evictedId = state.slots[target];
  state.slots[target] = p.id;
  state.activeSlot = target;
  state.slotCursor = (state.slotCursor + 1) % 2;
  if (evictedId) {
    const evicted = paneById(evictedId);
    if (evicted?.kind === 'file') {
      if (evicted.previewUrl) { try { URL.revokeObjectURL(evicted.previewUrl); } catch {} }
      state.panes = state.panes.filter((x) => x.id !== evictedId);
    }
  }
  buildLayout();
  renderSidebar();
  renderSlotStrip();
  try {
    if (isText) {
      const r = await api(`/api/fs/read?path=${encodeURIComponent(entry.path)}`);
      p.content = r.content;
      p.language = r.language;
    } else {
      const url = `/api/fs/preview?path=${encodeURIComponent(entry.path)}`;
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) {
        let body = {};
        try { body = await resp.json(); } catch {}
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      p.previewUrl = URL.createObjectURL(blob);
    }
    p.loading = false;
  } catch (e) {
    p.error = e?.message || String(e);
    p.loading = false;
  }
  if (slotOfPane(p.id) >= 0 && p.cellEl) {
    renderFilePaneBody(p);
    const sbRight = p.cellEl.querySelector('.statusbar .sb-right');
    if (sbRight) sbRight.textContent = p.error ? 'error' : 'loaded';
  }
}

function renderFilePaneBody(p) {
  if (!p.cellEl) return;
  const body = p.cellEl.querySelector('.file-body');
  if (!body) return;
  body.innerHTML = '';
  if (p.loading) {
    const ph = document.createElement('div');
    ph.className = 'fx-empty';
    ph.textContent = 'loading…';
    body.appendChild(ph);
    return;
  }
  if (p.error) {
    const err = document.createElement('div');
    err.className = 'fx-error';
    err.textContent = `error: ${p.error}`;
    body.appendChild(err);
    return;
  }
  if (p.contentKind === 'text') {
    const pre = document.createElement('pre');
    pre.className = 'fx-text';
    pre.textContent = p.content || '';
    body.appendChild(pre);
  } else if (p.contentKind === 'image' && p.previewUrl) {
    const frame = document.createElement('div');
    frame.className = 'fx-preview-frame';
    const img = document.createElement('img');
    img.src = p.previewUrl;
    img.alt = p.fileName;
    frame.appendChild(img);
    body.appendChild(frame);
  } else if (p.contentKind === 'pdf' && p.previewUrl) {
    const frame = document.createElement('div');
    frame.className = 'fx-preview-frame';
    const iframe = document.createElement('iframe');
    iframe.src = p.previewUrl;
    iframe.title = p.fileName;
    frame.appendChild(iframe);
    body.appendChild(frame);
  }
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
$('#btn-sidebar').addEventListener('click', () => {
  // mobile: off-canvas drawer (.open + backdrop). desktop: width-collapse (.collapsed).
  // two separate classes so resizing the window between modes doesn't get stuck.
  if (isMobile()) {
    const sb = $('#sidebar');
    const bd = $('#sidebar-backdrop');
    const opening = !sb.classList.contains('open');
    sb.classList.toggle('open', opening);
    bd?.classList.toggle('open', opening);
  } else {
    $('#sidebar').classList.toggle('collapsed');
  }
});
// mobile drawer: tap backdrop -> close
$('#sidebar-backdrop')?.addEventListener('click', () => {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('open');
});
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
    // Mobile shell Phase 2: persist user-typed text to cmd history ring buffer.
    // Mobile-only — the history sheet only exists on mobile, and the localStorage
    // key (`tabterm.mobile.cmdHistory`) explicitly states scope. Gate with isMobile()
    // so desktop users who use the ime-bar don't unexpectedly persist into a key
    // they can never view. (Peer review R1.)
    // Only push when withEnter=true (committed line) and text non-empty. blur/aux
    // flushes (no \r) are NOT recorded — they're mid-composition saves to PTY,
    // not user-committed commands.
    if (withEnter && v && isMobile()) {
      try { cmdHistoryPush(v); } catch (e) { console.warn('[cmd-history] push failed', e); }
    }
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

  // apply mobile mode BEFORE first buildLayout so split.js / 1-pane decision
  // is correct from the start (avoids a one-frame desktop layout flash on phone).
  document.body.classList.toggle('mobile', isMobile());

  buildLayout();
  renderSidebar();
  renderSlotStrip();

  // watchdog status: initial fetch + 30s polling
  refreshWatchdog();
  setInterval(refreshWatchdog, 30_000);

  // iOS IME rail (no-op on non-iPad)
  initImeBar();

  // mobile shell Phase 2 — bottom nav + swipe gesture. these init unconditionally
  // and self-guard with isMobile() at runtime. on desktop they sit dormant
  // (bottom-nav has [hidden], swipe handler short-circuits).
  initBottomNav();
  initSwipeGesture();
  renderWsStatus();
}

/* ---------- bottom nav (mobile-only) ---------- */
function initBottomNav() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;
  // expose on phone, hide on desktop. applyMobileMode toggles via syncBottomNavVisibility.
  syncBottomNavVisibility();
  // wire delegated clicks once
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.bn-btn');
    if (!btn) return;
    const act = btn.dataset.act;
    haptic(8);
    onBottomNavAction(act);
  });
  // re-bind on mobile mode flips (the nav stays mounted; we just toggle [hidden])
  if (MOBILE_MQ.addEventListener) MOBILE_MQ.addEventListener('change', syncBottomNavVisibility);
}

function syncBottomNavVisibility() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;
  if (isMobile()) {
    nav.hidden = false;
    renderBottomNav();
  } else {
    nav.hidden = true;
    // also close any open sheet — desktop has no sheet UX
    if (bsState.open) closeBottomSheet();
  }
}

function renderBottomNav() {
  const nav = document.getElementById('bottom-nav');
  if (!nav || nav.hidden) return;
  // slot chips reflect current slot occupants
  for (let i = 0; i < 2; i++) {
    const btn = nav.querySelector(`[data-act="slot-${i}"]`);
    if (!btn) continue;
    const pid = state.slots[i];
    const pane = pid ? paneById(pid) : null;
    const isActive = i === state.activeSlot && !!pid;
    btn.classList.toggle('empty', !pid);
    btn.classList.toggle('active', isActive);
    const lbl = btn.querySelector('.bn-slot-label');
    if (lbl) lbl.textContent = pane ? displayName(pane) : 'empty';
    // Peer review Y3 + B5: expose state + descriptive label to assistive tech.
    // aria-pressed marks toggle state; aria-current="page" marks active context.
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    if (isActive) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
    const slotLetter = i === 0 ? 'L' : 'R';
    const labelText = pane ? displayName(pane) : 'empty';
    btn.setAttribute('aria-label', `Slot ${slotLetter}: ${labelText}${isActive ? ', active' : ''}`);
  }
}

function onBottomNavAction(act) {
  switch (act) {
    case 'sidebar': {
      // Peer review Y9: guard against missing sidebar (defensive — should always exist)
      const sb = document.getElementById('sidebar');
      if (!sb) return;
      const bd = document.getElementById('sidebar-backdrop');
      const opening = !sb.classList.contains('open');
      sb.classList.toggle('open', opening);
      bd?.classList.toggle('open', opening);
      break;
    }
    case 'slot-0':
    case 'slot-1': {
      const idx = act === 'slot-0' ? 0 : 1;
      const pid = state.slots[idx];
      if (!pid) {
        // empty slot tap -> open + session picker (sets activeSlot to this idx)
        state.activeSlot = idx;
        openNewSessionSheet(idx);
        return;
      }
      state.activeSlot = idx;
      buildLayout();  // swap visible slot
      renderSidebar();
      renderSlotStrip();
      renderBottomNav();
      focusActivePane(paneById(pid));
      break;
    }
    case 'cmds':
      openCmdHistorySheet();
      break;
    case 'more':
      openMoreMenuSheet();
      break;
    default:
      console.warn('[bottom-nav] unknown action', act);
  }
}

/* ---------- + session bottom sheet (mobile) ----------
 * Lists subagent-0..N (with current live label) and the two new-engine creators
 * (+ Claude / + OpenCode). Tapping fills the given slotIndex (default activeSlot).
 * Reuses existing addPaneFromServer / new-session flows under the hood — no new
 * server routes.
 */
function openNewSessionSheet(targetSlot) {
  if (!isMobile()) return;
  const slot = (typeof targetSlot === 'number') ? targetSlot : state.activeSlot;
  const wrap = document.createElement('div');

  // section: subagents
  const subHead = document.createElement('div');
  subHead.className = 'bs-section';
  subHead.textContent = 'Subagents';
  wrap.appendChild(subHead);

  const subWrap = document.createElement('div');
  const count = state.subagentsCount || 8;
  for (let i = 0; i < count; i++) {
    const existing = paneByWorker(i);
    const label = state.subagentLabels?.[i] || `${state.subagentPrefix || 'subagent-'}${i}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bs-item';
    btn.innerHTML = `
      <span class="bs-item-icon">${i}</span>
      <span class="bs-item-main">
        <span class="bs-item-title">${escapeHtml(label)}</span>
        <span class="bs-item-sub">${existing ? (existing.dead ? 'exited' : 'live') : 'not running'}</span>
      </span>
    `;
    btn.addEventListener('click', () => {
      closeBottomSheet();
      handleMobileSubagentPick(i, slot);
    });
    subWrap.appendChild(btn);
  }
  wrap.appendChild(subWrap);

  // section: new engines
  const engHead = document.createElement('div');
  engHead.className = 'bs-section';
  engHead.textContent = 'New session';
  wrap.appendChild(engHead);

  for (const eng of [
    { id: 'claude', label: '+ Claude', sub: 'HydraTeams proxy' },
    { id: 'opencode', label: '+ OpenCode', sub: 'Nopersb proxy' },
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bs-item';
    btn.innerHTML = `
      <span class="bs-item-icon">+</span>
      <span class="bs-item-main">
        <span class="bs-item-title">${escapeHtml(eng.label)}</span>
        <span class="bs-item-sub">${escapeHtml(eng.sub)}</span>
      </span>
    `;
    btn.addEventListener('click', () => {
      closeBottomSheet();
      // Peer review Y8: lock activeSlot to the slot the user tapped from BEFORE
      // delegating to the new-session button. Otherwise the spawn lands in
      // whichever slot was previously focused, which may not be `slot`.
      state.activeSlot = slot;
      // trigger the existing sidebar button — keeps a single source of truth
      const elId = eng.id === 'claude' ? 'btn-new-claude' : 'btn-new-opencode';
      document.getElementById(elId)?.click();
    });
    wrap.appendChild(btn);
  }

  openBottomSheet({ title: `Slot ${slot === 0 ? 'L' : 'R'} — add session`, body: wrap });
}

function handleMobileSubagentPick(idx, slot) {
  const existing = paneByWorker(idx);
  if (existing) {
    state.slots[slot] = existing.id;
    state.activeSlot = slot;
    buildLayout();
    renderSidebar();
    renderSlotStrip();
    renderBottomNav();
    focusActivePane(existing);
    return;
  }
  // not running — defer to existing sidebar click handler to keep spawn logic
  // single-sourced. The handler is async; finding it requires the sidebar list
  // node, which renderSidebar() generates. We synthesise a click on the matching
  // row if present, else toast a hint.
  const row = document.querySelector(`#sidebar-list [data-worker-index="${idx}"]`);
  if (row) {
    row.click();
  } else {
    toast(`subagent-${idx} not yet listed — open Sessions panel`, 'amber', 3000);
  }
}

/* ---------- command history bottom sheet ---------- */
function openCmdHistorySheet() {
  if (!isMobile()) return;
  const list = cmdHistoryLoad();
  const wrap = document.createElement('div');
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'bs-empty';
    empty.textContent = 'No commands yet. Type via the input bar — committed lines (Enter) are saved here.';
    wrap.appendChild(empty);
  } else {
    for (const text of list) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'bs-cmd-row';
      row.innerHTML = `<span class="bs-cmd-text"></span><span class="bs-cmd-fill">↑ fill</span>`;
      row.querySelector('.bs-cmd-text').textContent = text;
      row.addEventListener('click', () => {
        const input = document.getElementById('ime-input');
        if (input) {
          input.value = text;
          input.focus();
        }
        closeBottomSheet();
      });
      wrap.appendChild(row);
    }
  }
  openBottomSheet({
    title: `Command history (${list.length})`,
    body: wrap,
    actions: list.length ? [
      { label: 'Clear all', secondary: true, onClick: () => { cmdHistoryClear(); openCmdHistorySheet(); }, dismiss: false },
    ] : null,
  });
}

/* ---------- more menu bottom sheet ---------- */
function openMoreMenuSheet() {
  if (!isMobile()) return;
  const wrap = document.createElement('div');
  const items = [
    { id: 'wd-status', title: 'Watchdog status', sub: 'subagent keep-alive log', click: () => document.getElementById('btn-wd-status')?.click() },
    { id: 'cleanup', title: 'Cleanup zombies', sub: 'kill orphan bun/claude/node', click: () => document.getElementById('btn-cleanup-zombies')?.click() },
    { id: 'boot-all', title: 'Boot all subagents', sub: '0..N', click: () => document.getElementById('btn-boot-all')?.click() },
    { id: 'soft-stop', title: 'Send Ctrl+C', sub: 'to active pane', click: () => document.getElementById('btn-soft-stop')?.click() },
    { id: 'kill', title: 'Force kill active', sub: 'destroy current session', danger: true, click: () => document.getElementById('btn-kill')?.click() },
    { id: 'logout', title: 'Logout', sub: '', danger: true, click: () => document.getElementById('btn-logout')?.click() },
  ];
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bs-item' + (it.danger ? ' danger' : '');
    btn.innerHTML = `
      <span class="bs-item-icon">${it.id === 'logout' ? '⇥' : it.id === 'kill' ? '✕' : '·'}</span>
      <span class="bs-item-main">
        <span class="bs-item-title">${escapeHtml(it.title)}</span>
        ${it.sub ? `<span class="bs-item-sub">${escapeHtml(it.sub)}</span>` : ''}
      </span>
    `;
    btn.addEventListener('click', () => {
      closeBottomSheet();
      // small delay so sheet close anim doesn't fight the followup modal
      setTimeout(() => { try { it.click(); } catch (e) { console.error('[more-menu]', e); } }, 280);
    });
    wrap.appendChild(btn);
  }
  openBottomSheet({ title: 'More', body: wrap });
}

/* ---------- swipe gesture (mobile L↔R slot swap) ----------
 * Pointer events with horizontal threshold + velocity. Skipped when:
 *   - not mobile mode
 *   - swipe starts within 24px of left/right edge (reserve for OS back-gesture
 *     + sidebar drawer open from edge — though we don't bind drawer-from-edge
 *     here, leaving the corridor protects future use and iOS Safari back nav)
 *   - swipe starts on a button/input/textarea (text selection etc.)
 *   - both slots not filled (nothing to swap to)
 *   - vertical movement dominant (likely scroll, not horizontal swipe)
 */
function initSwipeGesture() {
  const ws = document.getElementById('workspace');
  if (!ws) return;
  const EDGE_PX = 24;
  const H_THRESHOLD_PX = 60;
  const V_REJECT_RATIO = 0.6;  // |dy| > 0.6 * |dx| -> treat as scroll, skip
  const VELOCITY_THRESHOLD = 0.4;  // px/ms — fast flicks override distance threshold

  // Peer review Y6: swipe handler must not interfere with xterm text selection,
  // ime-bar / sidebar drawer, or active text selections. We additionally check
  // window.getSelection() at end-of-swipe so a horizontal drag that *created*
  // a selection during the gesture doesn't also swap slots.
  const MIN_DISTANCE_FLOOR = 32;  // Y7: absolute distance floor below which no swipe (even fast flicks)
  let active = null;
  ws.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    if (e.pointerType !== 'touch') return;  // ignore mouse (desktop dev)
    // only consider when both slots are filled — otherwise swipe is a no-op intent
    if (!(state.slots[0] && state.slots[1])) return;
    // skip if touching interactive elements (buttons, links, inputs).
    // .xterm-screen (terminal text body) is also skipped — terminal users expect
    // tap-to-select / drag-to-select. The swipe corridor is the pane gutters
    // and statusbar/sessionheader bands, not the terminal body itself.
    if (e.target.closest('button, input, textarea, a, .xterm-helper-textarea, .xterm-screen, .bn-btn, .ws-kebab-btn, .bottom-sheet, .ime-bar')) return;
    const rect = ws.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < EDGE_PX || x > rect.width - EDGE_PX) return;
    active = {
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      startT: performance.now(),
      pointerId: e.pointerId,
    };
  }, { passive: true });

  ws.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.pointerId) return;
    active.lastX = e.clientX;
    active.lastY = e.clientY;
  }, { passive: true });

  function endSwipe(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    const dx = active.lastX - active.startX;
    const dy = active.lastY - active.startY;
    const dt = performance.now() - active.startT;
    active = null;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (ady > adx * V_REJECT_RATIO) return;  // dominant vertical -> scroll, ignore
    const velocity = adx / Math.max(dt, 1);  // px/ms
    // Y7: distance floor — accidental short-fast flicks (e.g. touch drift while
    // typing) shouldn't swap panes. Even if velocity is high, distance must
    // clear MIN_DISTANCE_FLOOR (32px) before we honor the swipe.
    if (adx < MIN_DISTANCE_FLOOR) return;
    if (adx < H_THRESHOLD_PX && velocity < VELOCITY_THRESHOLD) return;
    // Y6 followup: if a text selection exists (likely created by this gesture
    // crossing terminal text or other selectable content), don't swap.
    try {
      const sel = window.getSelection?.();
      if (sel && sel.toString().length > 0) return;
    } catch {}
    // dx>0 = right swipe -> show prev slot (L); dx<0 = left swipe -> show R
    const target = dx > 0 ? 0 : 1;
    if (state.activeSlot === target) return;
    if (!state.slots[target]) return;
    haptic([6, 4, 6]);
    state.activeSlot = target;
    buildLayout();
    renderSidebar();
    renderSlotStrip();
    renderBottomNav();
    focusActivePane(paneById(state.slots[target]));
  }
  ws.addEventListener('pointerup', endSwipe, { passive: true });
  ws.addEventListener('pointercancel', endSwipe, { passive: true });
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

/* ---------- sidebar tabs + global explorer ---------- */

const exState = {
  tab: 'sessions',
  drives: [],
  childrenByPath: new Map(),
  expanded: new Set(),
  selected: null,
  loading: new Set(),
  error: null,
  rootPath: null,
};

function switchSidebarTab(name) {
  if (exState.tab === name) return;
  exState.tab = name;
  for (const btn of $$('.sidebar-tab')) {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  $('#sidebar-pane-sessions').classList.toggle('hidden', name !== 'sessions');
  $('#sidebar-pane-explorer').classList.toggle('hidden', name !== 'explorer');
  $('#sidebar-foot-sessions').style.display = name === 'sessions' ? '' : 'none';
  if (name === 'explorer' && exState.drives.length === 0) {
    void exInit();
  }
}

async function exInit() {
  try {
    const r = await api('/api/fs/drives');
    exState.drives = r.drives || [];
    exState.rootPath = exState.drives[0] || 'C:/';
    $('#explorer-path-input').value = exState.rootPath;
    await exLoadDir(exState.rootPath);
    exState.expanded.add(exState.rootPath);
    exRender();
  } catch (e) {
    exState.error = `drives: ${e.message}`;
    exRender();
  }
}

async function exLoadDir(absPath) {
  if (exState.loading.has(absPath)) return;
  exState.loading.add(absPath);
  exState.error = null;
  exRender();
  try {
    const r = await api(`/api/fs/list?path=${encodeURIComponent(absPath)}`);
    exState.childrenByPath.set(r.path, r.entries);
    if (r.path !== absPath) exState.childrenByPath.set(absPath, r.entries);
  } catch (e) {
    exState.error = `${absPath}: ${e.message}`;
  } finally {
    exState.loading.delete(absPath);
    exRender();
  }
}

async function exToggle(absPath) {
  if (exState.expanded.has(absPath)) {
    exState.expanded.delete(absPath);
    exRender();
    return;
  }
  exState.expanded.add(absPath);
  if (!exState.childrenByPath.has(absPath)) {
    await exLoadDir(absPath);
  } else {
    exRender();
  }
}

function exNormPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

function exParentOf(absPath) {
  const norm = exNormPath(absPath);
  if (/^[a-zA-Z]:$/.test(norm) || norm === '/') return null;
  const i = norm.lastIndexOf('/');
  if (i <= 0) return null;
  const parent = norm.slice(0, i);
  if (/^[a-zA-Z]:$/.test(parent)) return parent + '/';
  return parent || '/';
}

async function exNavigateTo(absPath) {
  const trimmed = String(absPath || '').trim();
  if (!trimmed) return;
  exState.rootPath = trimmed;
  $('#explorer-path-input').value = trimmed;
  exState.expanded.clear();
  exState.expanded.add(trimmed);
  await exLoadDir(trimmed);
}

function exRender() {
  if (exState.tab !== 'explorer') return;
  const tree = $('#explorer-tree');
  tree.innerHTML = '';
  if (exState.error) {
    const err = document.createElement('div');
    err.className = 'exp-error';
    err.textContent = exState.error;
    tree.appendChild(err);
  }
  const root = exState.rootPath;
  if (!root) {
    const p = document.createElement('div');
    p.className = 'exp-loading';
    p.textContent = 'loading drives…';
    tree.appendChild(p);
    return;
  }
  tree.appendChild(exRenderNode({
    name: root,
    path: root,
    kind: 'directory',
    editable: false,
    previewKind: 'none',
  }, 0, true));
}

function exRenderNode(entry, depth, isRoot = false) {
  const wrap = document.createElement('div');
  const node = document.createElement('div');
  node.className = 'exp-node';
  if (exState.selected === entry.path) node.classList.add('selected');
  node.style.paddingLeft = `${4 + depth * 12}px`;

  const isDir = entry.kind === 'directory';
  const expanded = isDir && exState.expanded.has(entry.path);
  const loading = exState.loading.has(entry.path);

  const twist = document.createElement('span');
  twist.className = 'exp-twist';
  twist.textContent = isDir ? (loading ? '·' : (expanded ? '▾' : '▸')) : ' ';
  node.appendChild(twist);

  const icon = document.createElement('span');
  icon.className = `exp-icon ${isDir ? 'dir' : 'file'}`;
  icon.textContent = isDir ? '▣' : '·';
  node.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'exp-name';
  name.textContent = isRoot ? entry.path : entry.name;
  name.title = entry.path;
  node.appendChild(name);

  node.addEventListener('click', async (e) => {
    e.stopPropagation();
    exState.selected = entry.path;
    $('#explorer-path-input').value = entry.path;
    if (isDir) {
      await exToggle(entry.path);
    } else {
      exRender();
      await openFileInSlot(entry);
    }
  });

  wrap.appendChild(node);

  if (isDir && expanded) {
    const children = exState.childrenByPath.get(entry.path);
    const childWrap = document.createElement('div');
    if (loading && !children) {
      const p = document.createElement('div');
      p.className = 'exp-loading';
      p.style.paddingLeft = `${4 + (depth + 1) * 12}px`;
      p.textContent = 'loading…';
      childWrap.appendChild(p);
    } else if (children) {
      if (children.length === 0) {
        const p = document.createElement('div');
        p.className = 'exp-empty';
        p.style.paddingLeft = `${4 + (depth + 1) * 12}px`;
        p.textContent = 'empty';
        childWrap.appendChild(p);
      } else {
        for (const c of children) {
          childWrap.appendChild(exRenderNode(c, depth + 1));
        }
      }
    }
    wrap.appendChild(childWrap);
  }
  return wrap;
}

for (const btn of $$('.sidebar-tab')) {
  btn.addEventListener('click', () => switchSidebarTab(btn.dataset.tab));
}
$('#explorer-up').addEventListener('click', async () => {
  const cur = $('#explorer-path-input').value.trim() || exState.rootPath;
  const parent = exParentOf(cur);
  if (parent) await exNavigateTo(parent);
});
$('#explorer-path-input').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    await exNavigateTo(e.target.value);
  }
});

/* ============================================================
 * Phase 2: filesystem mutations (mkdir/delete/rename/write/upload)
 * Used by Explorer right-click menu, file-pane editor, and the
 * terminal-pane drop overlay (Telegram-style drag-drop).
 * ============================================================ */

// Single rolling context menu — exclusive (open new closes old). Returns the
// element so callers can dispatch focus / aria for keyboard nav.
let ctxMenuEl = null;
function closeCtxMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
}
document.addEventListener('click', (e) => {
  if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeCtxMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ctxMenuEl) closeCtxMenu();
});

function openCtxMenu(items, x, y) {
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it === '---') {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-menu-item' + (it.danger ? ' danger' : '');
    btn.textContent = it.label;
    if (it.disabled) btn.disabled = true;
    btn.addEventListener('click', () => {
      closeCtxMenu();
      try { it.onClick(); } catch (e) { toast(`action failed: ${e.message || e}`, 'err'); }
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 4);
  const py = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(4, px)}px`;
  menu.style.top = `${Math.max(4, py)}px`;
  ctxMenuEl = menu;
  return menu;
}

// CSRF-aware JSON mutation. Returns parsed JSON; throws on !ok with body.
async function apiMutate(path, method, body) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { ...csrfHeader() },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  if (r.status === 401) { showAuth(); throw new Error('unauthorized'); }
  let parsed = {};
  try { parsed = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(parsed.error || `${r.status}`);
    e.body = parsed;
    e.status = r.status;
    throw e;
  }
  return parsed;
}

// Multipart upload helper. Used by Explorer "Upload here" + terminal drop.
// Returns the server's entry summary (which may have an autosuffixed name).
async function uploadFile(absDir, file, { autosuffix = true } = {}) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const url = `/api/fs/upload?dir=${encodeURIComponent(absDir)}&autosuffix=${autosuffix ? 'true' : 'false'}`;
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { ...csrfHeader() },
    body: fd,
  });
  if (r.status === 401) { showAuth(); throw new Error('unauthorized'); }
  let parsed = {};
  try { parsed = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(parsed.error || `${r.status}`);
    e.body = parsed;
    e.status = r.status;
    throw e;
  }
  return parsed.entry;
}

// Inline prompt that returns the typed value or null (Esc / Cancel). Built
// instead of window.prompt() so we can preselect / theme / handle Enter.
function promptInline(title, initial = '', placeholder = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'prompt-overlay';
    overlay.innerHTML = `
      <div class="prompt-card">
        <div class="prompt-title"></div>
        <input type="text" class="prompt-input" />
        <div class="prompt-actions">
          <button type="button" class="prompt-cancel">Cancel</button>
          <button type="button" class="prompt-ok">OK</button>
        </div>
      </div>
    `;
    overlay.querySelector('.prompt-title').textContent = title;
    const input = overlay.querySelector('.prompt-input');
    input.value = initial;
    input.placeholder = placeholder;
    document.body.appendChild(overlay);
    function done(v) { overlay.remove(); resolve(v); }
    overlay.querySelector('.prompt-cancel').addEventListener('click', () => done(null));
    overlay.querySelector('.prompt-ok').addEventListener('click', () => done(input.value));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// Reload the parent dir's listing in the Explorer tree after a mutation so
// the tree shows the new state without a full reload. If the mutated path
// IS the tree root, we reload the root itself.
async function exRefreshDir(absPath) {
  const target = exNormPath(absPath);
  exState.childrenByPath.delete(target);
  await exLoadDir(target);
}

function exParentDirOf(absPath) {
  // Like exParentOf but treats a drive root as itself (so refresh at root works)
  const parent = exParentOf(absPath);
  return parent || absPath;
}

/* ---------- Explorer right-click actions ---------- */

async function exActionNewFolder(parentAbsPath) {
  const name = await promptInline('새 폴더 이름', '', 'new-folder');
  if (!name) return;
  const target = `${parentAbsPath.replace(/[\\/]+$/, '')}/${name}`;
  try {
    await apiMutate('/api/fs/mkdir', 'POST', { path: target });
    await exRefreshDir(parentAbsPath);
    exState.expanded.add(parentAbsPath);
    exRender();
    toast(`폴더 생성: ${name}`, 'ok', 2500);
  } catch (e) {
    toast(`mkdir 실패: ${e.body?.error || e.message}`, 'err');
  }
}

async function exActionNewFile(parentAbsPath) {
  const name = await promptInline('새 파일 이름 (.txt/.md/.json 등 텍스트 확장자)', '', 'notes.md');
  if (!name) return;
  const target = `${parentAbsPath.replace(/[\\/]+$/, '')}/${name}`;
  try {
    await apiMutate('/api/fs/write', 'PUT', { path: target, content: '', createIfMissing: true });
    await exRefreshDir(parentAbsPath);
    exState.expanded.add(parentAbsPath);
    exRender();
    toast(`파일 생성: ${name}`, 'ok', 2500);
  } catch (e) {
    toast(`new file 실패: ${e.body?.error || e.message}`, 'err');
  }
}

async function exActionRename(entry) {
  const oldName = entry.name || entry.path.split(/[\\/]/).pop();
  const newName = await promptInline('이름 바꾸기', oldName, oldName);
  if (!newName || newName === oldName) return;
  const parent = exParentOf(entry.path);
  if (!parent) { toast('cannot rename a drive root', 'err'); return; }
  const newPath = `${parent.replace(/[\\/]+$/, '')}/${newName}`;
  try {
    await apiMutate('/api/fs/rename', 'PATCH', { from: entry.path, to: newPath });
    await exRefreshDir(parent);
    exRender();
    toast(`이름 변경: ${oldName} → ${newName}`, 'ok', 2500);
  } catch (e) {
    toast(`rename 실패: ${e.body?.error || e.message}`, 'err');
  }
}

async function exActionDelete(entry) {
  const isDir = entry.kind === 'directory';
  const label = isDir ? '폴더' : '파일';
  if (!confirm(`"${entry.name}" ${label}을(를) 삭제할까요?${isDir ? '\n안에 있는 모든 항목이 같이 사라집니다.' : ''}\n복구 불가.`)) return;
  const url = `/api/fs/entry?path=${encodeURIComponent(entry.path)}${isDir ? '&recursive=true' : ''}`;
  try {
    await apiMutate(url, 'DELETE');
    const parent = exParentOf(entry.path) || entry.path;
    await exRefreshDir(parent);
    if (exState.selected === entry.path) exState.selected = null;
    exState.expanded.delete(entry.path);
    exRender();
    // Close any open file pane that pointed at the deleted path
    const stale = state.panes.find((p) => p.kind === 'file' && p.filePath === entry.path);
    if (stale) closePane(stale.id);
    toast(`${label} 삭제: ${entry.name}`, 'ok', 2500);
  } catch (e) {
    toast(`삭제 실패: ${e.body?.error || e.message}`, 'err');
  }
}

async function exActionUpload(parentAbsPath) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.addEventListener('change', async () => {
    const files = [...(picker.files || [])];
    if (!files.length) return;
    let okCount = 0;
    for (const f of files) {
      try {
        const entry = await uploadFile(parentAbsPath, f);
        okCount++;
        toast(`업로드: ${entry.name} (${formatBytes(entry.bytesWritten)})`, 'ok', 2500);
      } catch (e) {
        toast(`업로드 실패 ${f.name}: ${e.body?.error || e.message}`, 'err');
      }
    }
    if (okCount > 0) {
      await exRefreshDir(parentAbsPath);
      exState.expanded.add(parentAbsPath);
      exRender();
    }
  });
  picker.click();
}

function formatBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`;
  return `${(n / 1073741824).toFixed(2)}GB`;
}

function openExplorerCtxMenu(entry, ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const isDir = entry.kind === 'directory';
  const isLink = entry.isLink;
  const items = [];
  if (isDir) {
    items.push({ label: '새 폴더', onClick: () => exActionNewFolder(entry.path) });
    items.push({ label: '새 텍스트 파일', onClick: () => exActionNewFile(entry.path) });
    items.push({ label: '파일 업로드…', onClick: () => exActionUpload(entry.path) });
    items.push('---');
  } else {
    items.push({ label: '슬롯에 열기', onClick: () => openFileInSlot(entry) });
    items.push('---');
  }
  items.push({ label: '이름 바꾸기', disabled: isLink, onClick: () => exActionRename(entry) });
  items.push({ label: '삭제', danger: true, onClick: () => exActionDelete(entry) });
  items.push('---');
  items.push({ label: '새로고침', onClick: async () => {
    await exRefreshDir(isDir ? entry.path : (exParentOf(entry.path) || entry.path));
    exRender();
  }});
  openCtxMenu(items, ev.clientX, ev.clientY);
}

/* ---------- Explorer tree context menu wiring (re-render hook) ---------- */
// We monkey-patch exRenderNode at runtime to attach contextmenu listeners to
// each node it produces — keeps the original render function untouched and
// makes the Phase 2 wiring a single point we can unhook later.
const _origExRenderNode = exRenderNode;
exRenderNode = function patchedExRenderNode(entry, depth, isRoot = false) {
  const wrap = _origExRenderNode(entry, depth, isRoot);
  const node = wrap.querySelector('.exp-node');
  if (node) node.addEventListener('contextmenu', (e) => openExplorerCtxMenu(entry, e));
  return wrap;
};
// Re-render the tree so the freshly-attached contextmenu listener takes effect
// for the already-mounted root node (subsequent expansions also pick it up).
if (exState.tab === 'explorer') exRender();

/* ============================================================
 * File pane edit mode (text only) + CAS save
 * ============================================================ */

// Edit mode is a per-pane flag stored as p.editMode. When true, render
// the body as a <textarea> seeded with p.content. Save uses expectedVersion
// from p.fileVersion (captured at read time).

function fileVersionFromRead(p, r) {
  // r is the JSON returned by /api/fs/read
  p.fileVersion = r.version || null;
}

// Patch openFileInSlot to capture version stamp after read
const _origOpenFileInSlot = openFileInSlot;
openFileInSlot = async function patchedOpenFileInSlot(entry) {
  await _origOpenFileInSlot(entry);
  const p = paneByFilePath(entry.path);
  if (!p) return;
  // The read response was consumed in _origOpenFileInSlot; we don't have direct
  // access to its `version` field there. Refetch lightweight stat by calling
  // read once more if we don't have it. Cheap on text files (already cached
  // in memory by the OS) and only happens once per open.
  if (!p.fileVersion && p.contentKind === 'text' && p.filePath) {
    try {
      const r = await api(`/api/fs/read?path=${encodeURIComponent(p.filePath)}`);
      fileVersionFromRead(p, r);
    } catch {}
  }
  // Inject Edit button + Save button into the pane header once mounted
  attachFileEditControls(p);
};

function attachFileEditControls(p) {
  if (!p?.cellEl || p.kind !== 'file' || p.contentKind !== 'text') return;
  const tools = p.cellEl.querySelector('.session-tools');
  if (!tools || tools.querySelector('[data-act="edit"]')) return;
  const close = tools.querySelector('[data-act="close"]');
  const editBtn = document.createElement('div');
  editBtn.className = 'btn';
  editBtn.dataset.act = 'edit';
  editBtn.title = 'Edit (replace pane body with editor)';
  editBtn.textContent = '✎';
  editBtn.addEventListener('click', (e) => { e.stopPropagation(); fileEnterEditMode(p); });
  const saveBtn = document.createElement('div');
  saveBtn.className = 'btn';
  saveBtn.dataset.act = 'save';
  saveBtn.title = 'Save (Ctrl+S)';
  saveBtn.textContent = '💾';
  saveBtn.style.display = 'none';
  saveBtn.addEventListener('click', (e) => { e.stopPropagation(); fileSave(p); });
  tools.insertBefore(editBtn, close);
  tools.insertBefore(saveBtn, close);
}

function fileEnterEditMode(p) {
  if (!p.cellEl) return;
  p.editMode = true;
  const body = p.cellEl.querySelector('.file-body');
  if (!body) return;
  body.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'fx-editor';
  ta.spellcheck = false;
  ta.value = p.content ?? '';
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      fileSave(p);
    }
  });
  body.appendChild(ta);
  p.editorEl = ta;
  // Toggle button visibility
  const editBtn = p.cellEl.querySelector('[data-act="edit"]');
  const saveBtn = p.cellEl.querySelector('[data-act="save"]');
  if (editBtn) editBtn.style.display = 'none';
  if (saveBtn) saveBtn.style.display = '';
  // Status bar: switch from "read-only" to "edit · unsaved"
  const sbModel = p.cellEl.querySelector('.statusbar .sb-model');
  if (sbModel) sbModel.textContent = `${p.language || 'text'} · edit`;
  setTimeout(() => ta.focus(), 0);
}

async function fileSave(p) {
  if (!p.editorEl) return;
  const newContent = p.editorEl.value;
  try {
    const r = await apiMutate('/api/fs/write', 'PUT', {
      path: p.filePath,
      content: newContent,
      expectedVersion: p.fileVersion || undefined,
      createIfMissing: !p.fileVersion,
    });
    p.content = newContent;
    p.fileVersion = r.entry?.version || null;
    toast(`저장: ${p.fileName} (${formatBytes(r.entry?.version?.size)})`, 'ok', 2500);
    // Stay in edit mode (no jarring view switch). Update statusbar.
    const sbRight = p.cellEl.querySelector('.statusbar .sb-right');
    if (sbRight) sbRight.textContent = 'saved';
  } catch (e) {
    if (e.body?.error === 'stale-version') {
      const reload = confirm('파일이 외부에서 수정되었습니다. 디스크 내용으로 다시 읽을까요? (취소 = 내 편집 유지)');
      if (reload) {
        try {
          const r = await api(`/api/fs/read?path=${encodeURIComponent(p.filePath)}`);
          p.content = r.content;
          fileVersionFromRead(p, r);
          if (p.editorEl) p.editorEl.value = r.content;
          toast('reloaded from disk', 'amber', 2500);
        } catch (re) {
          toast(`reload 실패: ${re.message}`, 'err');
        }
      }
    } else {
      toast(`저장 실패: ${e.body?.error || e.message}`, 'err');
    }
  }
}

/* ============================================================
 * Terminal pane drag-drop overlay + clipboard paste
 * (Telegram-style: drop files / paste screenshot → upload into
 *  session's cwd → echo the new path back to the terminal so
 *  the running claude/devplatform/shell can `cat` it immediately.)
 * ============================================================ */

// Per-pane wiring is idempotent — buildLayout calls this every layout. The
// .drop-overlay element is created once per pane mount; subsequent calls
// re-attach handlers to the same overlay if it's still there.
function attachTerminalDropHandlers(p) {
  if (!p?.cellEl) return;
  if (p.kind === 'file') return; // file panes have their own editor
  if (!p.cwd) return;            // no upload target

  const cell = p.cellEl;
  if (cell.dataset.dropWired === '1') return;
  cell.dataset.dropWired = '1';

  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay';
  overlay.innerHTML = `
    <div class="drop-overlay-card">
      <div class="drop-overlay-icon">⇪</div>
      <div class="drop-overlay-title">drop to upload</div>
      <div class="drop-overlay-sub"></div>
    </div>
  `;
  overlay.querySelector('.drop-overlay-sub').textContent = `→ ${p.cwd}`;
  cell.appendChild(overlay);

  let depth = 0;
  cell.addEventListener('dragenter', (e) => {
    if (!eventHasFiles(e)) return;
    depth++;
    overlay.classList.add('active');
    e.preventDefault();
  });
  cell.addEventListener('dragover', (e) => {
    if (!eventHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  cell.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove('active');
  });
  cell.addEventListener('drop', async (e) => {
    if (!eventHasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('active');
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    await uploadFilesToTerminal(p, files);
  });
}

function eventHasFiles(e) {
  const t = e.dataTransfer;
  if (!t) return false;
  if (t.types && [...t.types].includes('Files')) return true;
  return false;
}

async function uploadFilesToTerminal(p, files) {
  if (!p.cwd) return;
  for (const f of files) {
    // Pre-upload echo so user sees activity even on slow networks
    termEcho(p, `\x1b[2m[upload starting: ${f.name} (${formatBytes(f.size)})]\x1b[0m`);
    try {
      const entry = await uploadFile(p.cwd, f);
      const rel = `./${entry.name}`;
      termEcho(p, `\x1b[36m[📎 uploaded → ${rel}]  ${formatBytes(entry.bytesWritten)}\x1b[0m`);
    } catch (e) {
      const msg = e.body?.error || e.message;
      termEcho(p, `\x1b[31m[upload failed: ${f.name}: ${msg}]\x1b[0m`);
      toast(`업로드 실패 ${f.name}: ${msg}`, 'err');
    }
  }
}

function termEcho(p, msg) {
  if (!p?.term) return;
  try { p.term.write(`\r\n${msg}\r\n`); } catch {}
}

// Clipboard paste: when the user pastes an image (e.g. screenshot) while a
// terminal pane is focused, treat it as a file upload. Text paste is left to
// xterm's own paste handler (it routes to PTY stdin).
document.addEventListener('paste', (e) => {
  const active = paneById(state.slots[state.activeSlot]);
  if (!active || active.kind === 'file') return;
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) {
        // Screenshots usually arrive as "image.png" with no name; synthesize one.
        const named = f.name ? f : new File([f], `clipboard-${Date.now()}.${(f.type.split('/')[1] || 'bin')}`, { type: f.type });
        files.push(named);
      }
    }
  }
  if (files.length === 0) return;
  e.preventDefault();
  void uploadFilesToTerminal(active, files);
});

// Wire drop handlers on every buildLayout — patch original.
const _origBuildLayout = buildLayout;
buildLayout = function patchedBuildLayout() {
  _origBuildLayout();
  for (const id of state.slots) {
    const p = id && paneById(id);
    if (p) attachTerminalDropHandlers(p);
  }
};
// Re-run for already-mounted panes from initial buildLayout()
for (const id of state.slots) {
  const p = id && paneById(id);
  if (p) attachTerminalDropHandlers(p);
}

checkAuth();
