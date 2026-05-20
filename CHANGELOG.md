# Changelog

## 0.5.2 — 2026-05-20

dotenv `override: true` — fixes all-workers Telegram plugin unresponsive (ccx peer-reviewed: Claude ∥ Codex final arbitration).

### Bug
- All 8 tabterm-spawned workers had their Telegram plugin alive in process (MCP server registered, tool `plugin:telegram:telegram` listed) but no inbound user messages ever reached the conversation (JSONL had zero real user turns, only stop-hook auto messages).
- Direct `start-ccx.bat` execution worked fine — bot responded as expected.

### Root cause
- A pre-existing User-scope environment variable `CLAUDE_ARGS=--dangerously-skip-permissions` (length 30) was overriding tabterm's `.env` value `CLAUDE_ARGS=--dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official` (length 81).
- `import 'dotenv/config'` calls `dotenv.config()` with defaults, which keeps pre-existing `process.env` values (documented behavior, `override:false`). The longer value from `.env` was silently dropped at startup.
- Spawned claude command line therefore lacked `--channels plugin:telegram@claude-plugins-official`. The Telegram MCP server still loaded via `enabledPlugins`, and its tool was registered — but the per-channel input routing that `--channels` enables was never wired. Bot received Telegram updates fine (`pending_update_count=0`) but had no path to inject them into the assistant turn stream.
- `start-ccx.bat` works because its last line passes the flag as hardcoded argv, bypassing env-resolution entirely.

### Fix
- `server/index.js`: replaced `import 'dotenv/config'` with explicit `import dotenv from 'dotenv'; dotenv.config({ override: true });`.
- After this change, `.env` becomes the authoritative source for tabterm config — stale User/Machine env vars no longer silently mask updates to the `.env` file.

### Verification
- Direct dotenv probe from tabterm dir after patch: `process.env.CLAUDE_ARGS` resolves to the full 81-char value including `--channels plugin:telegram@claude-plugins-official`.
- tabterm restart + worker re-spawn confirmed: Telegram round-trip end-to-end works — bot now receives inbound messages and the conversation turn stream is wired up correctly on all workers.

## 0.5.1 — 2026-05-20

iPad / iOS Safari Hangul IME jamo-split fix — bottom input rail (ccx peer-reviewed: Claude ∥ Codex).

### Input
- iPad Safari was sending decomposed jamo (자모) to the PTY because iOS Safari does not fire `compositionstart/compositionend` consistently on xterm.js's hidden helper textarea. The 0.4.1 attempt to guard the helper textarea raced with xterm's own internal IME listeners (rolled back in 0.4.3). xterm 5.x cannot be patched without forking.
- Solution: a dedicated iOS-only **bottom IME rail** (`#ime-bar` in `public/index.html`). On iPad-like devices we route all keyboard input through this rail instead of xterm's helper textarea. xterm renders the terminal output unchanged.
- iOS detection: `/iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1)`. iPadOS 13+ desktop UA is covered. Desktop browsers (any width) are unaffected.
- Rail behavior:
  - Textarea owns the Hangul composition. Enter (no shift) → flush the buffer to PTY (`{type:'input', data:value}`), clear textarea. Shift+Enter → newline inside textarea (multi-line input).
  - Aux key strip: `Esc`, `Tab`, `^C` (Ctrl+C), `⌫` (Backspace = 0x7f), `↑↓←→` (ANSI CSI sequences). Pressing any aux key flushes pending textarea content first, then sends the control sequence.
  - `blur` is a safety net: flushes any non-empty value (in case `compositionend` is the only signal and the user taps away).
- Anti-regression guards:
  - `body.ios-ime .xterm-helper-textarea { pointer-events: none; opacity: 0; }` — focus cannot return to xterm's broken IME path on iOS, eliminating the double-send / dropped-onData race entirely.
  - Desktop browsers never get `body.ios-ime`, so xterm's native IME stays in charge there (0.4.3 behavior preserved).
  - Workspace tap re-focuses the rail textarea (since xterm helper is now non-interactive on iOS).
- Layout:
  - Rail is `position: fixed; bottom: calc(env(safe-area-inset-bottom, 0px) + var(--kbd-offset, 0px))`. Existing `visualViewport.resize` handler now sets `--kbd-offset` to the iOS keyboard height so the rail stays visible above the keyboard.
  - `body.ios-ime .workspace { padding-bottom: 120px }` reserves vertical space so terminal output isn't hidden behind the rail.
- Service worker cache version bumped to `tabterm-v9-ios-ime` (forces external PCs / iPads to discard `tabterm-v6-ime-fix` / `tabterm-v7-ime-rollback` caches that were causing the "last-character-only" symptom on external Windows desktops).

### Peer review (ccx hybrid: Claude ∥ Codex equal peers, two rounds)
Round 1 (design):
- Codex suggested `pointer-events: none` on xterm helper textarea (focus-ownership) — adopted. Eliminates double-input path.
- Codex suggested `env(safe-area-inset-bottom)` and `visualViewport.resize` for keyboard avoidance — adopted.
- Codex suggested 80ms `input`-event debounce auto-flush — declined. Auto-flush would send every ASCII keystroke to PTY before the user finishes the command, making line editing unpredictable. Kept the explicit Enter/Send model with `blur` as the safety net.
- Codex suggested arrow-key escape sequences and Backspace — adopted in aux key strip.
- Codex suggested `/version` endpoint + client boot version check — declined for scope (sw `activate` cleanup already discards old caches).
- Both peers agreed: do NOT activate the rail purely on narrow viewport width; the bug is device/input-stack-specific.

Round 2 (implementation review, Codex found 1 RED + 3 YELLOW + 1 BLUE):
- **RED** — `pointer-events: none` only blocks pointer hits, not programmatic `term.focus()`. `buildLayout()` and slot-chip clicks call `pane.term.focus()`, which routes focus back to xterm's helper textarea and defeats the rail. Fixed by introducing `focusActivePane(pane)`: on iOS it focuses `#ime-input` instead of `pane.term`. Both call sites in `public/app.js` updated.
- **YELLOW 1** — Enter keydown handler did not guard against IME composition state. On Korean keyboards, Enter is used to commit composition; flushing during composition could send incomplete jamo. Added `if (e.isComposing || e.keyCode === 229) return;` guard.
- **YELLOW 2** — Buffered text could be routed to a different pane if the user clicked another slot mid-composition (`mousedown` changes `state.activeSlot` before `blur`/`click` flush runs). Added `imeTargetPaneId` lock captured on `focus`/`compositionstart`/`input`. Flush sends to the locked target, then clears the lock. Aux keys still send their control sequence to the *current* active pane (so Ctrl+C after switching slots reaches the new slot, matching user intent).
- **YELLOW 3** — `visualViewport.resize` mutated `#kbd-spacer` and `--kbd-offset` on desktop too (e.g. pinch/page zoom). Gated those mutations behind `body.ios-ime`. `scheduleFitAll()` still runs everywhere.
- **BLUE** — `initImeBar` was not idempotent. Added a `body.ios-ime` early-return guard so a hypothetical second `init()` call cannot double-bind listeners.
- Codex verified: Backspace `\x7f` (correct for Linux PTY erase), Esc/Tab/Ctrl-C/arrow CSI sequences correct, no XSS introduced, service-worker upgrade path adequate.

### Notes
- External Windows desktops that reported the "Korean shows only last character" symptom were running cached 0.4.2 code (sw `tabterm-v6-ime-fix`). The v9 service-worker version forces the cache eviction. Hard reload (or Application → Service Workers → Unregister) once on each external machine to pick up the fix.

## 0.5.0 — 2026-05-20

Watchdog + zombie cleanup + bulk boot absorbed into tabterm. `start-ccx-full-all.bat` and siblings deprecated — single `npm start` now drives the full ccx pipeline (zombie cleanup, HydraTeams preflight, worker fleet, watchdog lifecycle).

### Server
- `server/watchdog.js` — child-process lifecycle for `C:/workspace/watchdog/watchdog.js`. `startWatchdog()` spawns the script with `--config <WATCHDOG_CONFIG>` as `detached: false`, so the watchdog dies when tabterm dies. `stdio: 'ignore'` because watchdog writes its own `watchdog.log`. Skips spawn when an external watchdog is already running (detected by `watchdog.log` mtime within 90s) so a manually-started watchdog isn't duplicated. Skips entirely when `WATCHDOG_AUTOSTART=false`, when the script path is missing, or when the config is missing.
- `server/system.js` — three new endpoints, all auth+CSRF gated:
  - `POST /api/system/cleanup-zombies` enumerates running processes via `Get-CimInstance Win32_Process` (wmic is deprecated on Win11 22H2). Walks parent→child to build a protection set rooted at tabterm's own PID, the spawned watchdog PID, and every live PTY's top PID (exposed by new `sessions.getPtyPid(id)`). Kills only `bun.exe`/`claude.exe`/`node.exe` outside that set with `taskkill /F /PID`. Returns `{killed, failed, protectedPids, processCount}` and audit-logs the operation. Aborts if process enumeration returns empty (refuses to kill blindly when we can't see the tree).
  - `POST /api/system/boot-all` iterates `worker-0..N`, skips slots that already have a live worker session, calls the shared `spawnWorkerSession` helper. Default 3000ms gap (matches the old bat, configurable via `intervalMs` body param 0..30000).
  - `GET /api/system/watchdog-status` returns watchdog state + health (`healthy` < 90s log age, `degraded` 90s..600s, `dead` > 600s or log missing), a live HydraTeams probe (`/health` GET with no auto-launcher), and the last 50 watchdog.log lines.
- `server/index.js` — `spawnWorkerSession({workerIndex, label, cols, rows, ip})` extracted from the `/api/sessions` handler so boot-all and the public route share the same hydra preflight + env loading + audit logging. `/api/sessions` general-session branch kept inline. `startWatchdog` called after hydra preflight; `stopWatchdog` added to the SIGINT/SIGTERM/SIGBREAK shutdown path so Ctrl+C tears down the whole tree.
- `server/sessions.js` — `getPtyPid(id)` exposes the top PID of each live PTY so cleanup-zombies can include it in the protection set.
- `server/hydra.js` — `hydraLiveHealth()` exported. Non-spawning `/health` probe used by watchdog-status (we don't want the status query to trigger `hydra-launcher.sh`).

### Frontend
- Three new toolbar buttons in the actions group (boot-all / cleanup-zombies / watchdog-status), separated from per-session tools (soft-stop / kill / logout) by a 1px divider. Boot and cleanup ask for confirmation; cleanup spells out the protection rule in the dialog so a stray click doesn't blow away unrelated `node.exe` processes.
- Watchdog status dot lives inside the status button: `healthy` green, `degraded` amber, `dead` red, `unknown` gray. Painted on initial load and refreshed every 30s via `/api/system/watchdog-status` (also the same call the modal uses).
- Status modal renders summary table + last 50 log lines with monospace wrapping. Click outside or the X to close.
- `public/sw.js` VERSION → `tabterm-v8-watchdog`.

### Config
- `.env.example`: `WATCHDOG_AUTOSTART=true`, `WATCHDOG_PATH=C:/workspace/watchdog/watchdog.js`, `WATCHDOG_CONFIG=C:/workspace/watchdog/config-ccx-full.json`, `WATCHDOG_LOG=C:/workspace/watchdog/watchdog.log`.
- `package.json` version bumped 0.1.0 → 0.5.0 (had drifted behind the CHANGELOG).

### bat deprecation
- `C:/workspace/watchdog/start-ccx-full-all.bat`, `start-ccx-all.bat`, `start-all.bat` carry a `REM DEPRECATED 2026-05-20` block that points to `npm start` in `C:/Tools/tabterm` and explains which toolbar action covers each old step. Scheduled for removal in tabterm v0.6.
- `start-watchdog-ccx-full.bat` / `start-watchdog-ccx.bat` / `start-watchdog.bat` kept for debugging — they only spawn watchdog without touching workers, which is still useful when tabterm itself is being modified.

### Notes
- This is the first git-tracked commit set in `C:/Tools/tabterm`. `git init` ran with `.gitignore` already covering `node_modules/`, `data/auth.json`, `data/audit.log`, `.env`, `public/vendor/`, plus `logs/` added in this change. Initial `chore: initial commit — tabterm v0.4.3 baseline` precedes the v0.5 work.

### Peer review (security-auditor + code-reviewer in parallel)
- security-auditor: 0 RED / 3 YELLOW / 6 BLUE. No merge blockers. Confirmed PowerShell JSON output handling, `execFile`/`taskkill` argv safety, hydra preflight singleton, `process.pid` filter, modal XSS surface (`.textContent` on log tail).
- code-reviewer: 2 Critical / 4 Warnings / 6 BLUE — REQUEST_CHANGES. Both Critical issues applied:
  - `stopWatchdog` no longer nulls `wdProc` eagerly; the `exit` handler nulls it so `wdLastExitCode` reflects reality. Eager null happens only when `proc.kill` itself throws (process already gone).
  - `detectExternalWatchdog` mtime guard removed — it created a 90-second blind window after a crashed watchdog where re-spawn was silently refused. The PID guard (`if (wdProc) return`) is the authoritative duplicate-prevention; the mtime check is now a log-only advisory.
- Warnings applied:
  - `paintWatchdogDot` parameter renamed `state` → `dotState` to stop shadowing the module-level `state` object.
  - `sessions.getPtyPid?.()` optional chain dropped — the method always exists, the `?.` was hiding any future rename.
  - boot-all's session-refresh `catch {}` now logs to `console.warn` and toasts an amber warning so silent failures don't leave the user wondering why workers don't appear.
  - `.filter(Boolean)` on the protection-set roots widened to `Number.isInteger(x) && x > 0` for symmetry with `descendantsOf`.
  - PowerShell stdout parser strips a UTF-8 BOM before `JSON.parse` so quirky PS versions don't fail with a useless "process-list-failed".
  - cleanup-zombies confirm dialog now explicitly notes that previous-tabterm leftover `claude.exe` processes are NOT protected (PPID-orphan scenario).
- Deferred (BLUE, not worth a follow-up commit yet):
  - `tailWatchdogLog` reads the entire log file — fine for 50-line tails at 30s polling for now. Re-evaluate if a multi-month watchdog log grows past ~100MB.
  - Missing CSP header. Defense-in-depth, but X-Frame-Options + CSRF + httpOnly cookie already contain the practical risk.
  - `taskkill /T` on `stopWatchdog`: declined. Worker `claude.exe` processes are spawned by watchdog but are intentionally independent (a `cmd /B` detached child). Killing them on tabterm shutdown would regress vs `start-ccx-full-all.bat` behavior, which only kills watchdog on stop, never workers.

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
