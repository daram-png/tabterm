# tabterm 일반 세션 폴더 영속화 — design spec

- Date: 2026-05-21
- Status: draft, 사용자 review 대기
- Scope: tabterm v0.6.x — 일반 세션(`kind=session`) 폴더를 영속 entity 로 승격, 사이드바 enumerate / 라벨 편집 / 폴더 단위 삭제 지원
- 선행 spec: `2026-05-20-tabterm-rename-design.md` (워커 라벨 영속화 — 본 spec 의 Non-goals 였던 "세션 라벨 영속화" 를 본 spec 에서 회수)

## 1. Goal

일반 세션 폴더(`workspace/session-*`)를 워커 폴더처럼 **영속 entity** 로 취급한다. 사용자가 직접 폴더를 삭제하기 전까지 디스크에 남고, tabterm 을 재시작하거나 새로 열어도 사이드바에 그대로 나타나며, 라벨로 식별할 수 있고, PTY 종료(Kill) 와 폴더 자체 삭제(Delete) 가 분리된 액션으로 제공된다.

### 1.1 사용자 시맨틱 (인용)

> "내가 쓰다가 내가 버리고 싶으면 아예 삭제를 하게 하는거야. 삭제는 session을 끝내는게 아니라 아예 폴더까지 사라져서 존재가 없어지는걸 의미"

- **폴더 = 존재 그 자체**: 명시적 Delete 전까지 영속
- **PTY = 일회성**: Kill 해도 폴더 잔존, 다음 클릭 시 같은 cwd 에 새 PTY spawn
- **라벨 = 식별자**: 워커 라벨 편집 UX 그대로 재사용 (펜 아이콘 인라인 편집)

## 2. Non-goals

- 일반 세션의 텔레그램 plugin 연동 (의도된 분리, 별 task)
- 일반 세션의 HydraTeams 프록시 라우팅 (현행대로 미주입)
- 세션 폴더 자동 청소 (TTL, LRU 등) — 사용자 명시 삭제만
- 워커 폴더(`worker-N`) UX 변경
- 다중 attach (동일 폴더에 PTY 2개 동시 spawn) — 워커 paired-guard 와 같은 시맨틱 적용
- 폴더 export / import / rename 기능

## 3. UX

### 3.1 사이드바 sessions 섹션

현재: alive PTY 인 `kind=session` 만 표시.
변경 후: `workspace/session-*` 디스크 폴더 ∪ alive PTY 합집합.

행 구조 (워커 라벨 spec 의 표기 규칙 재사용):
- `ws-name`: 사용자 라벨이 있으면 라벨, 없으면 폴더명 (예: `session-20260521140514-a780`)
- `ws-meta` 조립 순서:
  - 상태 glyph (`alive` / `idle` / `dead exit 0` / `no PTY`)
  - 라벨이 있을 때만 ` · ${folderName}` 부가
  - lastUsedAt 상대 시각 (예: `· 3m ago`)
- `ws-path`: cwd 전체 경로
- 우측 액션: 펜 아이콘 (라벨 편집) + 케밥(⋮) 메뉴 신규 도입 (Kill / Delete)
- 워커 행은 변경 없음 (펜 아이콘만 기존대로 유지, 케밥 메뉴 미추가)

### 3.2 라벨 편집

워커 라벨 spec ([2026-05-20-tabterm-rename-design.md](2026-05-20-tabterm-rename-design.md) §3.2~3.3) 의 펜 아이콘 인라인 편집 동작을 그대로 차용. 단 영속 저장 경로가 다름:
- 워커 → 중앙 `data/labels.json`
- 세션 → 각 폴더 안 `tabterm.json` (본 spec §4.1)

빈 문자열 저장 → 라벨 해제, `tabterm.json` 의 `label` 필드 제거 (폴더명 fallback).

### 3.3 액션 — Kill / Delete 분리

| 액션 | 동작 | 확인 UX |
|------|------|---------|
| Kill | alive PTY 종료, 폴더 유지, 사이드바 행은 dead 상태로 잔존 | 단일 confirm dialog — `confirm("이 세션 PTY 를 종료할까요? 폴더와 라벨은 유지됩니다.")` |
| Delete | 1) alive PTY 있으면 먼저 kill 2) `workspace/session-*` 폴더 자체 `rm -rf` 3) 사이드바 행 제거 | **2단계 confirm**: 1차 `"폴더 자체를 삭제합니다. 복구 불가."` + 2차 라벨/폴더명 typing 검증 (github 스타일) |

Delete 가 destructive 한 만큼 typing 검증을 둠. 사용자 추가 요청 있으면 단일 confirm 으로 완화 가능.

### 3.4 dead 폴더 클릭 시

워커 클릭과 동일한 UX:
- alive PTY 이 있으면 그 pane 으로 active 전환 (또는 사이드바 클릭 = 슬롯 라운드로빈 배치)
- 없으면 같은 cwd 로 새 PTY spawn (`extraEnv = {}` 유지, 텔레 미연동)
- 별도 "Resume" 버튼 없음

## 4. 데이터 모델

### 4.1 폴더별 tabterm.json

- 경로: `<workspace>/session-*/tabterm.json`
- 폴더 신규 생성 시 즉시 작성
- 부팅 시 enumerate 단계에서 read, 없으면 inferred 기본값 사용
- Atomic write: tmp 파일 작성 → rename (`fs.rename`)
- 백업/롤백 없음 (단일 파일, 작고 사용자가 직접 편집할 일 거의 없음)

스키마:
```json
{
  "version": 1,
  "label": "내 임시 작업",
  "createdAt": 1716297914000,
  "lastUsedAt": 1716301234567
}
```

- `version`: 정수, future migration 용. 현재 1. 미지원 version 만나면 read-only 모드 (라벨 표시만, 편집/삭제는 가능).
- `label`: 문자열, 1~32자 (워커 라벨 검증 규칙 [labels.js validateLabel](../../server/labels.js) 재사용). 비어있거나 누락 = 폴더명 fallback.
- `createdAt`: 폴더 최초 생성 epoch ms.
- `lastUsedAt`: 마지막 PTY spawn 또는 attach epoch ms. 정렬 키.

### 4.2 Legacy 폴더 (tabterm.json 없는 session-\*)

backward compat 우선:
- 사이드바에 폴더명 그대로 라벨 표시
- 메타데이터는 inferred:
  - `createdAt` = 폴더의 `birthtimeMs` (fs.stat)
  - `lastUsedAt` = 폴더의 `mtimeMs`
  - `label` = 없음
- 사용자가 라벨 편집하거나 PTY spawn 하는 순간 `tabterm.json` 정식 작성 (lazy migration)

## 5. Backend API 변경

### 5.1 신규 — GET /api/sessions/folders

전체 디스크 enumerate. alive PTY 정보는 클라이언트가 `/api/sessions` 와 join.

요청: 없음
응답:
```json
{
  "folders": [
    {
      "name": "session-20260521140514-a780",
      "cwd": "C:/workspace/session-20260521140514-a780",
      "label": "내 임시 작업",
      "createdAt": 1716297914000,
      "lastUsedAt": 1716301234567,
      "hasTabtermJson": true,
      "schemaVersion": 1
    }
  ]
}
```

- `workspace` 디렉토리에서 `WORKER_PREFIX*` 제외, `NEW_SESSION_PREFIX*` 만 필터
- 폴더 read 실패 시 그 폴더만 skip + warn log, 전체 fail 안 함
- 정렬은 클라이언트 책임 (서버는 정렬 보장 안 함)

### 5.2 변경 — POST /api/sessions { kind: 'session', cwd? }

기존 동작 유지 + cwd 옵션 추가:
- `cwd` 미지정 → 현재 동작 (`session-<ts>-<hex>` 폴더 신규 생성)
- `cwd` 지정 → 신규 mkdir 스킵, 기존 폴더에 PTY spawn
  - 경로 검증: `resolve(cwd)` 가 `WORKERS_ROOT` 하위 + `NEW_SESSION_PREFIX` 시작 + 폴더 실존
  - 워커 폴더 경로 거부 (`WORKER_PREFIX` 시작이면 400)
  - 검증 실패 → 400 `bad-cwd`
- 폴더 신규 생성 시 tabterm.json 자동 작성 (`createdAt = now, label = "", lastUsedAt = now`)
- 기존 폴더 attach 시 tabterm.json 의 `lastUsedAt` 갱신
- 동일 cwd 에 alive PTY 이미 있으면 409 `session-folder-busy` + `force=true` 옵션으로 evict 후 spawn (UI 는 보통 alive PTY 면 attach 만 호출하므로 이 case 는 race / 다중 사용자 / stale state 에서만 발생; force 트리거 UI 는 워커 force-confirm UI 가 들어오면 그 패턴 재사용)

### 5.3 신규 — PUT /api/sessions/folders/:name/label

라벨만 영속 변경 (alive PTY 와 무관).

- `:name` = 폴더명 (path component 만 허용, `..` 거부, `NEW_SESSION_PREFIX` 검증)
- body: `{ "name": "내 임시 작업" }` — 워커 라벨 검증 규칙 재사용 ([validateLabel](../../server/labels.js))
- 빈 문자열 허용 = 라벨 해제
- tabterm.json read → label 필드 갱신 → atomic write
- alive PTY 가 있고 그 PtySession.label 도 동기화 (`s.label = label || folderName`)
- 응답: `{ ok: true, folder: { name, label, ... } }`

### 5.4 신규 — DELETE /api/sessions/folders/:name

폴더 자체 삭제 (destructive).

- 1단계: alive PTY 검색 + 있으면 `sessions.kill(id)`
- 2단계: `fs.rm(cwd, { recursive: true, force: true })`
- 경로 검증 (path traversal 방지):
  - `name` 에 path separator (`/`, `\`, `..`) 포함 시 400
  - `resolve(WORKERS_ROOT, name)` 가 정확히 `WORKERS_ROOT` 하위 1단계인지 검증
  - `WORKER_PREFIX` 시작이면 403 `worker-folder-protected`
- 응답: `{ ok: true, deleted: <folderName> }`
- audit log: `event: 'session.folder.delete'`

## 6. Frontend 변경

### 6.1 state 모델

```js
state.folders = []     // GET /api/sessions/folders 결과
state.panes = []       // 기존 GET /api/sessions (alive PTY)
```

### 6.2 renderSidebar

sessions 섹션 행 source 변경:
```
디스크 폴더 (state.folders) 를 기준으로 행 생성
  alive PTY 매칭 (cwd 일치) → 상태 glyph 결합
정렬: lastUsedAt 내림차순 (최근 사용 위)
```

### 6.3 + New session 버튼

기존 동작 유지 (cwd 미지정 POST). 응답 받으면 `state.folders` 에 새 entry 추가 + renderSidebar.

### 6.4 행 클릭

기존: pane ID 로 attach
변경 후 분기:
- alive PTY 있음 → 기존 attach
- alive PTY 없음 → `POST /api/sessions { kind: 'session', cwd: <folder.cwd> }` → 응답으로 받은 새 pane attach

### 6.5 펜 아이콘

워커 라벨 spec §3.3 의 인라인 편집 동작 재사용. API 호출만 `PUT /api/sessions/folders/:name/label` 로 분기 (워커는 `/api/labels/worker/:idx`).

### 6.6 케밥 메뉴

각 세션 행에 신규 컴포넌트 추가 (⋮ 아이콘):
- Kill (alive 일 때만 활성, 비활성 시 disabled grey)
- Delete (항상 활성, 빨간 텍스트 + 경고 아이콘)

워커 행에는 추가 안 함 (워커는 영속 폴더가 시스템 보장이라 사용자가 삭제할 수 없음).

시각 일관성: 펜 아이콘과 동일한 12×12 SVG 스타일, 항상 표시 (iPad 터치 친화).

## 7. 동시성 / 경합

### 7.1 enumerate 중 폴더 삭제

`readdir` 응답 후 각 폴더의 tabterm.json read 시점에 폴더가 사라질 수 있음 → ENOENT 캐치하고 그 폴더만 결과에서 제외.

### 7.2 동시 라벨 편집

같은 폴더의 tabterm.json 을 두 사용자/탭에서 동시 PUT 시도 → atomic rename 으로 last-writer-wins. 워커 라벨과 동일한 시맨틱, 추가 lock 도입 안 함.

### 7.3 PTY spawn 중 Delete

alive PTY kill → fs.rm 사이에 race 가능. fs.rm 은 `force: true` 라 부분 실패 시에도 진행. 부분 잔존 시 다음 enumerate 에서 그 폴더 다시 보이고 사용자가 재시도 가능. critical 데이터 보호는 사용자 책임 (Non-goals).

## 8. 추천 default (사용자 review 시 변경 가능)

| 항목 | 추천 | 이유 |
|------|------|------|
| 사이드바 정렬 | lastUsedAt DESC | 최근 쓴 거 위, 일반적 패턴 |
| Kill confirm | 단일 dialog | 워커 force-confirm 일관 |
| Delete confirm | 2단계 (1차 alert + 2차 typing) | destructive, 복구 불가 |
| dead 폴더 클릭 | 즉시 새 PTY | 워커 일관, streamline |
| Legacy 폴더 | 폴더명을 라벨로 표시, lazy migration | backward compat |
| tabterm.json 작성 시점 | + New session 직후 + 첫 attach 시 | 가시성 |
| schemaVersion 미지원 | read-only 모드 | 안전 + forward compat |

위 7개 항목 중 바꿀 게 있으면 사용자 review 단계에서 지적 → spec 갱신.

## 9. 보안 / 안전

- DELETE 경로 검증: name 에 path separator 거부, resolve 후 WORKERS_ROOT 하위 1단계만 허용, WORKER_PREFIX 보호
- POST cwd 검증: 동일 규칙 + 폴더 실존 + NEW_SESSION_PREFIX 시작 필수
- tabterm.json schema 검증: version 정수 / label 길이 / timestamp 숫자. 깨진 파일은 inferred 기본값으로 fallback + audit log
- audit log 이벤트: `session.folder.create`, `session.folder.attach`, `session.folder.label.set`, `session.folder.delete`

## 10. 단계적 구현 순서 (writing-plans 에서 상세화)

1. **Backend 데이터 계층**: tabterm.json read/write helper, validate, atomic write
2. **Backend API**: GET folders, POST cwd 분기, PUT label, DELETE
3. **Backend 안전**: path 검증, 워커 폴더 보호, audit
4. **Frontend state**: state.folders, fetch 흐름, alive PTY join
5. **Frontend 렌더**: 사이드바 행 source 교체, 정렬, 상태 glyph
6. **Frontend 액션**: 펜 아이콘 (라벨 분기), 케밥 메뉴 (Kill/Delete), 2단계 confirm
7. **Backward compat**: legacy 폴더 inferred 메타, lazy migration 검증
8. **검증**: 수동 시나리오 (신규/재시작/legacy/delete/race)
9. **CHANGELOG + 캐시 bump** (sw.js VERSION)

## 11. 직전 worker2 작업과의 관계

- worker2 (13:55) 텔레그램 페어링 force-confirm 구현 도중 중단 ([20260521-135500 보고서](../../../../Users/Administrator/session-reports/20260521-135500-worker2-tabterm-fix-impl-partial-and-dup-question.md))
- 중복 워커 PID 진단/정리 작업 대기
- 본 spec 은 두 작업과 별개 스코프, 코드 충돌 없음 (server/index.js 의 일반 세션 분기만 건드림, force-confirm 은 워커 분기)
- **우선순위 결정 요청 중**: 1) worker2 force-confirm 마무리 / 2) 중복 PID 진단 / 3) 본 spec implementation — 어느 순서로 갈지

## 12. Open questions

없음 (Q1, Q2 brainstorming 으로 모두 확정). §8 추천안 중 변경 희망 있으면 사용자 review 단계에서 지적.
