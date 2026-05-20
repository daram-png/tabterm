# Changelog

## 0.4.3 — 2026-05-20

Roll back the IME composition layer (0.4.1 / 0.4.2). Restore 0.4.0 input behavior on all platforms.

### Input
- 0.4.1 added a `compositionstart`/`end` guard on xterm's helper textarea, intending to fix the iPad Hangul jamo-split bug.
- 0.4.2 removed the double-send but kept the `_composing` guard.
- Both versions race against xterm.js 5.x's own internal IME handling: xterm registers its own composition listeners first, so when `compositionend` fires, xterm emits `onData("composed string")` while our `_composing` flag is still `true` (our listener has not run yet). The onData is then dropped by our guard, causing characters to be lost on desktop Chrome/Edge (e.g. typing "지금은 마지막 글자만 나온다" → only the last character survives).
- Symptom was visible only on external desktops; the host machine kept showing the original 0.4.0 cached `app.js` from its service worker.
- Fix: remove `attachImeHandlers`, remove the guard in `onData`, restore the original one-line passthrough. xterm 5.x already handles IME composition correctly on desktop browsers — no extra layer needed.
- iPad / iOS Safari Hangul keyboard still produces decomposed jamo (composition events never fire there). That requires a separate floating input layer, tracked as a follow-up.
- Service worker cache bumped to `tabterm-v7-ime-rollback`.

## 0.4.2 — 2026-05-20

Desktop IME double-send regression fix.

### Input
- 0.4.1 introduced a double-send: `compositionend` handler called `sendWs(e.data)` AND xterm itself fired `onData` with the composed text right after, producing duplicate characters on desktop Chrome/Edge (e.g. "일단" → "일단단" after space).
- Removed the explicit `sendWs` in `compositionend`. Now we only flip the `_composing` guard; xterm's native `onData` handles the actual send on desktop IMEs where composition events work.
- Note: iPad / iOS Safari Hangul keyboard still has the jamo-split issue because it does not fire `compositionstart/end` consistently. A separate floating input layer is required for iOS — tracked as a follow-up.
- Service worker cache bumped to `tabterm-v6-ime-fix`.

## 0.4.1 — 2026-05-20

iPad / iOS Safari Hangul IME jamo-split fix.

### Input
- Hangul (and any CJK IME) input from iPad Safari was sending decomposed jamo (ㅈ + ㅏ + ㅈ → 자자) to the PTY because xterm.js's onData fires per input event regardless of IME composition state on iOS.
- Added an IME composition layer on the xterm helper textarea (`attachImeHandlers` in `public/app.js`):
  - `compositionstart` → mark pane as composing, suppress onData passthrough.
  - `compositionend` → send the completed composed string in one shot to the PTY.
  - `blur` → fail-safe reset in case `compositionend` never fires (some iOS keyboards).
- Service worker cache version bumped to `tabterm-v5-ime` so existing installs pick up the new `app.js`.

## 0.4.0 — 2026-05-20

Two-slot layout + separation between fixed ccx workers and general sessions.

### Layout
- Removed traffic-light triplet and the duplicate top tab strip (sidebar already lists every session — top tabs were redundant).
- Workspace is now exactly **two slots** (L / R). Clicking workers/sessions in the sidebar round-robins: 1st pick → L, 2nd pick → R, 3rd pick → L (replaces), 4th → R (replaces), and so on. PTYs in slots that get replaced stay alive in the background and reappear when clicked again.
- New minimal toolbar at top of main column: two slot chips (`L: worker-3`, `R: worker-5`) showing what's currently mounted, plus soft-stop / kill / logout buttons.
- New per-pane "Detach" tool (⤓) — removes a pane from its slot without killing the PTY, so the slot is freed for another session while the original keeps running.
- Empty state: when both slots are empty, workspace shows a hint instead of blank space.

### Sessions
- `POST /api/sessions` now takes `kind: 'worker' | 'session'`:
  - `kind=worker` (default if `workerIndex` is given): existing ccx flow — `cwd=workers_root/worker-N`, hydra preflight gating, worker env (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_STATE_DIR`) auto-loaded from `.ccx-env` or `start-ccx.bat`, `claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official`.
  - `kind=session`: fresh general session — creates `workers_root/<NEW_SESSION_PREFIX><yyyymmddhhmmss>-<hex>` directory, no ccx env, no telegram plugin, args from `SESSION_CLAUDE_ARGS` (default empty = plain `claude`). HydraTeams preflight is skipped.
- `+ New session` button in the sidebar footer triggers `kind=session`.
- Session list response includes `kind` and `workerIndex`.

### Sidebar
- Two sections: dynamic **sessions** (when any exist, listed at top) and fixed **workers (ccx)** (always shown, 0..N).
- Each row shows a slot tag (`L` / `R`) on the right when mounted, plus glyph + label + meta + path.

### .env additions
- `NEW_SESSION_PREFIX=session-`
- `SESSION_CLAUDE_ARGS=` (empty default)

### Files touched
- `server/index.js`, `server/sessions.js` — `kind` routing, meta field on summary
- `.env`, `.env.example` — new keys
- `public/index.html` — toolbar restructured, traffic/tablist removed
- `public/styles.css` — `.toolbar` / `.slot-chip` / `.ws-section` / `.ws-slot-tag`
- `public/app.js` — slot routing (`assignToSlot`, `detachFromSlots`, `state.slots`, `state.slotCursor`), sidebar two-section render
- `public/sw.js` — VERSION → `tabterm-v4-slots`

## 0.3.0 — 2026-05-20

cmux-style UI redesign. Visual layout ported from Anthropic Design (`cmux Terminal Manager`) handoff bundle to vanilla DOM. PTY/WS/auth/CSRF layer untouched.

### Added
- `winchrome` top strip with toggle-sidebar / re-check-HydraTeams / new-tab buttons and centered `tabterm` title.
- Left sidebar (`260px`, collapsible) listing worker-0..N as cmux-style entries: status glyph (●/✗/*), name, meta (`attached` / `exit N` / `worker dir missing`), path. Active worker highlighted blue. Click idle → spawn that worker; click attached → switch to that tab.
- Tab strip styled to match cmux (status dot variants `run`/`alert`/`dead` with glow, hover-revealed close + restart buttons).
- Per-pane `session-header` (Claude pixel-art mascot SVG + "Claude Code" name + version chip + sub-line "ccx hybrid · path" + soft-stop/restart/close tool buttons).
- Per-pane `statusbar` (path + model line + right-side state dot `attached` / `exit N`).
- Bottom `toast` for non-blocking status (HydraTeams ready/not-ready, restart errors, etc.) with auto-dismiss + manual close.
- Pane focus bar (2px accent stripe on left of focused pane) + `pane.focused` shading on session header.
- Geist / Geist Mono fonts (Google Fonts) — mono used for terminal, status bar, path/version chips.
- Tab restart button (`↻`) replaces previous inline DOM mutation.

### Changed
- `public/index.html` — restructured to `app > winchrome + shell(sidebar + main) + kbd-spacer`, with new toolbar in `.titlebar`.
- `public/styles.css` — full cmux palette (`--bg #0a0a0a`, `--panel #111`, `--tab-active #1c1c1e`, `--accent #5b8ef7`, `--text #ededed`, `--text-2 #a3a3a3`, `--muted #737373`, `--line #262626`, `--green #4ade80`, `--amber #f59e0b`, `--red #f87171`, `--magenta #c084fc`, `--cyan #67e8f9`). xterm.js theme overrides match.
- `public/app.js` — rewritten layout: `renderSidebar()` + `renderTabs()` + `buildLayout()` + `paneHtml()` (session header + terminal host + statusbar). Split.js gutter slimmed to 1px to match design.
- Service worker version bumped to `tabterm-v3-cmux` so old shell cache invalidates on next load.

### Security review (Claude + Codex peer)
- Codex independent draft confirmed: drop fake workspace data, keep PTY/WS/auth, port CSS tokens + layout numbers. No disagreement raised.
- All user-controlled strings (labels, cwd, workersRoot, workerPrefix, exit codes) routed through `escapeHtml()` before `innerHTML`.
- Toast/title text via `textContent` only. No new fetch/WS endpoints introduced.

### Defer to v0.4
- Vertical split (current build is horizontal-only).
- ClaudeMascot color refinement / second variant.
- Session header tool buttons (search/copy/more) currently no-op stubs.
- Real branch / git status / model selection in statusbar.
- Multiple-workspace concept (cmux mockup's sidebar has multi-workspace switching; tabterm currently single-workspace).

## 0.2.0 — 2026-05-20

ccx mode integration. Tabterm now owns the HydraTeams proxy lifecycle and per-worker Telegram env setup, replacing `start-ccx-full-all.bat`.

### Added
- `server/hydra.js` — single in-process `ensureHydraReady()` that health-checks `http://127.0.0.1:3456/health`, spawns `bash hydra-launcher.sh start` if down, polls up to 10s. JS-layer singleton lock (no parallel launcher spawns) plus 5s freshness window. New `POST /api/hydra/ensure` endpoint for manual re-check from the UI.
- `server/config.js` — `loadWorkerEnv(workerDir)` reads per-worker secrets. Prefers a new dedicated `.ccx-env` file (`TELEGRAM_BOT_TOKEN=...` / `TELEGRAM_STATE_DIR=...`). Falls back to parsing existing `start-ccx.bat` (both `set NAME=VAL` and `set "NAME=VAL"` forms supported; quotes stripped).
- `.env.example` — new keys: `CLAUDE_COMMAND`, `CLAUDE_ARGS` (default `--dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official`), `ANTHROPIC_BASE_URL`, `HYDRATEAMS_ENABLED`, `HYDRATEAMS_HEALTH_URL`, `HYDRATEAMS_LAUNCHER`, `HYDRATEAMS_BASH`, polling tuning.
- Boot preflight: tabterm awaits hydra ready before listening; logs warn if proxy never came up.
- POST `/api/sessions` gates on hydra ready and injects merged env: `ANTHROPIC_BASE_URL` + workerEnv (TELEGRAM_BOT_TOKEN, TELEGRAM_STATE_DIR) on top of `process.env`. Response includes `envSource` (`.ccx-env` | `start-ccx.bat` | `none`) and warnings.
- Frontend: on session exit, dead tab shows a `↻` Restart button that closes the dead session and re-spawns with same worker index. CSS styles the Restart button.

### Changed
- Removed `WORKER_COMMAND` from `.env.example`. Use `CLAUDE_COMMAND` (and `CLAUDE_ARGS`) instead. `claude` is invoked directly inside `cmd /d /s /c chcp 65001 >NUL & <cmd> <args>` per tab.
- `pty.js` argument building hardened: `%` escaped to `%%`, command path quoted if it has spaces/specials, args passed through `quoteCmdArg`. `LANG`/`LC_ALL` no longer force `ko_KR.UTF-8` — falls back to whatever the inherited environment provides.
- `sessions.create({ extraEnv, claudeArgs })` now wires worker env into the spawned PTY.

### Security review
- Two Codex peer reviews on this integration.
- Resolved: 1 RED (cmd.exe %VAR% expansion + quoting), 2 YELLOW (bat parsing `set "K=V"` form, locale forcing).
- Tokens stay beside their worker (`.ccx-env` or existing `start-ccx.bat`) — never duplicated into tabterm `.env`.

### Migration from 0.1.0
- Delete or update existing `.env` from new `.env.example`. The key removed is `WORKER_COMMAND`. New keys default to ccx defaults; if you want plain Claude (no proxy/telegram), set `HYDRATEAMS_ENABLED=false` and `CLAUDE_ARGS=` (empty).
- No need to edit `C:\workspace\worker-N\start-ccx.bat` — tabterm parses tokens out of them automatically. Optional: create `.ccx-env` in each worker dir if you'd rather not have tokens inside a `.bat`.

## 0.1.0 — 2026-05-20

Initial implementation. Windows-native browser PTY multiplexer for headless servers, accessed via iPad PWA over Tailscale Serve.

### Added
- Fastify server with HTTP bind (default `127.0.0.1:3007`) — HTTPS termination delegated to Tailscale Serve.
- `node-pty` ConPTY wrapper. Workers spawned via `cmd /d /s /c chcp 65001 >NUL & <WORKER_COMMAND>` with `PYTHONUTF8=1` for Korean output.
- Session store with 2MB ring buffer (byte-level, newline-aware trim + 4KB slack) for reattach after browser refresh.
- WebSocket protocol: JSON envelope client→server (`input`/`resize`/`signal`/`ping`), binary stdout server→client.
- Auth: scrypt N=65536 r=8 p=1, 16-byte salt, timing-safe compare. CLI `npm run setup-pass` or web setup flow.
- Session cookie: httpOnly + SameSite=Strict + Secure (configurable). CSRF token header on POST/DELETE.
- Rate-limit on `/api/auth/login` (5/min per IP, configurable).
- WS handshake validates cookie + Origin, honors `PUBLIC_ORIGIN` env and `x-forwarded-host` for Tailscale Serve.
- Lazy spawn (no auto-spawn on boot) — preflight reports missing worker dirs but does not crash.
- Append-only audit log at `data/audit.log` (login ok/fail/logout, session create/exit/delete, server start/shutdown).
- Graceful shutdown: SIGINT/SIGTERM/SIGBREAK kill all PTYs before exit.
- Frontend: vanilla JS + xterm.js + Split.js (gutter resize), single tab bar with active highlight + dead state.
- PWA: manifest standalone + service worker that caches shell only (never API/WS/auth).
- iPad: visualViewport listener with keyboard-area spacer; `viewport-fit=cover` + `safe-area-inset` CSS.
- Soft-stop button (sends Ctrl+C `\x03` over WS) vs hard kill (DELETE session).

### Security review
- Two Codex peer reviews (design + implementation). Resolved: 2 RED, 6 YELLOW, 4 BLUE.
- Cookie name now served by `/api/auth/status` so client never hardcodes it.
- Logout requires auth + CSRF.
- `detach` cleans up dead+orphan sessions.
- TextDecoder flushed on WS close to avoid losing trailing multi-byte char.

### Known v1 limits
- PTYs do not survive server restart (no disk-backed replay yet).
- Horizontal split only (vertical split deferred).
- No on-screen Ctrl/Esc bar for iPad virtual keyboard yet.
