# tabterm

Windows 호스트용 브라우저 PTY 멀티플렉서. 탭/스플릿/재연결/iPad PWA. Tailscale Serve로 HTTPS 자동.

## 한 줄 요약
`WORKERS_ROOT`(기본 `C:\workspace`)의 `worker-0..N` 워커와 임시 `session-*` 폴더에서 **Claude Code / OpenCode** 프로세스를 띄우는 여러 cmd 창을 **브라우저 탭/분할** 하나로 통합·운영합니다. 각 워커는 HydraTeams 프록시로 LLM이 라우팅되고 자기 텔레그램 봇 채널에 페어링되며, 내장 파일 Explorer까지 제공합니다. iPad 홈화면에 추가해 PWA처럼 사용 가능.

## 아키텍처 — tabterm 이 운영하는 것

tabterm 은 단순 PTY 멀티플렉서가 아니라 **이 호스트의 에이전트 워커 풀을 브라우저 하나로 통합 운영**하는 컨트롤 플레인이다. 세 축으로 동작한다.

### 1. Worker 세션 — HydraTeams + 텔레그램 플러그인 연동 (주 기능)

`WORKERS_ROOT`(기본 `C:/workspace`) 아래 `worker-0 … worker-{N-1}` 디렉토리 각각이 **ccx 모드 Claude Code 워커**다. 좌상단 **+ → 워커 번호**로 탭을 만들면 `spawnWorkerSession`(`server/index.js`)이 순서대로:

1. **HydraTeams 게이트** — `HYDRATEAMS_ENABLED=true`면 `ensureHydraReady()`(`server/hydra.js`)가 `:3456/health`를 확인한다. 죽어 있으면 `HYDRATEAMS_LAUNCHER`(`hydra-launcher.sh start`)를 git bash로 띄우고 최대 10×1s 폴링. 끝내 안 뜨면 워커 생성을 **503 `hydra-not-ready`로 차단**한다. (서버 부팅 시에도 1회 force preflight 후, 미준비면 "ANTHROPIC_BASE_URL 필요한 워커는 실패" 경고.)
2. **per-worker 텔레그램 토큰 주입** — `loadWorkerEnv(cwd)`(`server/config.js`)가 그 워커 폴더의 `.ccx-env`(우선) 또는 `start-ccx.bat`(`set NAME=VAL` 파싱)에서 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_STATE_DIR` **두 키만** 발췌해 PTY 환경에 넣는다.
3. **엔진 spawn** — `CLAUDE_ARGS`(기본 `--dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official`)로 `claude`를 실행. Anthropic 트래픽은 `ANTHROPIC_BASE_URL=:3456`(HydraTeams 프록시)로 향한다.

→ 워커 탭 = **"HydraTeams 프록시로 LLM이 라우팅되고, 자기 텔레그램 봇 채널에 페어링된 Claude Code 인스턴스"**. HydraTeams 프록시(:3456)는 서브에이전트의 시스템 프롬프트를 content-sniff 해서 실행 전문 에이전트는 GPT-5.5, 판단/리뷰/작성 에이전트와 Lead 는 Claude 로 라우팅한다(cc=전원 Claude, ccx=하이브리드).

**텔레그램 페어링 가드**: 봇은 `TELEGRAM_STATE_DIR` 아래 *가장 최근* `claude.exe` 하나에만 페어링되므로, 같은 worker-N 을 두 번 띄우면 옛 탭의 봇 링크가 끊긴다. 그래서 동일 워커 중복 생성은 **409 `worker-session-exists`로 막고**, `force=true`일 때만 옛 세션을 kill 한 뒤(`onExit` 대기) `killStaleBot(STATE_DIR)`로 고아 봇 트리를 정리하고 교체한다.

### 2. Claude Code / OpenCode 분리 세션 실행

**+** 버튼의 일반 세션(`NEW_SESSION_PREFIX=session-` 폴더)은 엔진을 **선택**할 수 있다 — `buildEngineInvocation(engine)`(`server/config.js`):

| 엔진 | 실행 명령·인자 | Anthropic 업스트림 | 비고 |
|------|----------------|--------------------|------|
| `claude` (기본) | `CLAUDE_COMMAND` + `SESSION_CLAUDE_ARGS` | `ANTHROPIC_BASE_URL` → **:3456 HydraTeams** | ccx env·텔레그램 플러그인 **없는** 순수 세션 |
| `opencode` | `OPENCODE_COMMAND` + `SESSION_OPENCODE_ARGS` | `OPENCODE_ANTHROPIC_BASE_URL` → **:18802 Nopersb 프록시** | 자식이 자체 HTTP API 서버를 띄움 |

OpenCode 세션은 `allocFreePort()`로 빈 포트를 잡아 자식에게 `--port <p> --hostname 127.0.0.1`을 줘서 OpenCode 의 HTTP API 를 기동한다. 이 포트(`apiPort`)는 세션 meta 에 저장되고, **`server/dp-proxy.js`의 `/api/sessions/:id/dp/*`(SSE `/dp/event` 포함)가 그 포트로 인증 게이트(`requireAuth`)를 거쳐 프록시**한다 → 우측 사이드바에 OpenCode 의 상태/이벤트를 읽기 전용으로 노출하기 위한 경로다. 엔진 선택은 폴더 meta 에 영속되어, 폴더 재연결(엔진 미지정) 시에도 마지막 엔진을 유지한다.

즉 한 브라우저에서 **HydraTeams 라우팅 Claude Code 워커**, **순수 Claude 세션**, **Nopersb 라우팅 OpenCode 세션**을 탭으로 섞어 돌릴 수 있다.

### 3. Explorer — jail 파일 브라우저 (read/write)

세션 폴더 또는 호스트 임의 경로를 브라우저에서 탐색·편집한다. 두 라우트 패밀리(`server/file-explorer.js`):

- **세션 jail**: `/api/sessions/folders/:name/fs/*` — 해당 세션 폴더 cwd 아래로 격리.
- **절대 경로**: `/api/fs/*` (+ `/api/fs/drives`) — 드라이브/절대 경로 탐색.

각 작업(list / read / 텍스트·이미지·PDF preview / mkdir / delete / rename / write / upload)은:
- **경로 격리** — 경로 세그먼트마다 `lstat`으로 심볼릭링크·정션·reparse point 를 거부한 뒤, 최종 타깃의 `realpath`가 root 의 `realpath` 안에 있는지 재확인(jail 탈출 차단).
- **안전 쓰기** — 텍스트 저장은 `{size, mtimeMs}` expectedVersion CAS(외부 수정 시 409 `stale-version`), 업로드 충돌은 `name (1).ext` autosuffix(silent overwrite 없음), atomic tmp-sibling + `rename`.
- **인증** — 전 라우트 `requireAuth`, 변경 계열은 CSRF 헤더까지 요구.

## 요구사항
- Windows 10 1809+ (ConPTY)
- Node.js 22+
- Visual Studio Build Tools (node-pty 빌드용) — 또는 미리 빌드된 prebuild 사용 시 생략
- (HTTPS/iPad PWA용) Tailscale

## 설치

```powershell
cd C:\Tools\tabterm
npm install              # postinstall이 vendor 자동 복사
cp .env.example .env     # 필요시 값 수정
npm run setup-pass       # 비밀번호 등록 (12자 이상)
npm start
```

서버 부팅 시 `WORKERS_ROOT`(기본 `C:/workspace`)와 `worker-0~worker-7` 폴더 존재 여부를 preflight 합니다. 빠진 폴더가 있으면 경고만 출력하고 계속 실행됩니다 (해당 워커 탭만 실패).

## HTTPS + iPad PWA (Tailscale Serve)

```powershell
# 1. Tailscale 로그인 상태에서
tailscale serve --bg --https=443 localhost:3007
tailscale serve status
```

이제 `https://<머신이름>.<tailnet>.ts.net/` 으로 접속 가능. 자동 Let's Encrypt 인증서 → Service Worker / PWA 정상 동작.

iPad Safari에서 접속 → 공유 → "홈 화면에 추가". 첫 진입 시 비번 입력 후 PWA로 사용.

## 사용 흐름
1. 첫 진입 시 비밀번호 등록 (12자 이상, scrypt 강화)
2. 좌상단 **+** 버튼으로 워커 번호(0~7) 선택 → 탭 생성, 해당 디렉토리에서 `claude` 실행
3. 추가 탭은 자동 가로 분할 (Split.js)
4. 탭 X로 닫기, ⏸ 버튼은 Ctrl+C (soft-stop), ✕ 버튼은 강제 종료
5. 새로고침 / 네트워크 단절 후에도 PTY는 서버에 살아 있고 buffer dump로 재연결됨 (서버 재시작 전까지)

## 키 단축
- 가상키보드(iPad)에서 Ctrl 조합은 xterm.js 가상 키 사용 권장 — 현재 v1엔 미포함
- 마우스/터치로 탭 클릭 → 활성화

## 환경변수 (.env)
> 권위 있는 전체 목록은 `.env.example` + `server/config.js`. 아래는 주요 키 발췌(2026-05-29 기준). config.js 는 모든 키에 기본값을 가지므로 누락 키는 크래시가 아니라 기본값으로 동작한다.

| 키 | 기본 | 설명 |
|----|------|------|
| HOST | 127.0.0.1 | 바인딩 주소 (Tailscale Serve 앞단이라면 localhost 유지) |
| PORT | 3007 | HTTP 포트 |
| WORKERS_ROOT | C:/workspace | 워커 폴더 루트 |
| WORKERS_COUNT / WORKER_PREFIX | 8 / worker- | 워커 개수·폴더 prefix |
| NEW_SESSION_PREFIX | session- | "+" 신규 세션 폴더 prefix |
| **CLAUDE_COMMAND** / CLAUDE_ARGS | claude / `--dangerously-skip-permissions --channels plugin:telegram@...` | claude 탭 실행 명령·인자 (※ 구 `WORKER_COMMAND` 아님) |
| SESSION_CLAUDE_ARGS | (빈값) | 일반 세션용 claude 인자 |
| **OPENCODE_COMMAND** / OPENCODE_ARGS / SESSION_OPENCODE_ARGS | opencode / (빈값) / (빈값) | opencode 엔진 탭 실행 명령·인자 |
| OPENCODE_ANTHROPIC_BASE_URL | http://127.0.0.1:18802 | opencode 자식이 향하는 업스트림 프록시 |
| HYDRATEAMS_ENABLED | true | ccx 모드 hydra 프록시/프리플라이트 |
| ANTHROPIC_BASE_URL | http://localhost:3456 | claude 탭이 향하는 hydra 프록시 |
| HYDRATEAMS_HEALTH_URL / LAUNCHER / BASH | …:3456/health / hydra-launcher.sh / git bash | hydra health-check·부트스트랩 |
| HYDRATEAMS_HEALTH_TIMEOUT_MS / POLL_MS / POLL_MAX | 2000 / 1000 / 10 | hydra health 폴링 (config.js 기본값) |
| RING_BUFFER_BYTES | 2097152 | 세션당 출력 ring buffer (재연결 buffer) |
| PTY_DEFAULT_COLS / ROWS | 120 / 32 | PTY 기본 크기 |
| COOKIE_SECURE | true | HTTPS 환경에서 true 유지 |
| COOKIE_NAME / CSRF_HEADER | tabterm.sid / x-tabterm-csrf | 세션 쿠키·CSRF 헤더 이름 |
| LOGIN_RATE_PER_MIN / LOGIN_LOCKOUT_MINUTES | 5 / 15 | 로그인 분당 한도·잠금 시간 |
| SESSION_TTL_HOURS | 168 | 세션 쿠키 TTL (기본 7일) |
| AUDIT_FILE | data/audit.log | 감사 로그 경로 |
| WATCHDOG_AUTOSTART / PATH / CONFIG / LOG | true / C:/workspace/watchdog/… | 부트 시 watchdog 자식 spawn (ccx 풀파이프라인) |

## 보안 모델
- 디폴트 `HOST=127.0.0.1` — 외부는 Tailscale Serve로만 노출
- 비밀번호: scrypt N=65536, r=8, p=1, 16-byte salt, timing-safe 비교
- 세션: httpOnly + SameSite=Strict 쿠키 + CSRF 토큰 헤더 (POST/DELETE)
- WS: 핸드셰이크 시 쿠키 + Origin 검증
- 로그인 분당 5회 제한 (IP 단위)
- 감사 로그 `data/audit.log` (login, session start/exit/delete, server start/shutdown)
- 임의 명령 spawn 차단 — `WORKER_COMMAND`와 화이트리스트 cwd만 사용

## v1 트레이드오프
- 서버 재시작 시 PTY 종료 (디스크 영속 백업은 v2)
- 가로 분할만 지원 (세로 분할은 v2)
- 가상 키보드용 Ctrl/Esc 바는 v2
- 첫 비번 setup은 `npm run setup-pass` (CLI) 또는 웹 UI 첫 진입에서 가능

## 트러블슈팅
- `node-pty` 빌드 실패 → `npm i --global windows-build-tools` 또는 VS Build Tools + Python 3 설치
- `claude` PATH 못 찾음 → 시스템 PATH에 Claude Code CLI 설치 경로 추가 후 서버 재시작
- iPad에서 SW 등록 실패 → `https://` 접속인지 확인 (Tailscale Serve)
- 한글 깨짐 → 워커 명령은 자동으로 `chcp 65001`로 래핑됨. claude 자체 출력이 깨지면 Windows 명령창 폰트(NanumGothicCoding 등) 확인

## 디렉토리
```
C:/Tools/tabterm/
├── server/
│   ├── index.js          # Fastify 부트 + 라우트 등록
│   ├── auth.js           # scrypt 비번 + 세션/CSRF
│   ├── sessions.js       # PTY 세션 스토어
│   ├── pty.js            # node-pty 스폰/IO
│   ├── ws.js             # WebSocket 핸드셰이크
│   ├── config.js         # .env 로드 + 엔진 invocation 빌더
│   ├── dp-proxy.js       # opencode developer-port GET 프록시 (requireAuth 게이트)
│   ├── hydra.js          # HydraTeams health-check + 조건부 부트스트랩
│   ├── watchdog.js       # ccx watchdog 자식 spawn 관리
│   ├── file-explorer.js  # /api/fs 파일 브라우저 (경로 jail)
│   ├── session-folder.js # 세션별 폴더 fs API
│   ├── system.js         # 시스템 정보 라우트
│   ├── labels.js         # 세션 라벨
│   ├── audit.js          # 감사 로그
│   ├── kill-stale-bot.js # stale 프로세스 정리
│   └── *.test.js         # node --test 단위/e2e 테스트
├── public/{index.html,app.js,styles.css,manifest.json,sw.js,icons/,vendor/}
├── scripts/{copy-vendor,setup-pass,cleanup-orphans,diagnose-workers,gen-splash}.*
├── data/{auth.json,audit.log,labels.json}   (런타임 생성)
├── docs/{nssm-install-runbook.md, worker-test-note.md, superpowers/}
├── .env, .env.example
└── README.md
```
