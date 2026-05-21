# tabterm worker/session rename — design spec (v2)

- Date: 2026-05-20
- Status: draft v2 (Codex cross-review 반영 후, 사용자 최종 검토 대기)
- Scope: tabterm v0.5.x — sidebar 라벨 인라인 편집 + 영속 저장

> v1 → v2 변경: Codex peer review 의 RED 5건 + 주요 YELLOW 모두 반영. 자동 단위 테스트 도입은 별 PR 로 defer.

## 1. Goal

사이드바에 표시되는 워커(`worker-0..N`)와 동적 세션(◆ session-…) 행의 이름을 사용자가 인라인으로 편집할 수 있게 하고, 워커 라벨은 디스크에 영속 저장한다.

## 2. Non-goals

- 라벨 검색/필터 UI
- 라벨 변경 이력(undo/redo)
- 세션 라벨의 영속화(사용자가 ephemeral 선택)
- 워커 슬롯 개수/순서 변경
- 인증/권한 모델 변경
- 라벨용 자동 테스트 스위트 신설 (현재 repo 에 test 인프라 부재 — 별 PR 에서 도입)

## 3. UX

### 3.1 표시 규칙
- `ws-name` (메인 텍스트): 커스텀 라벨이 있으면 커스텀 라벨, 없으면 기본명(`worker-0` 또는 `session-…`).
- `ws-meta` (보조 텍스트) 조립 순서 고정:
  - `glyph_meta` (기존: `idle` / `in slot L` / `exit 0` / `worker dir missing` 등)
  - 커스텀 라벨이 있을 때만 ` · ${defaultName}` (예: `in slot L · worker-0`)
  - 라벨이 없는 경우 추가 텍스트 없음.
- `ws-path` 영역은 변경 없음.

### 3.2 연필 아이콘
- 위치: 행 우측, 슬롯 태그(L/R) 가 있으면 그 좌측에 8px 간격으로 배치. 둘 다 없을 때는 우측 끝.
- 노출: **항상 표시** (iPad 터치 친화). active 상태에서도 명도 유지.
- 크기: 12×12px viewBox SVG, 기존 사이드바 아이콘 스타일과 일치.
- 클릭 핸들러 외 hover 변화 최소.

### 3.3 편집 인터랙션
1. 연필 클릭 → 행의 `ws-name` 영역을 `<input type="text" maxlength="32">` 로 swap, 현재 라벨(없으면 기본명) prefill, 텍스트 전체 선택 + 포커스.
2. 행 클릭과 연필 클릭은 `stopPropagation` 분리. input wrapper 자체에도 `pointerdown` + `click` 둘 다 stopPropagation.
3. 저장: Enter 또는 input blur.
4. 취소: Esc → 변경 폐기, 원래 상태 복원. Esc 직후 blur 는 `editing.cancelled = true` 플래그로 가드(중복 저장 방지).
5. 빈 문자열(공백만) 저장 → 라벨 해제(기본명으로 복귀).
6. API 호출 중 input `disabled` + opacity 0.6. 실패 시 toast + **사용자 입력값 유지** 한 채 편집 모드 복귀.
7. **클라이언트 길이 가드**: input `maxlength=32` + 우측 카운터(`12/32`). silent truncate 없음.
8. **편집 중 외부 렌더 보호**: `state.editing` 인 동안 해당 row 는 `renderSidebar()` 재호출돼도 input destroy 안 함(in-place 보존 또는 detach/reattach).
9. **iOS IME 충돌 방어**: `state.editing` 인 동안 `focusActivePane` 의 `ios-ime` 분기에서 `ime-input` 으로 redirect 안 함 (rename input 이 sidebar 안이라도 명시적 조건 추가).
10. 성공 시 사이드바 + 슬롯 스트립 + 윈도우 타이틀 즉시 갱신.

## 4. 데이터 모델

### 4.1 워커 라벨 파일
- 경로: `<ROOT>/data/labels.json` (절대 경로)
- 백업: `data/labels.json.bak` (이전 정상 상태 1개)
- 부팅 시 한 번 로드, 메모리 캐시 유지.
- 스키마:
  ```json
  {
    "version": 1,
    "workers": {
      "0": "pixiechess",
      "3": "upbit-bot"
    }
  }
  ```
- 저장소 객체 `Object.create(null)` → prototype pollution 차단.
- Sparse: 라벨 없는 워커 인덱스는 키 없음. PUT 빈 문자열 → 키 삭제.
- 키 화이트리스트: `0..(WORKERS_COUNT-1)` 십진 문자열만. 그 외 load 시 silent drop.

### 4.2 손상 복구 정책
부팅 시 load 흐름:
1. `labels.json` 읽기 시도. 파싱 OK + schema OK → 사용.
2. 실패 시 `labels.json.bak` 시도. OK → 메모리 캐시는 `.bak` 으로 채우고 `labels.json` 으로 재저장(복구). warn log.
3. `.bak` 도 실패 → `data/labels.json.corrupted-<ts>` 로 손상 파일 보존(rename) 후 빈 객체로 시작. error log. 정상 동작 유지(저장 가능).

→ 단순 corruption 이 모든 라벨을 자동으로 지우지 않는다.

### 4.3 세션 라벨
- 기존 `PtySession.label` 필드 in-memory mutate. PTY 종료 → label 도 소멸.

## 5. Backend

### 5.1 신규 모듈 `server/labels.js`
```
loadLabels()                       // 4.2 복구 정책
saveLabelsAtomic()                 // 5.2 절차
getWorkers()                       // 방어적 deep copy
getWorkerLabel(idx)                // string | null
setWorkerLabel(idx, name)          // name '' 이면 delete. 디스크 저장 후 캐시 갱신. throws on disk failure.
```

내부 직렬화:
- **단일 write queue (mutex)**: `let writing = Promise.resolve(); writing = writing.then(() => doSave())`.
- tmpfile: `labels.json.tmp-<pid>-<ts>-<rand>` 같은 디렉토리.
- 절차: ① tmpfile 쓰기 ② 기존 `labels.json` → `labels.json.bak` (있으면) ③ tmpfile → `labels.json` rename.
- Windows 같은 볼륨이면 rename 은 원자적. 실패 시 `unlink(tmp)` 후 재시도 1회, 두 번째 실패는 throw.
- 캐시 갱신: **저장 성공 후에만** in-memory update. 실패 시 rollback (변경 미적용).

### 5.2 `server/sessions.js`
- 신규 메서드:
  ```
  setLabel(id, name) -> summary | null
  ```
  - id 가 `#map` 에 없거나 `alive === false` → `null` 반환 (라우트 404).
  - alive → `s.label = name; return s.summary();`
  - 검증은 라우트에서 완료된 값 전제.

### 5.3 라벨 검증 (서버 단일 진실)
헬퍼 `validateLabel(input): { ok, value?, error? }`:

1. `typeof input === 'string'` 아니면 `error: 'type'`.
2. `value = input.trim()`.
3. `value === ''` → `ok, value: ''` (= 라벨 해제).
4. `value.length > 32` (UTF-16 code unit 기준) → `error: 'too_long'`.
5. control char 포함 → `error: 'control_char'`. 구현 정규식: `/[\x00-\x1f\x7f]/.test(value)`.
6. 통과 → `ok, value`.

### 5.4 API 라우트 (`server/index.js`)
| Method | Path | Auth | CSRF | Body | Body limit | Response |
|---|---|---|---|---|---|---|
| GET | `/api/labels` | yes | **no** | – | – | `{ version: 1, workers }` |
| PUT | `/api/labels/worker/:idx` | yes | yes | `{ name: string }` | 1 KB | 200 / 422 / 500 |
| PUT | `/api/sessions/:id/label` | yes | yes | `{ name: string }` | 1 KB | 200 / 404 / 422 |

> 세션 라벨도 일관성 위해 **PUT** (전체 대체) 으로 통일. PATCH 안 씀.

`:idx` 파싱 (정수 화이트리스트):
```
const raw = req.params.idx;
if (!/^(0|[1-9]\d*)$/.test(raw)) return 400 { error: 'bad_idx' };
const idx = Number(raw);
if (!Number.isSafeInteger(idx) || idx < 0 || idx >= WORKERS_COUNT) return 400 { error: 'bad_idx' };
```

응답 (canonical):
- PUT worker 저장:
  ```json
  { "ok": true, "workerIndex": 3, "label": "upbit-bot", "workers": { ... } }
  ```
- PUT worker 해제 (빈 문자열):
  ```json
  { "ok": true, "workerIndex": 3, "label": null, "workers": { ... } }
  ```
- PUT session:
  ```json
  { "ok": true, "id": "...", "label": "...", "session": summary }
  ```
- 422 validation:
  ```json
  { "error": "validation", "field": "name", "reason": "too_long" }
  ```
- 500 디스크 실패:
  ```json
  { "error": "labels_persist_failed" }
  ```
  서버 캐시는 변경 안 됨 → 클라이언트는 toast + 편집 상태 복귀.

**Idempotency**: 현재 라벨 == 신규 라벨 → 디스크 write/audit 모두 skip 후 200 + canonical 반환.

`/api/preflight` 추가 키:
- `workerLabels`: `{ "0": "pixiechess", ... }` (deep copy)
- `labelsHealth`: `'ok' | 'restored_from_bak' | 'corrupted_reset'`

### 5.5 감사 로그
`audit.log` 는 `JSON.stringify` 직렬화 → control char 자동 escape (injection 위험 없음). 단, **라벨 본문은 기록하지 않는다** (length 만).

이벤트:
- `label.set.worker`: `{ workerIndex, length, cleared: bool, ip }`
- `label.set.session`: `{ id, length, cleared: bool, ip }`
- `labels.load.recovered`: `{ from: 'bak' | 'reset' }` (부팅 시 4.2 비-ok)
- `labels.persist.failed`: `{ workerIndex, errno }` (선택)

## 6. Frontend

### 6.1 state 확장
```js
state.workerLabels = { 0: "pixiechess", ... }   // preflight 응답에서 초기화
state.editing = null                            // { kind, key, originalValue, currentInput, cancelled }
```

### 6.2 렌더링 변경
- `renderWorkerRow(i, p)`:
  - `name = state.workerLabels[i] || (workerPrefix + i)`
  - meta = 기존 meta + (커스텀 라벨일 때 ` · ${workerPrefix}${i}`)
  - 연필 아이콘 (data-act=rename, data-kind=worker, data-key=i)
- `renderRow(p, kindLabel)`:
  - `name = p.label`
  - 연필 아이콘 (data-act=rename, data-kind=session, data-key=p.id)
- 공통: `state.editing` 의 row 와 매칭되면 input 보존.

### 6.3 인라인 편집 모듈
- `startRename(rowEl, kind, key, currentValue, defaultName)`:
  - input 생성, maxlength=32, value prefill, select all, focus.
  - 카운터 element (`x/32`), 입력마다 갱신.
  - input wrapper 에 `pointerdown` + `click` stopPropagation.
  - keydown: Enter → commit, Esc → cancel.
  - blur → `state.editing.cancelled` 면 무시, 아니면 commit.
  - `state.editing = { kind, key, originalValue, currentInput: el, cancelled: false }`.
- `commitRename`:
  - input disabled, opacity 0.6.
  - 클라 추가 검증 (typeof string, length ≤ 32). 위반 시 toast + 편집 모드 유지.
  - PUT 호출.
  - 성공 → state 갱신 + `state.editing = null` + `renderSidebar` + `renderSlotStrip` + 타이틀 갱신.
  - 실패 → toast(에러), input 재활성화, 값 유지, 편집 모드 유지.
- `cancelRename`:
  - `state.editing.cancelled = true`.
  - input remove, ws-name 원복.
  - `state.editing = null`.

### 6.4 슬롯 스트립 / 윈도우 타이틀
- `displayName(p)`:
  - p.kind === 'worker' → `state.workerLabels[p.workerIndex] || p.label`
  - p.kind === 'session' → `p.label`
- `renderSlotStrip`, `buildLayout` 의 타이틀 모두 `displayName` 사용.
- 세션 PUT 성공 응답으로 `state.panes` 의 pane.label 도 업데이트.

### 6.5 CSS 추가
- `.ws-rename-btn` (연필 아이콘): absolute, right 32px (slot tag 있을 때) 또는 10px (없을 때).
- `.ws-rename-input`: inline swap, font 일치, 우측 카운터 공간 확보.
- `.ws-rename-counter`: 11px, muted.

## 7. 보안 / 동시성

- CSRF: 모든 mutating 라우트 (PUT). GET 은 cookie auth 만.
- Body limit: 라벨 라우트 fastify route option `bodyLimit: 1024`.
- 입력 검증 단일 진실: 서버 `validateLabel`. 클라는 UX 가드.
- Prototype pollution: 저장소 `Object.create(null)`, 키 화이트리스트.
- Path traversal: idx 는 정수만, 파일 경로에 직접 안 씀.
- 동시 저장: 모듈 내부 write queue 직렬화.
- 다중 탭 편집: last-write-wins. canonical `workers` 가 PUT 성공 응답에 포함 → 클라가 자기 cache 도 그걸로 덮어씀.
- 디스크 쓰기 실패: 500 + 캐시 unchanged. 클라이언트 실패 toast + 편집 모드 유지.

## 8. 수동 회귀 체크리스트

자동 테스트는 별 PR (Non-goals). 이 PR 머지 전 수동 회귀:

워커 라벨
- [ ] 빈 워커 행 → 연필 → 이름 → Enter → ws-name 갱신, ws-meta 에 ` · worker-0`
- [ ] 라벨 있는 워커 → 빈 문자열 저장 → 라벨 해제
- [ ] 32자 입력 시 카운터 32/32, 33번째 키 차단
- [ ] 새 탭, 리로드, 서버 재시작 후 라벨 유지
- [ ] `data/labels.json` 강제 손상 → 재시작 → `.bak` 복구, `labelsHealth: restored_from_bak`
- [ ] 둘 다 손상 → 재시작 → 빈 상태 + corrupted 파일 보존, `labelsHealth: corrupted_reset`

세션 라벨
- [ ] 세션 생성 → 연필 → 이름 변경 → 슬롯 칩/타이틀 즉시 반영
- [ ] 세션 종료(✕) → 라벨 소멸
- [ ] 세션 종료 후 PUT → 404

보안
- [ ] CSRF 없이 PUT → 403
- [ ] 미로그인 PUT → 401
- [ ] control char 포함 → 422 `control_char`
- [ ] 1.1 KB body → 413
- [ ] idx=`-1`, `1e9`, `1abc`, `__proto__` → 400 `bad_idx`
- [ ] `name: 123` (number) → 422 `type`

UX
- [ ] Esc → 변경 폐기, blur 추가 저장 안 함
- [ ] 편집 중 PTY exit / 외부 renderSidebar 호출 → input 보존, 입력값 유지
- [ ] 디스크 쓰기 실패 시 (수동 권한 변경) → toast + 편집 모드 유지
- [ ] 같은 라벨로 저장 (no-op) → 200 + audit 미기록

iPad PWA
- [ ] 연필 항상 보임
- [ ] rename input 에 한글 직접 입력 가능 (`ime-input` redirect 비활성)
- [ ] 편집 끝나면 ios-ime 정상 복귀

## 9. 마이그레이션

- `data/labels.json` 없는 환경: 첫 PUT 시 생성. 영향 없음.
- README 환경변수 변경 없음.

## 10. 작업 분해 (구현 단계 미리보기)

1. **backend**
   - `server/labels.js` 신규 (load/save/validate/queue)
   - `sessions.js` `setLabel` 추가
   - `index.js` 라우트 3개 + preflight 확장 + body limit + audit
2. **frontend**
   - state.workerLabels + state.editing
   - `displayName` 헬퍼, renderWorkerRow/renderRow 변경, 연필 아이콘
   - startRename/commitRename/cancelRename + Esc/blur 가드 + maxlength/counter + iOS IME 가드
   - CSS `.ws-rename-btn`, `.ws-rename-input`, `.ws-rename-counter`
3. **수동 회귀** §8 + CHANGELOG 추가

## 11. 의도적으로 거부한 제안 (Codex 리뷰 중)

- **Multi-tab updatedAt/version 충돌 감지**: last-write-wins 로 충분. tabterm 사용자는 보통 1인 다기기 PWA → 동시 충돌 가능성 낮음. canonical 응답으로 매번 sync 되는 것으로 갈음.
- **단위 테스트 신설**: 현재 repo 에 test 인프라 부재. 별 PR 에서 도입.
