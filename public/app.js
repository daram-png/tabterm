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
  const list = $('#sidebar-list');
  list.innerHTML = '';

  // dynamic sessions (kind=session)
  const sessions = state.panes.filter((p) => p.kind === 'session');
  if (sessions.length) {
    const h = document.createElement('div');
    h.className = 'ws-section';
    h.textContent = 'sessions';
    list.appendChild(h);
    for (const p of sessions) list.appendChild(renderRow(p, 'session'));
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
}

function renderRow(p, kindLabel) {
  const el = document.createElement('div');
  const slot = slotOfPane(p.id);
  const isActive = slot >= 0 && slot === state.activeSlot;
  el.className = 'ws' + (isActive ? ' active' : '');
  el.dataset.paneId = p.id;

  let glyph, gkind;
  if (p.dead) { glyph = '✗'; gkind = 'dead'; }
  else if (p.kind === 'session') { glyph = '◆'; gkind = 'session'; }
  else { glyph = '●'; gkind = 'run'; }

  const meta = p.dead ? `exit ${p.exitCode ?? '?'}` : (slot >= 0 ? (slot === 0 ? 'in slot L' : 'in slot R') : 'detached');
  const slotTag = slot >= 0 ? `<span class="ws-slot-tag">${slot === 0 ? 'L' : 'R'}</span>` : '';

  el.innerHTML = `
    <span class="ws-glyph ${gkind}">${glyph}</span>
    ${slotTag}
    <div class="ws-name">${escapeHtml(p.label)}</div>
    <div class="ws-meta">${escapeHtml(meta)}</div>
    <div class="ws-path">${escapeHtml(p.cwd || '')}</div>
  `;
  el.addEventListener('click', () => assignToSlot(p.id));
  return el;
}

function renderWorkerRow(i, p) {
  const el = document.createElement('div');
  const slot = p ? slotOfPane(p.id) : -1;
  const isActive = slot >= 0 && slot === state.activeSlot;
  el.className = 'ws' + (isActive ? ' active' : '');
  el.dataset.workerIndex = String(i);

  const dirMissing = state.preflightIssues.some((s) => s.includes(`${state.workerPrefix}${i}`));
  let glyph = '*', gkind = 'idle', meta = 'idle';
  if (dirMissing) { glyph = '!'; gkind = 'dead'; meta = 'worker dir missing'; }
  else if (p && p.dead) { glyph = '✗'; gkind = 'dead'; meta = `exit ${p.exitCode ?? '?'}`; }
  else if (p) {
    glyph = '●'; gkind = 'run';
    meta = slot >= 0 ? (slot === 0 ? 'in slot L' : 'in slot R') : 'detached';
  }
  const slotTag = (p && slot >= 0) ? `<span class="ws-slot-tag">${slot === 0 ? 'L' : 'R'}</span>` : '';

  el.innerHTML = `
    <span class="ws-glyph ${gkind}">${glyph}</span>
    ${slotTag}
    <div class="ws-name">${escapeHtml(state.workerPrefix + i)}</div>
    <div class="ws-meta">${escapeHtml(meta)}</div>
    <div class="ws-path">${escapeHtml(state.workersRoot + '/' + state.workerPrefix + i)}</div>
  `;
  el.addEventListener('click', async () => {
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
    chip.querySelector('.slot-label').textContent = p ? p.label : 'empty';
    chip.onclick = pid ? () => { state.activeSlot = i; renderSidebar(); renderSlotStrip(); paneById(pid)?.term?.focus(); } : null;
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
        <div class="session-name">${escapeHtml(p.label)} <span class="ver">${slotLabel}</span></div>
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
  activePane?.term?.focus();
  $('#wc-title-text').textContent = activePane ? `tabterm — ${activePane.label}` : 'tabterm';
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
  await closePane(id);
  try {
    const body = kind === 'worker'
      ? { kind: 'worker', workerIndex: idx, cols: 120, rows: 32 }
      : { kind: 'session', cols: 120, rows: 32 };
    const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
    addPaneFromServer(r.session);
    assignToSlot(r.session.id);
  } catch (err) { toast(`restart failed: ${err.message || err}`, 'err'); }
}

/* ---------- new session ---------- */
$('#btn-new-session').addEventListener('click', async () => {
  try {
    const r = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ kind: 'session', cols: 120, rows: 32 }),
    });
    addPaneFromServer(r.session);
    assignToSlot(r.session.id);
    toast(`new session: ${r.session.label}`, 'ok', 3000);
  } catch (err) { toast(`new session failed: ${err.message || err}`, 'err'); }
});

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
    const offset = window.innerHeight - vv.height;
    $('#kbd-spacer').style.height = offset > 0 ? `${offset}px` : '0';
    scheduleFitAll();
  });
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
  } catch (e) { console.error(e); }

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

  buildLayout();
  renderSidebar();
  renderSlotStrip();
}

checkAuth();
