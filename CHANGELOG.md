# Changelog

## 0.8.0 — 2026-05-25

### Added — file explorer (Phase 1: read-only viewer)

레퍼런스: [jcwleo/leominal feat: add active pane file explorer](https://github.com/jcwleo/leominal/commit/f985f5244ff09e9b49a1022ff43ab3401638f797). 디자인 차용, vanilla JS + Fastify 스택에 맞게 재구현.

- 사이드바 세션 행 kebab 메뉴에 **Open files…** 액션 추가
  - 클릭 시 full-screen modal 띄움. 좌측 트리 + 우측 디테일 패널. ESC 또는 X 로 닫기.
  - 폴더는 클릭해서 펼치고 닫음. 파일은 클릭하면 우측에 표시.
  - 텍스트 파일은 `<pre>` 로 raw (markdown 렌더링은 Phase 2 에서 도입 검토).
  - 이미지(`png/jpg/jpeg/gif/webp/bmp/ico`) 와 PDF 는 blob URL 로 `<img>` / `<iframe>` 미리보기.
  - 모바일 폭(<= 640px) 에서는 트리/디테일이 상하 split 으로 자동 전환.

### Server (server/file-explorer.js, new)

- `validateRelPath`: posix-only 경로 검증. 거부 항목 — backslash, `:` (drive letter / NTFS ADS), 절대 경로, `..` / `.` / 빈 segment, 제어 문자, 4096 자 초과
- `assertNoSymlinkSegments`: 각 path segment 에 lstat → symlink/junction/reparse point 이면 400 차단
- `assertContained`: 최종 realpath 가 root realpath 의 자손인지 startsWith + sep 검사
- `resolveSafePath`: 2단계 jail (segment-walk + realpath 컨테인먼트). symlink 외에도 Windows 트레일링 닷/공백 quirk, 대소문자 정규화 escape 까지 커버
- `listDirectory`: 디렉토리 우선 정렬, locale-aware base-insensitive. `maxEntries` 초과 시 truncate + flag
- `readTextFile`: 확장자 + basename 기반 text/markdown 분류. NUL 비율 >2% 면 415 `binary-content` (확장자 위장 binary 파일 탐지)
- `streamPreview`: ext → MIME 매핑된 binary 스트림. `Content-Type`, `Content-Length`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Cache-Control: private, no-cache` 헤더 설정

### Server routes (server/index.js)

- `GET /api/sessions/folders/:name/fs/list?path=...` — 디렉토리 리스팅
- `GET /api/sessions/folders/:name/fs/read?path=...` — 텍스트 read + `{ size, mtimeMs }` 버전 스탬프
- `GET /api/sessions/folders/:name/fs/preview?path=...` — 이미지/PDF raw stream
- 모두 `requireAuth` 만 사용 (read-only). Phase 2/3 의 write/create/move/delete 는 `requireCsrf` 추가 예정.
- `:name` 은 기존 `validateSessionFolderName` 으로 검증 (folder.name 자체가 stable identity, leominal 의 HMAC root token 불필요).

### Env limits (env override 가능)

- `FILE_LIST_MAX_ENTRIES=2000` — 한 디렉토리 리스팅 최대 항목
- `FILE_TEXT_MAX_BYTES=1048576` (1 MB) — 텍스트 read 최대
- `FILE_PREVIEW_MAX_BYTES=52428800` (50 MB) — 이미지/PDF preview 최대

### Tests

- `server/file-explorer.test.js` (new, 14 cases, node:test)
  - validateRelPath: 8 거부 패턴 (backslash/colon/absolute/dot/control/type/길이)
  - previewKindForName / languageForName / isTextName classification
  - listDirectory: 정렬 + 메타데이터 + truncated flag + traversal 거부
  - readTextFile: text 성공, 413 size limit, 415 not-text, 415 binary-content (NUL 위장)
  - resolveSafePath: symlink mid-path 거부 (Windows junction 으로 best-effort, 권한 없으면 skip)

### Out of scope (별도 PR)

- Phase 2 (v0.8.1): write, create, expectedVersion-based stale-save 409, textarea editor
- Phase 3 (v0.9.0): delete (HMAC preview token 60s TTL), move/rename, descendant count confirm

### Files changed

- `server/file-explorer.js` (new, ~260 LOC)
- `server/file-explorer.test.js` (new, 14 cases)
- `server/index.js` (+78: imports, env consts, 3 routes, 2 helpers)
- `public/app.js` (+220: state, openFileExplorer, fxLoadList/Read/Preview, fxRender, kebab button)
- `public/index.html` (+13: modal shell)
- `public/styles.css` (+80: modal + tree + detail + responsive)
- `public/sw.js` VERSION → `tabterm-v21-file-explorer-phase1`
- `package.json` 0.7.5 → 0.8.0

### Process notes

- ccx peer review 수행: PEER A self draft + PEER B GPT (ultrabrain) 병렬 critique on plan
- 보안 모델 검증: leominal 의 symlink walk + realpath containment 패턴을 그대로 차용, Windows 추가 가드 (backslash/colon/NUL 비율 위장 탐지)
- HMAC root token 생략 결정: tabterm 의 `:name` 은 이미 `validateSessionFolderName` 으로 검증된 stable identity, leominal 의 terminalId→cwd resolve 동적 문제가 없음

## 0.7.5 — 2026-05-25

### Changed
- 신규 세션 폴더명을 `session-{14digits}-{4hex}` (24자) → `session-NNNN` (4자리 숫자, 총 12자) 로 축약
  - 사이드바 행 공간 확보가 목적. 기존 폴더명은 그대로 유지 (rename 없음).
  - 네임스페이스 10,000 + `mkdir(non-recursive)` 로 race-free 충돌 검사. 50회 retry 후 실패 시 500 (`mkdir-exhausted`) 응답.
  - 이론적으로 활성 폴더 ~5,000개에서 첫 시도 99% 성공. 그 이상은 archive 권장 또는 자릿수 확장.
- 사이드바 sessions 영역을 engine 별 sub-section 으로 분리: `sessions · claude` (amber 헤더), `sessions · opencode` (accent blue 헤더)
  - 둘 다 alive 한 폴더가 있을 때만 해당 헤더 노출. 한쪽만 있으면 그 한쪽만 표시.
  - subagent 섹션은 기존 그대로 별도 유지.
- 세션 행 3줄 → 2줄 compact 표시: name + meta 만 표시, full cwd 는 `<div>` 인라인 대신 `el.title` (hover tooltip) 로 이동
  - meta 줄은 PTY 상태(`no PTY`/`exit N`/`in slot L|R`/`detached`) + 폴더명 (label 별칭 있을 때) + 상대시간 (`5m ago` 등) 유지
  - `.ws-path` CSS rule 자체는 잔존 (forward-compat / 추후 fallback). 인라인 사용처 없음.
- `package.json` 0.6.3 → 0.7.5 (직전 snapshot 의 0.7.2-0.7.4 CHANGELOG 와 정렬)
- `public/sw.js` VERSION → `tabterm-v20-session-nnnn-engine-tabs`

### Fixed (peer-review-driven)
- 신규 폴더 leak on spawn failure: `mkdir(cwd)` 성공 후 `sessions.create()` 가 throw 하면 빈 `session-NNNN` 폴더가 남아 10k 네임스페이스를 burn 하던 회귀
  - 수정: `createdNow=true` 인 경로의 spawn catch 블록에서 `rm(cwd, { recursive, force })` rollback + `session.folder.rollback` audit 로그
  - 구 timestamp 네임스페이스에서는 폴더가 leak 돼도 충돌 사실상 0 이라 무해했지만, 4-digit 으로 좁히면서 직접 노출된 리스크
- 폴더 할당 capacity 주석 정확도 보정: "<99% on first try" → 실제 first-try 성공률 `(10_000-N)/10_000` 명시, 50-retry 합산 성공률은 N≈9000 까지 사실상 100% 임을 부연

### Deferred (peer-review surfaced, 별도 commit)
- 기존 `startRename(folder.name)` → `data-pane-id` 쿼리 불일치 (session-folder 행은 `data-folder-name` 사용) - pre-existing 버그, 이번 PR scope 밖
- `el.title` tooltip 접근성 (iPad/keyboard hover 불가) - mobile 사용자 path 발견성 손실. kebab "Copy path" action 추가는 후속
- 할당 retry 후 scan-0000-9999 fallback - N≥9000 archive 권장 시점이라 YAGNI

## 0.7.4 — 2026-05-23

### Fixed
- iPad 한글 IME rail bar 에서 Enter 키 / Send 버튼 눌러도 PTY 에 `\r` 안 들어가던 버그
  - 증상: 사용자가 한글 입력 후 Enter → claude/opencode prompt 에 텍스트만 들어가고 submit 안 됨
  - 원인: `initImeBar()` 의 `flush()` 가 textarea value 만 `imeSendData(v)` 로 보내고 carriage return append 안 함. PTY 입장에서는 사용자가 텍스트만 입력하고 Enter 안 친 상태와 동일
  - 수정:
    - 새 `flushImeText(withEnter)` 추가. withEnter=true 면 text 전송 후 별도 `imeSendData('\r')` 호출
    - 기존 `flush()` 는 `flushImeText(false)` wrapper 로 유지 (safer default)
    - Enter 키 keydown + Send 버튼 click → `flushImeText(true)` 명시 submit
    - blur (자동 flush) + IME aux key click (esc/tab/arrows/ctrl-c/bs 누르기 전 text 비우기) → `flush()` 유지, `\r` 없음
    - 빈 textarea + Enter/Send 면 bare `\r` 전송 (이미 채워진 prompt 만 submit 시 유용)
  - composition 가드 (`e.isComposing || e.keyCode === 229`) 그대로 유지. compositionend flush 추가 X (double-fire 트랩 회피)
  - `public/sw.js`: VERSION → `tabterm-v19-ipad-ime-enter-fix`

### Process notes
- Codex peer review (ccx mode, 2-round discuss): 둘 다 거의 동일 draft. helper 추가 + `\r` 별도 sendWs 호출 + `flush()` wrapper 유지에 합의. disagreement 없음

## 0.7.3 — 2026-05-23

### Fixed
- 0.7.2 의 restart/spawn force 경로에서 silent eviction 위험 제거 (Codex peer review 반영)
  - 원인 (Codex 발견):
    - `restartPane()` 이 `force: true` 무조건 → 같은 cwd 에 alive 한 다른 client/window/external session 이 있으면 confirm 없이 evict
    - `spawnSessionToFolder()` 가 force evict 후 stale pane 의 WS + xterm 인스턴스를 prune 안 함 → 메모리 누수 + renderSidebar 가 cwd 매칭으로 stale pane 을 폴더 행에 임시로 표시
  - 수정:
    - 새 helper `postSessionFolderWithBusyConfirm(body)` 추가. `postNewSessionWithForceConfirm` (worker용) 과 대칭. 기본은 force 없이 시도 → 409 면 confirm 후 force 재시도, decline 시 null 반환. 반환은 `{ response, evictedIds }` 형태로 server 가 죽일 ID 목록 노출
    - 새 helper `prunePanesById(ids)` 추가. WS close + term dispose + slot detach + state.panes 필터링. render side effect 없음 (caller 가 결정)
    - `restartPane()` session 분기: force=true 제거, helper 경유. evictedIds 받아 prune
    - `spawnSessionToFolder()`: 인라인 409 처리 → helper 경유. evictedIds 받아 prune. fetch 직접 호출 제거 (api 헬퍼로 통일)
  - 효과: 일반 경로 (다른 alive session 없음) 는 prompt 없이 그대로 동작. 충돌 시에만 confirm. silent eviction + pane 누수 둘 다 해소
  - `public/sw.js`: VERSION → `tabterm-v18-restart-no-silent-evict`
  - `refreshAll()` 의 prune 로직도 동일한데 DRY 통합은 scope creep 회피 (다음 리팩터링에서)

### Process notes
- ccx mode 활성화. 이번 amend 는 Claude ∥ Codex independent draft → compare (max 2 rounds) → 합의 도달 (disagreement 없음). 자세한 review 흐름은 `~/session-reports/20260523-103xxx-session-ebdc-tabterm-codex-peer-amend.md`

## 0.7.2 — 2026-05-23

### Fixed
- 세션 ↻ restart 가 새 폴더를 만들던 동작 → 같은 폴더 재attach 로 변경
  - 원인: `restartPane()` 의 session 분기가 body 에 `cwd` 를 안 보냄 → 서버가 Mode 1 (mkdir 새 폴더) 로 처리 → 사이드바에 새 session 항목이 추가됨. 사용자가 원한 건 같은 폴더의 PTY 만 재시작.
  - 수정: `public/app.js` `restartPane()` session 분기에서 `cwd: p.cwd, force: true` 추가. 서버는 Mode 2 + force 로 살아있는 PTY evict 후 같은 폴더 재spawn. engine 도 그대로 영속화. fetchFolders + renderSidebar 호출로 lastUsedAt 갱신 반영.
- 사이드바 dead/idle 폴더 클릭 시 (`spawnSessionToFolder`) spawn 후 슬롯에 자동 attach 안 되던 minor UX 버그
  - 원인: 기존 코드는 `refreshAll()` 만 호출 → `addPaneFromServer` 까지만 됨. 사용자가 다시 한 번 폴더 클릭해야 슬롯 attach.
  - 수정: 응답의 `session.id` 받아 `addPaneFromServer + assignToSlot` 직접 호출. fetchFolders 도 추가.
- `public/sw.js`: VERSION → `tabterm-v17-spawn-folder-auto-slot-attach`

### Notes
- 서버 코드 미변경 → tabterm 재시작 불필요. 브라우저 Ctrl+Shift+R 만.
- restart 가 같은 폴더 재사용하므로 폴더 history (tabterm.json, 사용자 작업 파일 등) 보존됨. 새 폴더가 필요하면 `+ Claude` / `+ OpenCode` 버튼 사용.

## 0.7.1 — 2026-05-23

### Fixed
- 새 세션 (+ Claude / + OpenCode) 클릭 시 사이드바에 즉시 안 나타나던 버그
  - 원인: `createSession()` 이 `addPaneFromServer + assignToSlot` 만 호출, 서버가 새로 만든 폴더를 `state.folders` 로 끌어오지 않음. `renderSidebar()` 는 folder-driven 이라 새 폴더가 state 에 없으면 사이드바에 못 그림 (슬롯 L/R 의 터미널은 state.panes 기반이라 즉시 보였음).
  - 수정: `public/app.js` `createSession()` 내 `assignToSlot` 직후 `await fetchFolders(); renderSidebar();` 추가
  - `public/sw.js`: VERSION → `tabterm-v16-createsession-folder-refresh` (서비스 워커 캐시 무효화)
  - 적용 후 사용자 verify 필요: 브라우저 Ctrl+Shift+R 한 번

### Notes
- 서버 코드 미변경 → tabterm 재시작 불필요. 브라우저 hard refresh 만으로 적용.
- 동일 turn 에 `~/.config/opencode/tui.json` 의 잘못된 plugin entry (`oh-my-openagent/tui`) 도 제거 (opencode TUI 가 매 시작마다 GitHub 인증 띄우던 원인). 자세한 진단은 `~/session-reports/20260523-095951-session-ebdc-tabterm-opencode-github-login-and-sidebar-refresh-fix.md`

## 0.7.0 — 2026-05-23

### Added
- 엔진 선택 가능한 일반 세션 — "+ New session" 버튼 1개를 "+ Claude" + "+ OpenCode" 2개로 분리
  - 동기: OpenCode (sst/opencode) + Oh My OpenAgent (OMO) 도입. Claude 워커는 그대로 두면서 새 세션은 엔진별로 띄울 수 있게.
  - 서버:
    - `.env`: `OPENCODE_COMMAND`, `OPENCODE_ARGS`, `SESSION_OPENCODE_ARGS`, `OPENCODE_ANTHROPIC_BASE_URL=http://127.0.0.1:18802` 추가
    - `server/config.js`: `buildEngineInvocation(engine)` 신설 — engine 에 따라 cmd/args/baseURL 반환
    - `server/index.js`: POST `/api/sessions` 가 body 의 `engine` ('claude'|'opencode') 받음. opencode 일 때 `ANTHROPIC_BASE_URL=18802` (Nopersb 프록시) 를 spawn env 로 주입. claude 는 기본 3456 (HydraTeams). audit 로그에 engine 기록
    - `server/session-folder.js`: schema v1 → v2. `engine` 필드 영속화. v1 + missing/invalid 는 `'claude'` 로 fail-closed
    - `server/sessions.js`: `summary()` 에 `engine` 필드 노출
  - 클라이언트:
    - `public/index.html`: 단일 "+/New session" 버튼 → 두 개 (`#btn-new-claude`, `#btn-new-opencode`)
    - `public/styles.css`: `.ws-add-opencode` 색상 차별화 (파란톤)
    - `public/app.js`: `createSession(engine)` factory, `addPaneFromServer` 가 pane 에 `engine` 저장, `restartPane` 이 `p.engine` 전달
    - `public/sw.js`: VERSION → `tabterm-v15-engine-split-claude-opencode` (캐시 무효화)
  - 영속화:
    - Mode 1 (신규 폴더): `tabterm.json` 에 engine 기록 → 다음 folder click 시 자동 그 엔진으로 spawn
    - Mode 2 + body 명시 engine: meta 도 같이 갱신 (다음 reattach 시 일관성)
    - Mode 2 + body engine 미지정: 폴더 meta 의 engine 사용 (default 'claude')
  - 백업: 변경 전 모든 파일이 `C:\Tools\tabterm\backups-20260523-011116\` 에 저장됨
  - Codex peer review 6라운드 (rounds 5+6) 모두 반영 (sw.js 캐시 + reattach engine 보존 + mode-2 explicit override 영속화)

### Notes
- Worker tabs (worker-0..7) 는 무변경. 항상 Claude + HydraTeams.
- OpenCode 세션 사용을 위해서는 OpenCode CLI + Nopersb OAuth proxy (port 18802, nssm 서비스 `nopersb-oauth-proxy`) 가 떠 있어야 함.
- 기존 tabterm.json (v1, engine 필드 없음) 은 `'claude'` 로 자동 인식. 첫 touch 시 v2 로 lazy migration.

## 0.6.3 — 2026-05-22

### Added
- 워커 세션 force-confirm spawn — telegram bot pairing 보호
  - 원인: 같은 worker-N 을 두 번 spawn 하면 텔레그램 봇이 `bot.pid` 의 stale poller 를 `SIGTERM` 으로 죽이려 함. Windows ConPTY 한계로 시그널 전달 불완전 → 기존 봇 생존, 새 봇이 getUpdates 409 conflict 로 자살. 결과적으로 텔레그램 메시지가 orphan claude.exe 로 감 (사용자가 보지 못하는 탭)
  - 서버:
    - `spawnWorkerSession({ force })` — 동일 `workerIndex` alive session 있으면 **HTTP 409 `worker-session-exists`** 반환
    - `force=true` 시 `await sessions.kill` (v0.6.1 async 적용) + `killStaleBot(STATE_DIR)` 으로 `taskkill /F /T` 트리 종료 후 spawn
    - `audit` 이벤트: `session.evict`, `bot.evict`
  - 클라이언트:
    - `postNewSessionWithForceConfirm(body)` helper — 409 받으면 `confirm()` dialog 표시 → 사용자 OK 면 `{force: true}` 재시도
    - 사이드바 워커 클릭 + `restartPane` 둘 다 helper 사용
    - confirm 거절은 silent (toast 안 띄움)
- `server/kill-stale-bot.js` (신규 46줄) — `STATE_DIR/bot.pid` 읽고 alive 면 `taskkill /F /T` (Windows) 또는 `SIGKILL` (POSIX). PID 0/1/음수 가드.

### Tests
- `server/kill-stale-bot.test.js` (신규 7 케이스) — no-state-dir / no-pid-file / non-numeric / pid 0,1,-5 / dead pid / trailing whitespace / never-throws
- 전체 회귀 49/49 통과

## 0.6.2 — 2026-05-22

### Fixed
- `POST /api/system/cleanup-zombies` 가 외부 watchdog 때문에 무력화되던 문제
  - 원인: master 의 cleanup-zombies 는 watchdog PID 를 protected set 에 두기만 하고 watchdog 자체는 멈추지 않음. 외부 `C:/workspace/watchdog/watchdog.js` 가 30초 사이클로 죽은 claude/bot 을 부활시켜 정리 효과가 날아감
  - 수정: cleanup-zombies 진입 시 `stopWatchdog` 먼저 호출. 응답에 `watchdogStopped` 포함
  - 사용자는 정리 후 `/api/system/boot-all` 로 워커 재spawn → boot-all 끝에 `startWatchdog` 자동 재시작
- `cleanup-zombies` taskkill 에 `/T` (tree kill) 추가
  - 원인: `bun.exe` 의 `server.ts` 자식, `cmd.exe` 의 `claude` 자식이 단일 PID kill 로는 잔존 → 다음 정리 사이클에서도 같은 좀비 반복 발견
  - 수정: `taskkill /F /T /PID` 로 트리 전체 종료

### Added
- `scripts/diagnose-workers.ps1` — `Win32_Process` 기반 워커별 PID / PPID / CommandLine / 시작시간 그룹핑, 중복 워커 식별 (read-only)
- `scripts/cleanup-orphans.ps1` — 진단 후 orphan 프로세스 정리 보조 스크립트

### Notes
- 분리 브랜치 `feat/telegram-pairing-force-confirm` 의 부분 반영 (옵션 A — Codex peer review 합의)
- `kill-stale-bot.js` + `spawnWorkerSession` force evict + UI 409 confirm 은 별도 후속 작업으로 분리 (UI 미완료 + 분리 브랜치 base stale 위험)

## 0.6.1 — 2026-05-21

### Fixed
- `DELETE /api/sessions/folders/:name` 의 EBUSY 500 race
  - 원인: `sessions.kill()` 이 PTY 시그널만 보내고 `onExit` 안 기다림 → Windows ConPTY 가 cwd 파일 핸들 잡은 채로 `rm -rf` 호출 → EBUSY
  - 수정: `Session.kill()` / `SessionStore.kill()` 비동기화, `pty.whenExited(timeoutMs)` await
  - 추가 안전망: `rmWithRetry` 가 EBUSY/EPERM/ENOTEMPTY 에 exponential backoff (50/100/200/400/800ms)
    - 자식·손자 프로세스 잔존, antivirus/indexer, ConPTY teardown lag 등 외부 holder 대응
- 클라이언트 `state.panes` ghost entry 누수
  - 원인: `refreshAll()` 이 서버에 있는 세션을 추가만 하고 사라진 세션을 제거하지 않음 → 폴더 delete 후 dangling WebSocket + xterm 인스턴스가 영구 잔존 → slow memory leak
  - 수정: `refreshAll()` 에서 server 응답에 없는 `kind === 'session'` pane 을 prune (ws.close + term.dispose + detachFromSlots)
  - worker/general kind 는 restart UX 때문에 유지 (의도적 미수정)

### Tests
- `server/pty-kill-race.test.js` 추가 (5 케이스)
  - `sessions.kill` 이 `onExit` await 후 resolve
  - kill 직후 rm 이 EBUSY 없이 통과
  - `rmWithRetry` EBUSY 재시도 / 비복구성 에러 즉시 throw
  - `sessions.kill` 멱등성

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
- 폴더 라벨 인라인 편집 (워커 라벨 UX 와 동일 패턴, PUT folder API 사용)
- Legacy 폴더(`tabterm.json` 없는 session-*) 자동 인식 + 첫 라벨 편집/spawn 시 lazy migration

### Security
- `DELETE /api/sessions/folders/:name`:
  - path traversal 거부 (separator, `..`, control chars)
  - `worker-` prefix 폴더 403 보호
  - WORKERS_ROOT 하위 1단계만 허용 (containment check)
- `validateSessionFolderName` 에 control char 거부 (null byte, etc) 추가

### Audit events
- `session.folder.create` (이전 `session.create` 가 session 분기에서 변경됨)
- `session.folder.attach`
- `session.folder.evict`
- `session.folder.label.set` / `session.folder.label.set.failed`
- `session.folder.delete` / `session.folder.delete.failed`
- `session.folder.meta.write.failed`

### Internal
- 신규 모듈 `server/session-folder.js` — tabterm.json read/write/validate
- 신규 테스트 `server/session-folder.test.js` (10 tests), `server/folders-api.test.js` (9 tests)
- 사용 안 하는 `renderRow` 함수 제거 (사이드바가 `renderSessionFolderRow` / `renderWorkerRow` 만 사용)

### Tests
- 19 unit tests total (helper + validate + enumerate), all passing on Node 22


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
- `PUT /api/sessions/:id/label` — set session label (auth + CSRF, 1 KB body limit). Empty string returns 422 `empty_not_allowed` (sessions have no default to revert to — spec interpretation refined from §6.3 in implementation).
- `/api/preflight` extended with `workerLabels` and `labelsHealth`.

### Internals
- New `server/labels.js`: `validateLabel` + `createLabelsStore` with serialized write queue + atomic tmpfile rename + `.bak` rotation + `Object.create(null)` storage to defang prototype pollution.
- `SessionStore.setLabel(id, name)`.
- Idempotent no-op: same label → no disk write, no audit log line.
- Audit events: `label.set.worker`, `label.set.session`, `labels.load.recovered`, `labels.persist.failed`. Label bodies never logged (length only).

### UI
- `state.workerLabels` + `state.editing` in `public/app.js`.
- `displayName(p)` helper threads through slot strip, window title, pane header.
- Inline `<input maxlength=32>` + `x/32` counter — no silent truncate.
- Esc cancels, Enter/blur commits. Cancelled flag guards deferred-blur double-fire.
- `renderSidebar` preserves in-progress input across external re-renders (PTY exit, list refresh).
- `focusActivePane` bails out when `state.editing` is active so iPad iOS IME redirect doesn't steal focus.

### Tests
- `server/labels.test.js` — 18 `node:test` cases: validateLabel (7) + store roundtrip, recovery from `.bak`, both-corrupted preservation, prototype-pollution defense, concurrent serialization, idempotent return shape, concurrent same-key dedupe, schema-version mismatch fallback, missing-main-with-bak recovery.

### Review
Codex peer-reviewed the implementation diff. Addressed RED + key YELLOW findings inline before merge:
- **RED — labels.js load**: main-missing-but-bak-present case now triggers recovery (previously fell through to "fresh dir" and lost the bak).
- **RED — labels.js schema**: schema validation (`version === 1`, `workers` plain object) gates the main-vs-bak decision. Schema-invalid main now falls back to bak.
- **RED — index.js idempotency**: idempotency check moved inside the labels.js write queue so concurrent identical PUTs cannot both write/audit.
- **YELLOW — rename prefill**: worker rename now prefills with the default name (`worker-N`) instead of empty; hitting Enter unchanged is treated as "clear", not "save default as custom label".
- **YELLOW — double commit**: `commitRename` carries an in-flight guard so Enter-then-blur cannot trigger a duplicate PUT.
- **YELLOW — session empty**: empty session rename now surfaces an explicit toast instead of silently cancelling.

### Spec
- `docs/superpowers/specs/2026-05-20-tabterm-rename-design.md` (v2, Codex peer-reviewed)
- `docs/superpowers/plans/2026-05-20-tabterm-rename.md` (12-task implementation plan)


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
